/**
 * 节点 IP 质量检测 · Quantumult X 原生版（对应 loon/ipquality 原版）
 *
 * 与 qx2 网页版不同：这里直接把原版 ipquality.js (r8) 的 htmlMessage 报告
 * 在 QX 的通知里以纯文本形式完整给出（QX 不支持 htmlMessage 富文本）。
 *
 * 事件：
 *  - event-interaction  : 节点/策略组页运行，跑完一次性返回报告文本
 *  - http-request .../api/all : 网页版共用（这里保留，便于可选网页壳）
 */
const QX_BUILD = "2026-11-02.qx1-native";
const SRC_URL = "https://gcore.jsdelivr.net/gh/MaYIHEI/paperclip@main/loon/ipquality/ipquality.js";
const HARD_BUDGET_MS = 50000;

// 从 QX 节点页拿节点名：$environment.params（QX 交互脚本会带）或 URL node=
const reqUrl = String(($request && $request.url) || "");
const nodeParam = queryValue(reqUrl, "node");
let nodeName = "";
try {
    if (typeof $environment !== "undefined" && $environment) {
        nodeName = String($environment.params || $environment.node || "");
    }
} catch (e) {}
nodeName = (nodeName || nodeParam || "").trim();

if (!nodeName) {
    $done({ title: "节点 IP 质量检测", message: "未获取到节点名。请在 QX 节点/策略组页长按该节点运行本脚本。", icon: "network.slash" });
} else {
    run();
}

function run() {
    const startedAt = Date.now();
    let settled = false;
    const finish = (result) => {
        if (settled) return;
        settled = true;
        $done(result);
    };
    const timer = setTimeout(() => finish({
        title: "节点 IP 质量检测",
        message: "检测超过 " + Math.round(HARD_BUDGET_MS / 1000) + " 秒未完成，请稍后重试（媒体检测耗时较长）。",
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
                finish(toTextDone(result, startedAt));
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

/* 把 htmlMessage 转成 QX 能显示的纯文本报告（保留分节与对齐） */
function toTextDone(result, startedAt) {
    result = result || {};
    const title = pickTitle(result) || "节点 IP 质量检测";
    const html = result.htmlMessage ? String(result.htmlMessage) : "";
    let text = html ? htmlToText(html) : String(result.content || result.message || "");
    const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
    text = text.replace(/Loon 不提供节点 TCP\/DNS API/g, "QX 不提供节点 TCP/DNS API");
    text += "\n\n—— " + cost + " 秒 · " + QX_BUILD;
    if (text.length > 3900) {
        // QX 通知正文有长度上限，超长截断并提示
        text = text.slice(0, 3900) + "\n…（过长已截断，可关闭媒体检测或改用网页版看全文）";
    }
    return { title: title, message: text, icon: result.icon || "shield.lefthalf.filled" };
}

function pickTitle(result) {
    if (result.title && result.title.replace(/\u200B/g, "").trim()) return result.title;
    return "节点 IP 质量检测";
}

function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(div|p|tr|li|h[1-6]|section|details|summary)>/gi, "\n");
    s = s.replace(/<\/t[dh]>/gi, "  ");
    s = s.replace(/<hr[^>]*>/gi, "\n──────────\n");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    s = s.replace(/[ \t]+/g, " ");
    s = s.replace(/\n[ \t]+/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    // 去掉原版用来撑高度的空行
    s = s.split("\n").filter((line) => line.trim() !== "" || true).join("\n");
    return s.trim();
}

/* 注入给原版脚本的兼容层 */
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

// MapNotification 复用：原版会自己 $notify，这里透传给 QX
function mapNotify() {
    return function (title, subtitle, body, options) {
        if (typeof $notify === "function") $notify(title, subtitle, body, options || {});
    };
}

function queryValue(link, key) {
    const m = String(link || "").match(new RegExp("[?&]" + key + "=([^&#]*)"));
    if (!m) return "";
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
}
