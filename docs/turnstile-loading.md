# Turnstile 的加载方式（别再改回 `turnstile.ready()`）

> 2026-09-15 线上控制台报错的排查与修复（`89838d8`）；同日补充「拉不到时的降级与重试」。
> 相关守护：`scripts/verify-first-paint.mjs` 的 `[9]` 段（含 4 组变异自检）。
> 诊断/验证脚本（均在 gitignore 的 `.diag/`）：`turnstile-probe.mjs`、`local-turnstile-check.mjs`、
> `ts-undefined-cases.mjs`（三组对照）、`degrade-check.mjs`（降级端到端）、`check-deploy.mjs`。

## 症状

控制台一条红字：

```
Uncaught TurnstileError: [Cloudflare Turnstile] Remove async/defer from the
Turnstile api.js script tag before using turnstile.ready().
    at Object.ready (app.js?v=…:2130:22)
```

## ⚠️ 为什么冷缓存复现不出来

| 缓存 | 谁先执行 | 结果 |
|---|---|---|
| 冷（全新 profile） | `app.js`（defer，先启动）→ api.js 还没到 | `typeof window.turnstile === "undefined"` → 那个分支被整个跳过 → **控制台干净** |
| 热（二次打开） | api.js 在缓存里，**先于** app.js 执行 | 进了 `if (window.turnstile && window.turnstile.ready)` → **必抛** |

`index.html` 里 `app.js` 是 `defer`、api.js 是 `async defer`，**两者的先后完全由缓存状态决定**。
所以复现必须用 `--warm`（二次导航）：

```
node .diag/turnstile-probe.mjs https://blog-6p3.pages.dev/ --warm
```

它直接 `Runtime.evaluate` 调一次 `ready()`，输出 `THROW: …Remove async/defer…`，一锤定音。

## 根因：这两件事不可兼得

1. Cloudflare 明确要求：**要用 `turnstile.ready()` 就不能给 api.js 加 `async/defer`**（异步加载时它无法保证就绪语义）。
2. 本项目的设计又要求：**app.js 必须排在 Turnstile 之前先启动**（否则跨境慢加载会连累整站 JS，触发 6s 兜底横幅）。

两者冲突。这不是「写法不对」，是**设计互斥**。

## ★ 顺带发现：比报错本身更严重的「假兜底」

原 `renderTurnstile()` 长这样：

```js
if (typeof window.turnstile === "undefined") {
  // Turnstile 脚本还在加载，等脚本就绪事件自动触发
  return;
}
```

那句注释里的「脚本就绪事件」**正是会抛异常的 `ready()`** —— 兜底压根不存在。
于是 widget 画不画得出来，完全取决于 `/api/config` 与 api.js **谁先返回**：

- 冷缓存下配置先到 → 首次渲染被丢弃（`turnstileWidgetId` 始终为 `null`），
  得等用户点进留言墙 / 注册页才补上渲染。
- 也就是说：**功能看起来是好的，纯属运气**。这属于本项目的第 2 类静默失败
  （见 `MEMORY.md`）：**兜底是句空口号。**

## 改法

```js
const TURNSTILE_API_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function ensureTurnstileScript() {          // 自己注入，只认 <script> 的 load/error
  if (window.turnstile && typeof window.turnstile.render === "function") return Promise.resolve(true);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_API_URL; s.async = true;
    s.onerror = () => { turnstileScriptPromise = null; /* 清空 → 下次交互还能再试 */ resolve(false); };
    s.onload = () => {                        // 只认「脚本跑完且 API 真挂上」
      const ok = !!(window.turnstile && typeof window.turnstile.render === "function");
      if (!ok) turnstileScriptPromise = null; // 空脚本（代理/扩展改写）也算失败，允许重试
      resolve(ok);
    };
    document.head.appendChild(s);
  });
  return turnstileScriptPromise;
}

function renderTurnstile(ready) {           // 未就绪 → 就绪后重画；ready 标记防自递归
  …
  if (!window.turnstile || typeof window.turnstile.render !== "function") {
    if (!ready) ensureTurnstileScript().then((ok) => { if (ok) renderTurnstile(true); });
    return;
  }
  …
}
```

配套改动：

- **`index.html` 删掉 Turnstile 脚本标签**，只留 `<link rel="preconnect" href="https://challenges.cloudflare.com">`。
  收益是顺带的：api.js 从首屏关键路径上移走（实测原实现 **+515ms** 就开始和 app.js / style.css 抢带宽）。
- **提交路径先 `await ensureTurnstileScript()`**：否则「刚打开页面就点提交」会被误报成「请先完成人机验证」。
- **`getResponse` 前先确认 widget id 非空**：脚本已到但 widget 还没渲染时，不要拿 `null` 去问。
- 启动段那三行 `turnstile.ready(...)` 删除，注释写清为什么不能放回来。

## 怎么验（不部署也能端到端）

`.diag/local-turnstile-check.mjs`：**本地静态服务 + `/api/*` 打桩 + Turnstile 官方测试密钥**
（`1x00000000000000000000AA`，恒通过、不校验域名）+ 本机 Edge/CDP。

```
node .diag/local-turnstile-check.mjs
```

判定标准：

- 注入顺序 `app.js → api.js` ✔
- 控制台 **0 条 error/warning** ✔
- **挑战真的通过了** —— 看 `input[name="cf-turnstile-response"]` 的 token 长度（实测 21 字节）

⚠️ **别拿 iframe 数当判据**：widget 的 iframe 在 **closed shadow root** 里，
`querySelectorAll('iframe')` 数出 **0 是正常的**，一开始就是这么误判成「又没渲染」。

## 脚本彻底拉不到时：降级 + 重试（别让用户去点空气）

上一版修好了「脚本迟到」，但没管「脚本永远不到」（被墙 / 跨境超时 / 被扩展或代理拦截）。
那时容器里只有一个 65px 的空灰框（CSS 的 `min-height`），点提交才弹一句
**「请先完成人机验证」——可页面上根本没有验证框可点**，是死胡同（`ts-undefined-cases.mjs` 的 Pass A 实测）。

现在：

- 失败即把容器换成 `.ts-fallback`（「人机验证加载失败」+「重试」按钮），不再留空灰框；
  `.ts-fallback` 只在容器里没有时插入，重复触发不会堆叠。
- 提交时若脚本确实拉不到，文案变成「人机验证加载失败，请点验证框里的「重试」或刷新页面」，
  按钮恢复可点（不会卡在「钉上中…」）。
- 「重试」会清空容器、**把 `turnstileWidgetId` / `registerWidgetId` 置空**、重建 `turnstileScriptPromise`。
  ⚠️ 置空 id 是必须的：容器一清空旧 widget 就没了，带着旧 id 走 `reset()` 分支会让 Cloudflare 抛
  `Could not find widget for provided container`（`ts-undefined-cases.mjs` 的 Pass B 就复现过这个冻结态）。
- 渲染前会清掉残留的 `.ts-fallback`（Turnstile 要求容器干净）。
- 提交成功后会 `reset(widgetId)` → 触发新一轮验证 → `callback` 紧跟执行，
  所以回调**只清 `err` 类提示**，否则会把刚写上去的「✅ 已钉上」一起抹掉（`degrade-check.mjs` 抓到）。

验证：

```
node .diag/degrade-check.mjs
```

Pass 2 用 CDP `Network.setBlockedURLs(["*challenges.cloudflare.com*"])` 真掐断，检查
「出现降级提示 → 提交文案正确、按钮可点、不发 POST → 解除拦截 → 点重试 → widget 画出来（token 长度 21）
→ 再提交，POST 真的发出且提示「✅ 已钉上」」。

## 截图里另外三条报错：不是本站的

`No available adapters.` ×2 与 `OTS parsing error: Size of decompressed WOFF 2.0 …`
的源码都标成 `normal` / `normal?lang=zh-cn`，看着完全不像本站的东西。抓请求后真身：

```
https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/<id>/<sitekey>/auto/fbE/new/normal?lang=zh-cn
```

即 **Turnstile 挑战 iframe 自己的内部资源**（`lang=zh-cn` 正来自我们传的 `language: "zh-cn"`；
`normal` 是它 URL 的最后一段，所以控制台就显示成 `normal`）。
跨域、非本站代码 —— **修不了，也不该修**。截图 5 行里有 4 行属于这类噪声，我们真正欠的只有 1 条。

## 铁律

- 🚫 **绝不用 `turnstile.ready()`**，api.js 必须由 `ensureTurnstileScript()` 注入、只认 `load`/`error`。
- 🚫 **别把 api.js 的 `<script>` 写回 `index.html`** —— 一是会重新抢首屏带宽，二是又变回「与 app.js 抢执行顺序」。
- 🚫 **别把降级提示退回成空灰框 + 「请先完成人机验证」** —— 那是让用户去点一个不存在的验证框。
  同理：**重试时不许漏掉置空 widget id**（会复现 `Could not find widget for provided container` 冻结态）。
- ⚠️ 改这块后必须跑 `node scripts/verify-first-paint.mjs`，并把「把 `ready()` 写回启动段 → 断言必须判红」做一遍。
- 启动完整性（`BOOTED` / `READY` 与兜底横幅）见 `docs/boot-integrity.md`。
