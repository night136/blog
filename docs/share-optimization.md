# 文章分享功能优化（2026-09-12）

优化前：详情页只有 `📋 复制链接` / `📤 分享` 两个按钮，`sharePost()` 是 10 行的 if/else。
所有结论均来自代码实测，未凭印象推断。

## 优化前的问题（代码实证）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| 1 | 只走 `navigator.share`，不成立就什么都不做 | `app.js` sharePost | **微信内置浏览器 / 多数桌面浏览器点了没反应**，而微信恰是最主要渠道 |
| 2 | 复制 `.catch(() => {})` 静默吞错 | 同上 | 非 HTTPS、权限被拒、老浏览器无 clipboard API 时，用户以为复制成功 |
| 3 | 没有二维码 | — | PC 上想转到手机 / 微信，零入口 |
| 4 | 复制成功弹 `alert()` | 同上 | 阻塞式、抢焦点，与全站质感不搭（全站共 8 处 alert） |
| 5 | 分享 URL 用 `location.pathname` | sharePost + `updateMeta` | 从 `/index.html?post=x` 进来会把丑路径一起传播（含写入 `og:url`） |
| 6 | 只有标题下一处入口 | 模板 | 长文读到底想分享，得滚回顶部 |

## 实施内容

### P0 — 正确性（无新依赖）

- **canonical URL**：新增 `SITE_PATH`（取 canonical 的 `pathname`，与既有 `SITE_ORIGIN` 对称），
  分享链接统一走 `postShareUrl(slug) = SITE_ORIGIN + SITE_PATH + "?post=" + encodeURIComponent(slug)`。
  ⚠️ 顺带修掉一个**同类隐患**：`updateMeta()` 里的 `og:url` 也在用 `location.pathname` 拼，
  现在共用 `postShareUrl`——否则分享卡片里的 og:url 同样会带 `/index.html`。
- **轻提示 `toast()`**：取代分享里的 `alert`。用 `textContent` 渲染（天然防注入），
  `z-index: 200`（高于 `.modal-mask` 的 100，面板内点复制也看得见），
  带 `role="status" aria-live="polite"`，2.2s 自动消失。
- **复制三级降级**：`navigator.clipboard`（需 `isSecureContext`）→ `execCommand("copy")`（http / 老浏览器）
  → 失败则提示「复制失败，请长按输入框手动复制」。
  ⚠️ 不能只看 `navigator.clipboard` 是否存在 —— **非安全上下文里它存在但必然 reject**，这正是原来静默失败的根因。

### P1 — 分享面板（真正解决「发得出去」）

自建面板写在 `index.html`（`#shareModal`，复用 `.modal-mask` / `.modal` / `.modal-close` 骨架），
而不是 JS 动态生成 —— 结构与文案可被静态断言守护，改文案也不必翻 JS。

**按环境三分支**（核心设计）：

| 环境 | 首项 | 说明 |
|---|---|---|
| 微信内置浏览器（UA 含 `MicroMessenger`） | 顶部提示「点右上角 ··· → 发送给朋友 / 分享到朋友圈」 | 微信里无法唤起微信、也扫不了自己的码，只能给引导 |
| 支持 `navigator.share` 的手机 | 「系统分享」 | 直接调起原生面板；**按钮按能力显隐**，不支持就不出现死按钮 |
| 桌面 / 其它 | 「微信 → 二维码」 | 扫码在手机上打开，这是 PC→手机最通用的通道 |

其它渠道：微博 / X / Telegram（官方分享 URL，标题与 URL 均 `encodeURIComponent`）、复制链接、复制标题+链接。

- **二维码**：本地库 + 懒加载（详见下节），canvas 逐模块绘制，**固定白底深码 `#FFFFFF` / `#1A1815`**，
  留 4 模块静区。刻意不跟随主题 —— 深色主题下改用主题色会拉低对比度导致扫不出来。
- **无障碍**：`role="dialog" aria-modal="true" aria-labelledby`；打开时锁 `body` 滚动并聚焦关闭按钮，
  关闭时把焦点还给触发按钮；ESC 逐层关闭顺序改为 **分享面板 → 抽屉 → 登录弹窗**；点遮罩可关。
- **安全**：面板内容全部走 `textContent` / `value`（绝不 `innerHTML` 拼用户内容）；
  封面走 `safeUrl()` 白名单且无封面时隐藏（不留破图）；外链 `window.open(..., "noopener,noreferrer")`。

### P2 — 细节

- 面板顶部带封面缩略图 + 摘要（摘要缺失时从正文剥离 Markdown 后截 78 字）。
- 「复制标题 + 链接」按钮（微信里粘贴更友好）。
- **文末再加一个入口**（`${nav}` 之后，正文读完处），与顶部共用同一个面板。
  ⚠️ 文末入口样式刻意不重设 `.share-btn` 的任何尺寸 —— 那会盖掉 `@media (pointer: coarse)` 的触屏提升。

## 二维码库选型

**选用 `qrcode-generator` (Kazuhiko Arase, MIT)**，`assets/vendor/qrcode.js`（56KB，br 后约 18KB）。

为什么不是更常见的 `davidshimjs/qrcodejs`：后者依赖 DOM/canvas 才能产出**图像**，在 Node 里无法验证；
`qrcode-generator` 是**纯计算**（输出模块矩阵 `isDark(r,c)`），因此可以在 CI 式回归里真的跑一遍 ——
`verify-share.mjs` 会 `require` 它、生成一个真实 URL 的二维码，断言**三个定位图案齐全**、暗模块占比在 0.3~0.6、
长 URL 能自动升版本。前端只把矩阵画到 canvas（15 行），不依赖库自带渲染。

**安全审计结论（P2 / 干净）**：无 `eval` / `new Function` / `fetch` / `XMLHttpRequest` / `WebSocket` /
`localStorage` / `document.write`；文件内出现的 URL 全是注释里的许可与规范链接；头部带 MIT 版权声明。
这些扫描本身也固化成了断言（`[10]` 供应链守护），库被换掉或篡改会被拦下。

**加载策略**：只有真的点开二维码才 `ensureQrLib()` 动态插入 `<script>`，失败会清空 loading 允许重试。
HTML 里**没有**静态引入（断言守护），首页与正常阅读都不加载这 56KB。

⚠️ 该文件走 `/assets/*` 的 `max-age=86400 + stale-while-revalidate=604800`。库是冻结的，没问题；
**若将来升级库版本，必须换文件名（或加 `?v=`）**，否则最长可能一整天仍用旧文件。

## 回归

- 新增 `scripts/verify-share.mjs`（**63 项**，10 个分区）：URL 构造 / 复制降级 / toast / 面板结构 /
  环境分支 / 二维码（含**真实编码验证**）/ 交互与安全 / 多入口 / 面板内元素 / 供应链。
- 负向验证 **9 / 9 全部拦住**：URL 退回 `location.pathname`、剪贴板不降级、系统分享按钮不按能力显隐、
  微信内也画二维码、QR 改用主题色、去掉 `noopener`、库改成 HTML 静态引入、删掉文末入口、复制失败静默。
  - ⚠️ 负向验证踩到的坑（已写进断言注释）：第一版「QR 用主题色」**没被拦住** —— 断言在**全文范围**
    匹配 `ctx.fillStyle = "#FFFFFF"`，而 `app.js` 另有一处上传图片压缩也用同样的白底填充，
    改了 QR 那处、另一处仍满足断言。**断言必须限定在目标函数体内**才有效。
- 已接入 `scripts/run-all.sh`。全量：`og 40 / xss 23 / jwt 18 / manage / cover 35 / asset 14 /
  frontend 15 / mobile 65 / share 63 / lunar 9 / smoke`，**8 秒**跑完。

## 已知边界

- 微信内**无法**用 Web API 唤起微信分享面板，只能给「右上角」引导 —— 这是平台限制，不是实现缺陷。
- 移动端点「微信」显示二维码，长按可识别；但部分 App 内置浏览器不支持长按识别，此时用「复制链接」。
