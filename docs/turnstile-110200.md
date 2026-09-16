# Turnstile 一直转圈：Site Key 的域名未授权（Error 110200）

> 2026-09-15 线上排查。**这不是代码问题**，是 Cloudflare Turnstile widget 的配置问题。
> 诊断脚本（均在 gitignore 的 `.diag/`）：`ts-env-control.mjs`（对照实验）、`ts-headful.mjs`（生产/测试 key 对照）。

## 现象

留言墙的人机验证一直转圈，控制台报错。实测线上 `blog-6p3.pages.dev`：

- `turnstile.render(container, {...})` **正常返回 widget id**（如 `cf-chl-widget-poboz`），容器里也生成了
  `<input type="hidden" name="cf-turnstile-response">` —— 单看这些会误以为「渲染成功了」。
- 但那个隐藏 input 的 **value 永远是空字符串**，`callback` 与 `error-callback` **两个都不触发**。
- 提交时 `getResponse()` 拿到空 token → 后端 Siteverify 必然失败。

## 判定证据（同页面 A/B 对照，真实窗口 Edge 153）

在**同一个线上页面**里，用 `turnstile.render()` 分别渲染两个 key，各自等 12s：

| | 生产 key `0x4AAAAAAElYtrmtII33QBbp` | 官方测试 key `1x00000000000000000000AA` |
|---|---|---|
| `callback` 触发 | ❌ 从不 | ✅ 触发 |
| token 长度 | **0** | **21**（`XXXX.DUMMY.TOKEN.XXXX`） |
| 隐藏 input 的 value | 空 | 已填入 |
| `error-callback` | ❌ 也从不触发 | 无错误 |

**测试 key 秒过、生产 key 死寂** ⇒ 排除了浏览器、网络、前端代码。

另一个对照（`.diag/ts-env-control.mjs`）：在 `about:blank` 里用**官方接入方式**
（`.cf-turnstile` 容器 + 带 `async defer` 的 api.js），控制台抛：

```
Uncaught TurnstileError: [Cloudflare Turnstile] Error: 110200.
```

## 错误码 110200

Cloudflare 官方定义（`turnstile/troubleshooting/client-side-errors`）：

| 错误码 | 含义 | 可重试 | 处置 |
|---|---|---|---|
| **110200** | **Unknown domain: Domain not allowed** | 否 | Turnstile 被用在**未授权**的域名上。到 dashboard 的 widget 配置里把该域名加进允许列表。 |

所以「一直转圈」的完整解释是：**widget 被 Cloudflare 拒绝服务**，而 Turnstile 在 110200 这类
「配置错误」下**连 error-callback 都不调**，只是把挑战 iframe 留在未完成状态 ——
前端自然看不到任何可诊断的信号，只能表现为无限加载。

## ⚠️ 修复步骤（需要昉昕在 Cloudflare 控制台操作）

1. 登录 Cloudflare dashboard → **Turnstile** → 找到 Site Key `0x4AAAAAAElYtrmtII33QBbp` 对应的 widget。
2. 编辑该 widget 的 **Hostname Management / Allowed domains**，加入：
   - `blog-6p3.pages.dev`（当前 canonical 域名，**必须**）
   - 若还在用，补 `zhongfangxin682.workers.dev`
   - 本地开发要加 `localhost`（Cloudflare 允许 `localhost` 作为测试域名）
3. 保存后**无需重新部署**，前端最多 5 分钟（`/api/config` 的 `max-age=300`）后拿到同一 key 即生效；
   想立刻验证可硬刷页面。

验证方法（改完域名后直接跑，应看到 token 长度 > 0）：

```
node .diag/ts-headful.mjs
# 「真实窗口 + 生产 key」那一段应从 tokLen: null 变成 tokLen: 20+，且 inputLen > 0
```

## 相关的代码事实（避免下次误诊）

- **`iframes: 0` 不是故障判据**：Turnstile 的挑战 iframe 挂在 **closed shadow root** 里，
  用 `container.querySelectorAll('iframe')` 数永远是 0；`document.querySelectorAll('iframe')` 也是 0。
  **唯一可靠的判据是隐藏 input 的 value（或 `getResponse()`）有没有拿到 token。**
- `render()` 返回非空 widget id **也不代表成功** —— 它只表示「请求已被受理」。
  110200 这类错误下它照样返回 id 并生成 input，然后什么都不发生。
- 容器「是否可见」不影响：实测在 `display:none` 的祖先里 render，和进入留言墙（可见）后 render，
  结果是**一样的**（都拿不到 token），所以「先隐藏后显示不重绘」不是本问题的原因。
- 降级 UI 的边界：`renderTurnstileFallback()` 只在**脚本拉不到 / window.turnstile 不可用**时触发。
  110200 是「脚本正常、widget 被拒」，属于另一类失败，所以降级提示不会出现 —— 这点考虑后续补一个
  「渲染后 N 秒内仍拿不到 token」的超时检测（见下）。

## 后续可做（本次未实现，等 key 修好后确认）

给 widget 加 `error-callback` + 一次「渲染后超时仍未出 token」的检查，直接显示
「人机验证被拒绝（域名未授权 / 配置错误），请检查 Turnstile 域名设置」，
而不是让用户对着一个永远转圈的框。这样以后同类配置错误能自证，不用再靠真浏览器探针抓。
