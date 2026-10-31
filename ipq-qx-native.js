/**
 * 节点 IP 质量检测 · Quantumult X 原生版 v2
 *
 * 关键改动：报告不再塞进 QX 弹窗（太长会顶到屏幕外、关不掉），改为「短摘要弹窗 + 全文页」。
 *  - 弹窗只留：IP / 国家 / ASN / 风险分 / 媒体 3 条 / 状态行（≤ 12 行）
 *  - 弹窗里的「查看完整报告」链接打开由本脚本渲染的 HTML 页（Safari）
 *
 * 事件：
 *  - event-interaction <脚本>             : 节点页启动检测，出摘要弹窗
 *  - http-request <脚本>/report?d=<密文>  : 全文报告页（自行解码渲染，不依赖外部页面）
 */
const QX_BUILD = "2026-11-02.qx5-native";
const reqUrl = String(($request && $request.url) || "");
const SRC_URL = "https://gcore.jsdelivr.net/gh/MaYIHEI/paperclip@main/loon/ipquality/ipquality.js";
const HARD_BUDGET_MS = 45000;

/* ============ 请求精简配置（改这里，或由 QX 参数覆盖） ============
 * 默认 MEDIA=off、MASK=off，只保留能出结论的源：
 *   - 出口 IP / 基础归属：ippure + ipapi.is + ip-api.com + ipify/ipinfo trace
 *   - 风险：ippure 分数 + ipapi.is 机房/VPN 标记
 *   - 被精简掉的：maxmind(2次) / ipinfo widget / ipwho.is / scamalytics / abuseipdb
 *                 / ip2location(2次) / ipdata / ipqs / proxycheck / dbip / ipregistry
 *                 / 全部媒体与 AI 站点（每个站点 2~4 次请求）
 *
 * 想加回某个源：让它出现在 ALLOW 里，或用 BLOCK="-" 全开。
 * 想自定义：在 QX 里把脚本地址改成
 *   <脚本>?media=on&block=scamalytics,abuseipdb
 * =============================================================== */
const ALLOW = "my.ippure.com,api.ipapi.is,ip-api.com/json/,api4.ipify.org,v4.ident.me,ipinfo.io/widget,ipwho.is,ipinfo.check.place/";
const BLOCK = "-";          // "-" = 不额外屏蔽（ALLOW 已限定）
const MEDIA = "off";        // on/off：流媒体与 AI 检测（最耗请求的部分）
const MASK = "off";         // on/off：报告里打码 IP

// 兼容 QX 参数覆盖：脚本 URL 上的 query
const cfgMedia = (queryValue(reqUrl, "media") || MEDIA).toLowerCase();
const cfgMask = (queryValue(reqUrl, "mask") || MASK).toLowerCase();
const SOURCE_ONLY = queryValue(reqUrl, "only") || ALLOW;
const SOURCE_BLOCK = queryValue(reqUrl, "block") || BLOCK;
const SUMMARY_MAX_LINES = 12;
const REPORT_KEY = "ipq.qx.report";

const nodeParam = queryValue(reqUrl, "node");
const dParam = queryValue(reqUrl, "d");

if (/\/report(\?|$)/.test(reqUrl)) {
    serveReport();
} else {
    startDetection();
}

function startDetection() {
    let nodeName = "";
    try {
        if (typeof $environment !== "undefined" && $environment) {
            nodeName = String($environment.params || $environment.node || "");
        }
    } catch (e) {}
    nodeName = (nodeName || nodeParam || "").trim();
    if (!nodeName) {
        $done({ title: "节点 IP 质量检测", message: "未获取到节点名。请在 QX 节点/策略组页长按该节点运行本脚本。", icon: "network.slash" });
        return;
    }
    run(nodeName);
}

function run(nodeName) {
    const startedAt = Date.now();
    let settled = false;
    const finish = (result) => {
        if (settled) return;
        settled = true;
        $done(result);
    };
    const timer = setTimeout(() => finish({
        title: "节点 IP 质量检测",
        message: "超过 " + Math.round(HARD_BUDGET_MS / 1000) + " 秒未完成，稍后重试（可关媒体检测提速）。",
        icon: "clock.badge.exclamationmark",
    }), HARD_BUDGET_MS);

    $task.fetch({ url: SRC_URL, timeout: 15000 }).then((r) => {
        if (!r || r.statusCode !== 200 || !r.body || r.body.length < 5000) {
            clearTimeout(timer);
            finish({ title: "节点 IP 质量检测", message: "检测脚本载入失败：HTTP " + (r && r.statusCode), icon: "exclamationmark.triangle" });
            return;
        }
        try {
            const execute = new Function("$done", "$persistentStore", "$environment", "$httpClient", "$notify", "$prefs", "$task", "console",
                r.body + "\n//# sourceURL=ipquality-r8-qx-native.js");
            execute((result) => {
                clearTimeout(timer);
                finish(buildSummary(result, nodeName, startedAt));
            }, storeFacade(), { params: { node: nodeName } }, proxyHttpClient(), mapNotify(), prefsFacade(), $task, { log() {} });
        } catch (e) {
            clearTimeout(timer);
            finish({ title: "节点 IP 质量检测", message: "执行失败：" + String((e && e.message) || e), icon: "exclamationmark.triangle" });
        }
    }, (e) => {
        clearTimeout(timer);
        finish({ title: "节点 IP 质量检测", message: "拉取检测脚本失败：" + String((e && e.message) || e), icon: "exclamationmark.triangle" });
    });
}

/* ---------------- 摘要弹窗 ---------------- */
function buildSummary(result, nodeName, startedAt) {
    const cost = ((Date.now() - startedAt) / 1000).toFixed(1) + "s";
    const html = result && result.htmlMessage ? String(result.htmlMessage) : "";
    const text = html ? htmlToText(html) : String((result && (result.content || result.message)) || "无报告");
    if (!html) {
        return { title: "节点 IP 质量检测", message: truncateLines(text, SUMMARY_MAX_LINES), icon: "exclamationmark.triangle" };
    }

    const lines = [];
    const push = (s) => { if (s && String(s).trim()) lines.push(String(s).trim()); };

    // 头部：IP / 归属 / ASN
    const ipMatch = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    const asnMatch = text.match(/AS\d+\s*·\s*[^\n]+/);
    let countryLine = (text.split("\n").find((l) => /\[[A-Z]{2}\]/.test(l)) || "").trim();
    if (!countryLine) countryLine = (text.split("\n").find((l) => /^(Hong Kong|Taiwan|Japan|United States|Singapore|Korea)/.test(l)) || "").trim();
    push("节点 · " + nodeName);
    if (ipMatch) push(ipMatch[0]);
    if (countryLine) push(countryLine);
    if (asnMatch) push(asnMatch[0]);

    // 风险评分（第一条带分数）
    const riskLine = (text.split("\n").find((l) => /●.*\d+\s*·/.test(l)) || "").trim();
    if (riskLine) push("风险 " + riskLine.replace(/^●\s*/, "").replace(/\s+/g, " "));

    // 媒体：只取判定过的
    const media = [];
    text.split("\n").forEach((l) => {
        const m = l.match(/^([✅⚪⛔])\s*([^\s]+)\s*(解锁|未确认|不可用|部分可用)/);
        if (m && m[1] !== "⚪") media.push(m[2] + m[3]);
    });
    if (media.length) push("媒体 " + media.slice(0, 3).join(" · "));

    push("耗时 " + cost);

    // 写全文快照，供 report 页读取（$prefs 全局共享）
    const snapshot = { node: nodeName, html: html, at: Date.now(), build: QX_BUILD };
    const key = reportKey(nodeName);
    try { $prefs.setValueForKey(JSON.stringify(snapshot), key); } catch (e) {}
    const openUrl = reportBase() + "/report?node=" + encodeURIComponent(nodeName) + "&d=" + encodeURIComponent(shortKey(nodeName));

    const message = lines.join("\n")
        + "\n\n完整报告（地理/风险因素/媒体全项）：\n" + openUrl;

    return {
        title: "节点 IP 质量检测 · " + truncateText(nodeName, 16),
        message: message,
        icon: (result && result.icon) || "shield.lefthalf.filled",
    };
}

/* ---------------- 全文报告页 ---------------- */
function serveReport() {
    let key = dParam ? "ipq.qx.report." + dParam : reportKey(nodeParam);
    let raw = null;
    try { raw = $prefs.valueForKey(key); } catch (e) {}
    let snap = null;
    try { snap = raw ? JSON.parse(raw) : null; } catch (e) {}
    if (!snap && raw) snap = { node: nodeParam || "", html: String(raw), at: Date.now() };
    const html = snap && snap.html
        ? renderPage(snap.html, snap.node, snap.at)
        : "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font:15px -apple-system;padding:24px'>还没有报告缓存，请回 QX 节点页重新运行「节点 IP 质量检测」。</body>";
    $done({
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        body: html,
    });
}

function renderPage(reportHtml, node, at) {
    const when = at ? new Date(at).toLocaleString("zh-CN") : "";
    return "<!doctype html><html lang=zh-CN><head><meta charset=utf-8>"
        + "<meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover'>"
        + "<meta name=color-scheme content='light dark'><title>节点 IP 质量检测</title>"
        + "<style>:root{color-scheme:light dark}body{margin:0;padding:max(18px,env(safe-area-inset-top)) 14px max(40px,env(safe-area-inset-bottom));"
        + "font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f7;color:#1c1c1e}"
        + ".card{max-width:760px;margin:0 auto;background:#fff;border-radius:18px;padding:16px 16px 20px;box-shadow:0 4px 20px rgba(0,0,0,.05)}"
        + ".meta{color:#8e8e93;font-size:11px;margin-bottom:10px}"
        + "a{color:#0a84ff}"
        + "@media(prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}.card{background:#1c1c1e;box-shadow:none}.meta{color:#a1a1a6}}</style>"
        + "</head><body><div class=card>"
        + "<div class=meta>" + escapeHtml(node || "") + (when ? " · " + escapeHtml(when) : "") + " · " + QX_BUILD + "</div>"
        + reportHtml.replace(/Loon 不提供节点 TCP\/DNS API/g, "QX 不提供节点 TCP/DNS API")
        + "</div></body></html>";
}

/* ---------------- 注入给原版脚本的兼容层 ---------------- */
function storeFacade() {
    return {
        read(key) {
            // 原版用 $persistentStore 读 MaskIP / MediaTest / MapNotification
            const k = String(key || "");
            if (k === "MediaTest") return cfgMedia === "on" ? "true" : "false";
            if (k === "MaskIP") {
                const v = cfgMask === "on" ? "true" : "false";
                try { $prefs.setValueForKey(v, k); } catch (e) {}
                return v;
            }
            try { return $prefs.valueForKey(k); } catch (e) { return null; }
        },
        write(value, key) { try { $prefs.setValueForKey(String(value), key); return true; } catch (e) { return false; } },
        remove(key) { try { $prefs.removeValueForKey(key); return true; } catch (e) { return false; } },
    };
}

function prefsFacade() {
    return {
        valueForKey(key) { return storeFacade().read(key); },
        setValueForKey(value, key) { return storeFacade().write(value, key); },
        removeValueForKey(key) { return storeFacade().remove(key); },
    };
}

function proxyHttpClient() {
    function mk(method) {
        return function (opts, cb) {
            if (typeof opts === "string") opts = { url: opts };
            // —— 请求数精简：命中被禁用源就直接回错误，原版会走它的降级分支 ——
            if (!sourceAllowed(String(opts.url || ""))) {
                setTimeout(() => cb("SKIP: 该数据源已被精简配置禁用", null, null), 0);
                return;
            }
            const o = {};
            for (const k in opts) o[k] = opts[k];
            o.method = method;
            const h = {};
            for (const k in (opts.headers || {})) h[k] = opts.headers[k];
            if (!h["Accept-Language"]) h["Accept-Language"] = "zh-CN,zh;q=0.9";
            o.headers = h;
            $task.fetch(o).then(
                (r) => cb(null, { status: r.statusCode, statusCode: r.statusCode, headers: r.headers || {} }, r.body),
                (e) => cb(String((e && e.message) || e), null, null)
            );
        };
    }
    return { get: mk("GET"), post: mk("POST") };
}

/* 数据源白/黑名单：url 里的域名或路径关键字 */
function sourceAllowed(url) {
    const block = String(SOURCE_BLOCK || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allow = String(SOURCE_ONLY || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const u = url.toLowerCase();
    const host = (u.match(/^https?:\/\/([^\/]+)/) || [])[1] || "";
    const hit = (list) => list.some((k) => u.indexOf(k) >= 0);
    if (allow.length) return hit(allow);
    if (block.length && hit(block)) return false;
    return true;
}

function mapNotify() {
    return function (title, subtitle, body, options) {
        if (typeof $notify === "function") $notify(title, subtitle, body, options || {});
    };
}

/* ---------------- 工具 ---------------- */
function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(div|p|tr|li|h[1-6]|section|details|summary)>/gi, "\n");
    s = s.replace(/<\/t[dh]>/gi, "  ");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    s = s.replace(/[ \t]+/g, " ");
    s = s.replace(/\n[ \t]+/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

function truncateLines(text, maxLines) {
    const lines = String(text).split("\n").filter((l) => l.trim() !== "");
    if (lines.length <= maxLines) return lines.join("\n");
    return lines.slice(0, maxLines).join("\n") + "\n…（已省略，见完整报告）";
}

function reportKey(node) {
    return "ipq.qx.report." + shortKey(node);
}

function shortKey(node) {
    const s = String(node || "");
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 1000000007;
    return h.toString(36);
}

// 全文页地址：优先 URL 里带的 {script}（QX 配置里写 %7Bscript%7D），否则用本脚本的公开地址
function reportBase() {
    if (/{script}/.test(reqUrl)) return reqUrl.split("?")[0];
    return "https://cdn.jsdelivr.net/gh/fengao82218/ipquality-qx@main/ipq-qx-native.js";
}

// QX 交互脚本拿不到自身 URL 时，用配置里的公开地址兜底
function baseScriptUrl() {
    const fromReq = reqUrl.replace(/\/report(\?.*)?$/, "");
    if (/^https?:\/\//.test(fromReq) && !/^https?:\/\/[^/]*\/?$/.test(fromReq)) return fromReq;
    return "https://cdn.jsdelivr.net/gh/fengao82218/ipquality-qx@main/ipq-qx-native.js";
}

function queryValue(link, key) {
    const m = String(link || "").match(new RegExp("[?&]" + key + "=([^&#]*)"));
    if (!m) return "";
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
}

function truncateText(v, n) {
    const t = String(v || "");
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function escapeHtml(v) {
    return String(v === null || typeof v === "undefined" ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
