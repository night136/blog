# 移动端专项审查（2026-09-12）

审查范围：`index.html`、`assets/style.css`(1351 行，6 处媒体查询)、`assets/app.js`、`_headers`。
所有结论均来自代码实证，未凭印象推断。

## 现状基线

| 项 | 实测值 | 评价 |
|---|---|---|
| 断点 | 980px（单列 + 抽屉）、640px（手机细调） | 够用 |
| `assets/app.js` | 106KB → br **26KB** | 正常 |
| `assets/style.css` | 80KB → br **15KB** | 正常 |
| `assets/vendor/lunar.js` | 426KB → br **87KB**，**每次加载都拉** | ⚠️ 有问题 |
| `assets/vendor/highlight.min.js` | 119KB → br 35KB，**已有代码块才懒加载** | ✅ 已优化 |
| viewport | `width=device-width, initial-scale=1.0`（无 `viewport-fit=cover`） | 缺 |
| `dvh` / `safe-area-inset` / `theme-color` / `-webkit-tap-highlight-color` / `overscroll-behavior` | 全站 **0 处** | 缺 |
| `:hover` 规则 | 52 处，**无一被 `@media (hover:hover)` 包裹** | 触屏会粘 |
| 触摸手势 | **0 处**（全站无 `touchstart`/`pointerdown`） | 缺 |

---

## P0 — 真故障 / 明显损伤

### 1. 移动端白拉 87KB 农历库，却只用到一个占位符

**证据**：
- `app.js:2038` 用 `setTimeout(inject, 0)` **无条件**注入 `assets/vendor/lunar.js`（426KB / br 87KB）。
- 但移动端 `style.css:574` `.rightbar { display: none }` —— 详细农历挂件 `#lunarWidget`、此刻时钟 `#sideClock`（都在 `.rightbar`，`index.html:344-382`）**整体不显示**。
- 移动端唯一用到 `Lunar` 的，是 hero 里那一行干支（`index.html:201` `#lunarClock`，渲染出「癸卯年（兔）八月廿日 · 申时 15:04:07」）。

**代价**：95% 的移动端流量换来一行字。87KB 之外还有 426KB 脚本的**解析执行**开销（低端机 200~500ms 主线程占用），且它跟在首屏之后跑，直接顶掉滑动流畅度。

**修法（按投入排序）**：
- **A（推荐）**：`matchMedia("(max-width: 980px)")` 命中时**不自动加载**；把 hero 那行降级为纯公历时间（`updateLunar` 已有 `typeof Lunar` 保护，不加载时本就不报错）；用户点一下那行 → 加载库并升级为干支。移动端首屏 **-87KB**。
- **B**：保留自动加载但**推迟到 `requestIdleCallback` + 首次交互之后**（`{ once:true }` 监听 `touchstart`/`scroll`），至少不抢首屏。
- **C**：若想保留干支，可只引入农历数据子集自行实现干支/月日（逻辑很轻，`Lunar.fromDate` 那几行），彻底不引 426KB。

### 2. `100vh` + 无安全区适配 → 抽屉底部被切、编辑器键盘弹出即废

**证据**：
- `style.css:575` `.sidebar { height: 100vh }`（移动端抽屉）
- `style.css:609` `.compose-full { height: calc(100vh - 100px) }`
- `style.css:577` `.hamburger { position: fixed; top: 9px; left: 10px }`
- `style.css:589` `.content { padding: 64px 0 20px }`
- `index.html:5` viewport 无 `viewport-fit=cover`；全站无 `env(safe-area-inset-*)`

**症状**：
- iOS Safari 地址栏收起/展开时 `100vh` **恒等于地址栏展开态的高度**（比可视区大）→ 抽屉滚到底仍有一段内容看不到。
- 刘海屏/安卓手势条会压住顶栏左侧固定按钮与页面底部内容。
- 编辑器在软键盘弹出时可视高度骤降，`calc(100vh - 100px)` 不变 → 输入区被键盘完全盖住。

**修法**：
```css
/* 视口单位：dvh 优先，vh 兜底 */
.sidebar   { height: 100vh; height: 100dvh; }
.compose-full { height: calc(100vh - 100px); height: calc(100dvh - 100px); }
/* 安全区（配合 viewport-fit=cover） */
.hamburger { top: max(9px, env(safe-area-inset-top)); left: max(10px, env(safe-area-inset-left)); }
.content   { padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
```
`index.html` viewport 改为 `width=device-width, initial-scale=1.0, viewport-fit=cover`。
另外编辑器建议直接用 `100dvh` 或改 `min-height:0` + flex，键盘弹出时让内容区自己滚。

### 3. 输入框 15px → iOS 聚焦自动放大整页

**证据**：`.search-box input`(222)、`.compose-meta input`(528)、`.auth-form input`(496/741) 全为 `font-size: 15px`。

iOS Safari 对 **<16px** 的输入框会在聚焦时把整页放大，且收起键盘后常常不还原 —— 用户会觉得"点一下搜索框页面就变大了"。

**修法**：移动端统一提到 16px（或全局改 16px，视觉差异很小）：
```css
@media (max-width: 640px) {
  .search-box input, .compose-meta input, .auth-form input,
  .compose-panels textarea, .compose-panels input { font-size: 16px; }
}
```

---

## P1 — 明显影响可用性

### 4. 点击目标普遍小于 44×44（Apple HIG / Material 下限）

| 元素 | 位置 | 实际尺寸 | 问题 |
|---|---|---|---|
| `.theme-toggle` | `588` | **34×34** | 偏小 |
| `.editor-toolbar button` | `612` | **32×32** | 偏小，且密集换行后易误触 |
| `.social-link` | `—` | 34×34 | 偏小 |
| `.post-actions button` | `623` | `padding:5px 8px; **font-size:11px**` → 约 26px 高 | 字号已低于可读下限 |
| `.share-btn` | `638` | `font-size:12px` | 字号偏小 |
| `.code-copy` | `642` | `font-size:11px` | 字号偏小 |
| `.post-cover` 返回键 | `630` | `13px` | 略小 |

**修法**：触屏下最小 44×44（视觉可不变，用 `::after` 扩热区）；正文相关字号提到 **≥13px**（11px 的正文操作按钮在手机上基本是硬伤）。工具类按钮建议 40px 起步 + `gap` 拉开。

### 5. 弹窗在矮屏 / 横屏 / 键盘弹出时被裁切且无法滚动

**证据**：`.modal-mask { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center }`（`style.css:483`）—— **没有 `overflow-y: auto`**。`.modal-auth` 移动端 `min-height: auto` 但仍有 `.auth-side{min-height:180px}` + `.auth-content{padding:24px 20px}`。

**症状**：内容高于视口时，flex 居中会让溢出**同时向上向下**发生，向上溢出的那部分**永远滚不到**（经典 flex 居中溢出 bug）。横屏手机、小屏设备、或键盘弹出时注册/登录框的顶部会消失。

**修法**：
```css
.modal-mask { overflow-y: auto; padding: 16px; align-items: flex-start; }
.modal, .modal-auth { margin: auto; max-height: none; }
```
或保留居中但加 `@media (max-height: 640px) { .modal-mask { align-items: flex-start; overflow-y: auto } }`。

### 6. 抽屉没有手势，也缺 `aria-expanded`

**证据**：`app.js:1948` `toggleSidebar()` 只由点击触发；`app.js` 全站 **0 处** `touchstart`/`pointerdown`。ESC 关闭只实现了 lightbox(`1527`) 与 auth 弹窗(`1963`)，**抽屉没有**。`hamburger` 按钮无 `aria-expanded`。

**症状**：只能点遮罩或再点 ☰ 关闭；从屏幕左缘右滑这个肌肉记忆无效。

**修法**：抽屉加横向手势（`touchstart` 记 `clientX`，`touchmove` 判定右滑位移 > 60px 且横向主导则关闭，`{ passive: true }`）；`toggleSidebar` 里同步 `setAttribute("aria-expanded", open)`；补 ESC 分支。

### 7. 52 处 `:hover` 未做触屏隔离 → 手指点完留下"粘住的高亮"

**证据**：`.card:hover .card-cover-img { transform: scale(1.06) }`(261)、`.social-link:hover`(747)、`.g-card:hover`(1084)、`.post-actions button:hover`(314) 等，均无 `@media (hover:hover)` 包裹。

**症状**：触屏上点过的元素会**保持 hover 态**直到点别处（如便签卡片歪着浮起不回落）。

**修法**：把纯装饰性 hover 归入
```css
@media (hover: hover) and (pointer: fine) { /* 现有 hover 规则 */ }
```
必要反馈（如 `:focus-visible`、`:active`）单独保留。

---

## P2 — 打磨项

8. **缺 `theme-color`**：移动端浏览器地址栏不跟随暖米色主题，深色模式下尤其割裂。
   加 `<meta name="theme-color" content="#FFFAF4" media="(prefers-color-scheme: light)">` 与深色一条。

9. **缺 `-webkit-tap-highlight-color: transparent`**：每次点按有系统默认灰块闪烁，与奶油玻璃拟态质感冲突（可在 `html` 上设，同时用 `:active` 自己给反馈）。

10. **缺 `overscroll-behavior`**：弹窗/抽屉内滚到底会把整页带着橡皮筋抖动。建议 `.modal-mask, .sidebar { overscroll-behavior: contain }`。

11. **正文长 URL 可能横向溢出**：`.post-body` 无 `overflow-wrap`（评论 `.comment-text`(781) 有 `word-break: break-word`）。加 `overflow-wrap: anywhere;` 到 `.post-body` 即可，纯防御。

12. **便签墙窄屏挤成两列**：`style.css:1347` 在 ≤640px 强制 `repeat(2, 1fr)`，320px 宽屏下每列仅约 140px，长标题会断得很碎。建议 ≤380px 回落 `1fr`，或改 `repeat(auto-fill, minmax(150px, 1fr))`。

13. **字体请求可再瘦**：`Noto Serif SC` 请求 4 个字重（400/600/700/900）走第三方 `fonts.font.im`。CJK 子集即便按 `unicode-range` 切分，移动端仍不小，且多一个第三方域（多一次 DNS+TLS）。可砍到 400/700 两档（Bento 风格主要用 700/900 做标题，400 做正文，600 可省）。

14. **`assets/logo.jpg` 476KB 未跟踪残留**（上次 logo 调整留下，未被任何页面引用）。建议删除，避免误提交进仓库。

15. **无 `-webkit-text-size-adjust`**：个别安卓浏览器横屏时会自作主张放大正文字号，加 `-webkit-text-size-adjust: 100%` 可锁定。

---

## 建议实施顺序

| 批次 | 内容 | 收益 |
|---|---|---|
| 第 1 批（P0，小改动大收益） | #1 农历懒加载 + #3 输入框 16px + #2 dvh/安全区 | 省 87KB、消除 iOS 缩放与抽屉被切 |
| 第 2 批（P1） | #4 触控尺寸 + #5 弹窗可滚 + #6 手势/aria + #7 hover 隔离 | 可用性明显提升 |
| 第 3 批（P2） | #8~#15 | 质感与健壮性打磨 |

每批完成后跑 `bash scripts/run-all.sh`，并考虑为 #1（农历不得在移动端自动加载）与 #3（输入框 ≥16px）补守护断言。
