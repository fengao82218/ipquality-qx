# ipquality-qx · MaYIHEI/paperclip 的 Quantumult X 移植

两个版本，二选一：

## A. 原生版（对应 `loon/ipquality`）
点节点直接弹纯文本报告，不需要 MITM / 重写。

```ini
[task_local]
event-interaction https://cdn.jsdelivr.net/gh/fengao82218/ipquality-qx@main/ipq-qx-native.js, tag=节点 IP 质量检测, img-url=shield.lefthalf.filled.system, timeout=50, enabled=true
```

## B. 网页多选版（对应 `loon/ipquality-web-test`）
通知进 Safari，勾 14 项，45 s 内并发跑完，折叠合并展示。

```ini
[task_local]
event-interaction https://cdn.jsdelivr.net/gh/fengao82218/ipquality-qx@main/ipq-qx-shim.js, tag=节点 IP 自检, img-url=shield.lefthalf.filled.system, timeout=100, enabled=true

[rewrite_local]
^https://cdn\.jsdelivr\.net/gh/fengao82218/ipquality-qx@main/ipq-qx-shim\.js(\?.*)?$ url script-request-header https://cdn.jsdelivr.net/gh/fengao82218/ipquality-qx@main/ipq-qx-shim.js

[mitm]
hostname = cdn.jsdelivr.net
```

装完需要 QX 设置 → MITM 安装证书（B 版），然后重新载入配置，节点/策略组页长按目标节点运行。

## 实现

检测核心不重写：运行时从 `gcore.jsdelivr.net/gh/MaYIHEI/paperclip@main/loon/ipquality/ipquality.js` 拉原版 r8，用 `new Function` 注入
`$done / $persistentStore / $environment / $httpClient / $notify / $prefs / $task`，上游更新自动跟随。

QX 缺失能力在脚本内补齐：`$environment.params`（节点名）、`$argument`、`$httpClient`（用 `$task.fetch` 模拟）、
`$persistentStore`（用 `$prefs` 模拟）、`htmlMessage`（转为纯文本报告）。

网页版额外把原版 15 个独立接口合并成一次 `/api/all?mods=...` 调用，因为 QX 一个 http-request 脚本只能 `$done` 一次。

## 文件

| 文件 | 说明 |
|---|---|
| `ipq-qx-native.js` / `.snippet` | 原生版脚本与配置片段 |
| `ipq-qx-shim.js` / `viewer.html` | 网页版脚本与报告页 |
| `ipq-qx-web.snippet` | 网页版配置片段 |

## 已知边界

- QX 通知正文有长度上限，原生版超长会截断并提示；要看全文就关掉媒体检测或用网页版。
- 网页版勾太多项目会触及 45 s 软预算，超时模块标记「未在时限内完成」，可单独重跑。
- 媒体/地区一致性共用原版一次「执行媒体与 AI 检测」，同时勾选会重复请求基础数据（上游设计）。
