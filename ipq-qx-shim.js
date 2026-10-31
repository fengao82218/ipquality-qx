/**
 * 节点 IP 质量检测 · Quantumult X 全功能版（单脚本）
 *
 * 运行模型（QX 一次 http-request 脚本只能返回一次响应，所以合并在一次调用里跑完）：
 *   1. QX 节点页 event-interaction → 通知里带报告页链接（含 node/run）
 *   2. Safari 打开报告页 → 页面 fetch 一次 api/all → 本脚本在本次调用内并发跑
 *      选中的模块 → 返回 JSON（每个模块一段 HTML）
 *
 * 真实检测逻辑：MaYIHEI/paperclip loon/ipquality/ipquality.js (r8)，
 * 通过 new Function 注入 $done / $persistentStore / $environment / $httpClient / $prefs，
 * 不改原版代码，上游更新自动跟随。
 */
const QX_BUILD = "2026-11-02.qx2";
const SRC_URL = "https://gcore.jsdelivr.net/gh/MaYIHEI/paperclip@main/loon/ipquality/ipquality.js";
const VIEWER_URL = "https://files.catbox.moe/8n346o.html";
const SESSION_KEY = "paperclip.ipquality.web.session";
const SESSION_TTL_MS = 30 * 60 * 1000;
const SOFT_BUDGET_MS = 45000;

const MODULES = {
    basic: { title: "基础信息", enabled: ["显示基础信息"] },
    types: { title: "IP 类型属性", enabled: ["显示 IP 类型"] },
    scores: { title: "风险评分", enabled: ["显示风险评分"] },
    factors: { title: "风险因素", enabled: ["显示风险因素"] },
    egress: { title: "出口分流", enabled: ["显示出口分流"] },
    bgp: { title: "BGP 信息", enabled: ["显示 BGP 信息"] },
    bgppath: { title: "BGP 路径", enabled: ["显示目标前缀 BGP 路径"] },
    inbound: { title: "外部探针入站路径", enabled: ["测试外部探针入站路径"] },
    ping: { title: "三网探针延迟", enabled: ["测试外部探针 Ping"] },
    mtr: { title: "外部探针 MTR", enabled: ["测试外部探针 MTR"] },
    stability: { title: "HTTPS 稳定性", enabled: ["测试 HTTPS 稳定性"] },
    media: { title: "流媒体与 AI", enabled: ["执行媒体与 AI 检测", "显示媒体与 AI 结果"] },
    regions: { title: "地区一致性", enabled: ["执行媒体与 AI 检测", "显示地区一致性"] },
    status: { title: "数据状态", enabled: ["显示数据状态"] },
};
const DEFAULT_PLAN = ["basic", "types", "scores", "media"];

const reqUrl = String(($request && $request.url) || "");
const runParam = queryValue(reqUrl, "run");
const mask = queryValue(reqUrl, "mask") === "1";
const planParam = queryValue(reqUrl, "mods");
const nodeParam = queryValue(reqUrl, "node");

if (/\/api\//.test(reqUrl) || /api\.all/.test(reqUrl)) {
    serveApi();
} else if (/\/viewer\.html/.test(reqUrl)) {
    serveViewer();
} else {
    startSession();
}

/* ==================== 1. 节点页交互 ==================== */
function startSession() {
    let node = "";
    try {
        if (typeof $environment !== "undefined" && $environment) {
            node = String($environment.params || $environment.node || "");
        }
    } catch (e) {}
    node = String(node || "").trim();
    if (!node) node = nodeParam;

    if (!node) {
        $done({ title: "节点 IP 质量检测", message: "未获取到目标节点。请在 QX 节点/策略组页长按该节点运行「节点 IP 自检」。", icon: "network.slash" });
        return;
    }
    const session = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10),
        node: node,
        createdAt: Date.now(),
        version: QX_BUILD,
    };
    try { $prefs.setValueForKey(JSON.stringify(session), SESSION_KEY); } catch (e) {}
    const openUrl = VIEWER_URL + "?run=" + encodeURIComponent(session.id) + "&node=" + encodeURIComponent(node);
    if (typeof $notify === "function") {
        $notify("节点 IP 自选检测", truncate(node, 40), "点按用 Safari 打开报告页 → 勾选项目 → 开始检测", { openUrl: openUrl });
    }
    $done({
        title: "检测页面已准备",
        message: "已发通知：点按「节点 IP 自选检测」通知，用 Safari 打开报告页勾选项目。\n\n报告页地址：\n" + openUrl,
        icon: "safari",
    });
}

/* ==================== 2. 报告页静态文件 ==================== */
function serveViewer() {
    $task.fetch({ url: VIEWER_URL, timeout: 15000 }).then((r) => {
        const ok = r && r.statusCode === 200 && r.body;
        $done({
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
            body: ok ? r.body : "<!doctype html><meta charset=utf-8><h3>报告页载入失败</h3><p>检查网络后重试，或直接打开 " + VIEWER_URL + "</p>",
        });
    }, () => {
        $done({ status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: "<!doctype html><meta charset=utf-8><h3>报告页载入失败</h3>" });
    });
}

/* ==================== 3. 检测接口（一次跑完所有选中模块） ==================== */
function serveApi() {
    let session = null;
    try { session = JSON.parse($prefs.valueForKey(SESSION_KEY) || "null"); } catch (e) {}
    const node = (session && session.node) || nodeParam;
    if (!node) {
        respondJson(409, { ok: false, error: "没有检测会话，请回 QX 节点页重新运行「节点 IP 自检」" });
        return;
    }
    if (session && session.createdAt && Date.now() - Number(session.createdAt) > SESSION_TTL_MS) {
        respondJson(410, { ok: false, error: "检测会话已过期（30 分钟），请回 QX 重新启动" });
        return;
    }
    const plan = (planParam ? planParam.split(",") : DEFAULT_PLAN)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => MODULES[x]);
    if (!plan.length) {
        respondJson(400, { ok: false, error: "没有选中任何检测项目" });
        return;
    }

    const startedAt = Date.now();
    $task.fetch({ url: SRC_URL, timeout: 15000 }).then((r) => {
        if (!r || r.statusCode !== 200 || !r.body || r.body.length < 5000) {
            respondJson(502, { ok: false, error: "检测脚本载入失败: HTTP " + (r && r.statusCode) });
            return;
        }
        runAll(r.body, node, plan, startedAt);
    }, (e) => respondJson(502, { ok: false, error: "拉取检测脚本失败: " + String((e && e.message) || e) }));
}

function runAll(src, node, plan, startedAt) {
    const results = {};
    // 媒体类项目共用一次「执行媒体与 AI 检测」，其余独立跑
    const jobs = plan.map((name, index) => runOnce(src, node, name).then((html) => {
        results[name] = html;
    }, (err) => {
        results[name] = errorBlock(MODULES[name].title, String((err && err.message) || err));
    }));

    const timer = setTimeout(() => respondJson(200, pack(results, node, startedAt, plan, "超时截断")), SOFT_BUDGET_MS);
    Promise.all(jobs).then(() => {
        clearTimeout(timer);
        respondJson(200, pack(results, node, startedAt, plan, ""));
    }, () => {
        clearTimeout(timer);
        respondJson(200, pack(results, node, startedAt, plan, ""));
    });
}

function runOnce(src, node, name) {
    return new Promise((resolve, reject) => {
        const cfg = MODULES[name];
        const optionStore = {
            read(label) {
                if (String(label || "") === "隐藏 IP") return mask ? "true" : "false";
                return cfg.enabled.indexOf(String(label || "")) >= 0 ? "true" : "false";
            },
            write() { return false; },
            remove() { return false; },
        };
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            if (!result || !result.htmlMessage) {
                reject(new Error((result && (result.content || result.message)) || "检测未生成报告"));
                return;
            }
            resolve(filterSections(String(result.htmlMessage), cfg.enabled));
        };
        try {
            const execute = new Function("$done", "$persistentStore", "$environment", "$httpClient", "$notify", "$prefs", "$task",
                "setTimeout", "clearTimeout", "console",
                src + "\n//# sourceURL=ipquality-r8-" + name + ".js");
            execute(done, storeFacade(), { params: { node: node } }, proxyHttpClient(), function () {},
                prefsFacade(), $task, setTimeout, clearTimeout, { log() {} });
        } catch (e) {
            reject(e);
        }
        setTimeout(() => { if (!settled) { settled = true; reject(new Error("单项检测超时（60s）")); } }, 60000);
    });
}

function pack(results, node, startedAt, plan, note) {
    const modules = {};
    plan.forEach((name) => {
        const html = results[name];
        modules[name] = {
            ok: !/^__ERR__/.test(String(html || "")),
            title: MODULES[name].title,
            html: /^__ERR__/.test(String(html || ""))
                ? errorBlock(MODULES[name].title, String(html).slice(7))
                : html,
        };
    });
    const missing = plan.filter((n) => !results[n]);
    missing.forEach((n) => {
        modules[n] = { ok: false, title: MODULES[n].title, html: errorBlock(MODULES[n].title, "未在时限内完成，可单独重试") };
    });
    return {
        ok: true,
        node: node,
        elapsedMs: Date.now() - startedAt,
        note: note,
        mask: mask,
        version: QX_BUILD,
        modules: modules,
    };
}

function errorBlock(title, message) {
    return '<div style="font-family:-apple-system,BlinkMacSystemFont;font-size:13px;padding:10px 1px 14px">'
        + '<div style="font-weight:700;color:#d72f26;margin-bottom:6px">' + escapeHtml(title) + ' 失败</div>'
        + '<div style="color:#8e8e93;line-height:1.5">' + escapeHtml(String(message || "未知错误")).slice(0, 400) + "</div></div>";
}

// 只保留本模块需要的「▌标题」段落，避免每个卡片都塞整份报告
function filterSections(html, enabled) {
    try {
        const parts = String(html).split(/(?=<div style="color:#0A84FF;font-weight:700;font-size:15px)/);
        const head = parts.shift() || "";
        const keep = parts.filter((p) => {
            const m = p.match(/▌([^<]+)</);
            return m && enabled.indexOf(m[1].trim()) >= 0;
        });
        return head + keep.join("");
    } catch (e) {
        return html;
    }
}

/* ==================== 注入给原版脚本的兼容层 ==================== */
function storeFacade() {
    return {
        read(key) { try { return $prefs.valueForKey(key); } catch (e) { return null; } },
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

/* ==================== 工具 ==================== */
function respondJson(code, obj) {
    $done({
        status: code,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify(obj),
    });
}

function queryValue(link, key) {
    const m = String(link || "").match(new RegExp("[?&]" + key + "=([^&#]*)"));
    if (!m) return "";
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
}

function truncate(v, n) {
    const t = String(v || "");
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function escapeHtml(v) {
    return String(v === null || typeof v === "undefined" ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
