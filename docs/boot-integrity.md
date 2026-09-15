# 启动完整性：为什么横幅要同时判 BOOTED 和 READY

> 2026-09-15。相关守护：`scripts/verify-first-paint.mjs` 的 `[10]` 段（含变异自检）。
> 实验台（在 gitignore 的 `.diag/`）：`old-warm-abort.mjs`（复现历史事故）、`degrade-check.mjs`（验证修复）。

## 事故：一行同步异常，让整站「半死」且静默

`assets/app.js` 是**单个 IIFE**：`(function () {` 在第 2 行、`})();` 在末尾，**中间没有任何顶层 try/catch**。
于是**任何一处顶层同步异常，都会让后面所有顶层语句集体不执行**（函数声明因提升还在，但没人绑定、没人调用）。

当时那道异常来自 Turnstile：

```js
if (window.turnstile && window.turnstile.ready) { … }   // 第 2128 行，热缓存下必抛
```

它后面还排着 530 多行：

| 位置 | 内容 |
|---|---|
| 第 5 行 | `window.__APP_BOOTED__ = true` |
| 第 2128-2131 行 | Turnstile 的 `ready()` ← **抛在这** |
| 第 2532-2567 行 | 汉堡菜单、**登录/登出/发布/分享**等按钮绑定 |
| 第 2644 行 | `tickClock()`（时钟 + 农历挂件） |
| 第 2662-2664 行 | `bindInputStates(); ensureSession(); loadPosts();` ← 真正的初始化 |

真浏览器实测（`.diag/old-warm-abort.mjs`，旧版快照 + 本地打桩，同 profile 先冷跑再 reload 跑热）：

| 判据 | 冷缓存（api.js 1096ms） | 热缓存（api.js 10ms） |
|---|---|---|
| `/api/posts` 请求数 | 1 | **0** |
| `/api/me` 请求数 | 1 | **0** |
| `#cardGrid` 内容长度 | 467746 | **0** |
| 点「登录」按钮 | 弹窗打开 ✔ | **毫无反应** |

四个互相独立的判据指向同一件事：`loadPosts()` 压根没被调用。表现就是**首页空白 + 按钮全死**，
而控制台只有一条红字 —— 也就是用户最早反馈的「连续刷新会这样」（连续刷新 = 热缓存 = 必现）。

## 更尴尬的是：兜底横幅本来该抓住它

`index.html` 的注释写着「若 app.js 仍未启动（脚本没下下来 / **运行中断** / 被第三方脚本阻塞）」——
它**明确想抓「运行中断」**。但判据是：

```js
if (!window.__APP_BOOTED__) { …显示横幅… }
```

而 `__APP_BOOTED__` 在 IIFE 的**第 5 行**就置位了。「启动了、但中途断了」这种情况，
`BOOTED` 是 `true` ⇒ 横幅**永远不弹**。判据从「启动**完成**」退化成了「启动」，
设计目标当场落空（`efed1f5` 当初把它提前是为了防误报，副作用就是这条盲区）。

## 改法：两个标记，分工不同

```js
// app.js 第 5 行附近
window.__APP_BOOTED__ = true;    // 「脚本已开始执行」——放最前面，避免误报

// app.js 末尾（IIFE 收口前一行）——⚠️ 必须是最后一个顶层语句
window.__APP_READY__ = true;     // 「启动段已完整跑完」
```

`index.html` 的 10s 兜底改成双判据，并分两种文案：

| 状态 | 标题 | 说明 |
|---|---|---|
| `!BOOTED` | ⚠️ 页面脚本未能启动 | 脚本没下下来 / 被阻塞（原有文案） |
| `BOOTED && !READY` | ⚠️ 页面脚本启动中途中断 | **新增**：初始化没跑完，功能会失灵 |

横幅还会带出**第一条未捕获错误的 message**（`window.__BOOT_ERROR__`，在 `index.html` 的
`window.addEventListener('error')` 里记，只记带 `message` 的运行时错误、不碰资源错误），
所以用户不用开控制台就知道断在哪。标题/说明都带 id（`bootTitle` / `bootHint`）以便改写。

## 怎么验

```
node .diag/degrade-check.mjs
```

三个 Pass（真浏览器 + 本地服务 + `/api` 打桩 + Turnstile 官方测试密钥）：

| Pass | 场景 | 结果 |
|---|---|---|
| 1 | 正常完成 | `READY=true`、**10s 后横幅不弹**（防止造出一个总在弹的假告警）、`/api/posts` 有请求 |
| 2 | CDP 掐断 `challenges.cloudflare.com` | 容器出现「人机验证加载失败 + 重试」；提交文案指向重试/刷新、按钮可点、不发 POST；解除拦截后点「重试」→ widget 画出来 + token 长度 21 → 再提交 POST 真的发出 |
| 3 | 把 `throw` 插进启动段中间（复刻事故形态） | `BOOTED=true` / `READY=false`、横幅弹出且标题是「启动中途中断」、正文含错误原文、`/api/posts` 请求数 **0** |

## 铁律

- ⚠️ **新加的启动代码必须写在 `window.__APP_READY__ = true;` 之前** —— 写在它后面等于不受「中断检测」覆盖
  （`verify-first-paint.mjs` 的 `[10]` 段有断言：READY 之后除 IIFE 收口外不得有可执行语句）。
- 🚫 **别把 READY 提到 IIFE 开头**（那就退化成第二个 BOOTED，等于没加）。
- 🚫 **横幅判据不能只看 BOOTED**，否则「启动中途断掉」永远静默。
- 单 IIFE + 顶层无 try/catch 是这套机制的前提：一旦给顶层套了 try/catch，READY 反而会「照常置位」而掩盖问题 ——
  真要加，得改成在 catch 里显式把失败原因写进 `__BOOT_ERROR__` 并**不置位** READY。
