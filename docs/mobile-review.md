# 移动端专项审查（2026-09-12）

审查范围：`index.html`、`assets/style.css`(1351 行，6 处媒体查询)、`assets/app.js`、`_headers`。
所有结论均来自代码实证，未凭印象推断。

## 实施状态

| 批次 | 状态 |
|---|---|
| P0（#1 农历懒加载 / #2 dvh+安全区 / #3 输入框 16px） | ✅ **已实施**（2026-09-12） |
| P1（#4 触控尺寸 / #5 弹窗可滚 / #6 手势与 aria / #7 hover 隔离） | ✅ **已实施**（2026-09-12） |
| P2（#8 ~ #15） | ⬜ 待做 |

P0 / P1 的落地细节与守护断言见文末「P0 实施记录」「P1 实施记录」。

---

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

**进展**：第 1 批（P0）与第 2 批（P1）均已完成，守护断言已并入 `verify-mobile-guards.mjs`。

---

## P0 实施记录（2026-09-12）

### #1 农历库改为按需加载
- `app.js`：删除无条件注入的 IIFE；新增 `isNarrow()`（`matchMedia("(max-width: 980px)")`）、
  `lunarLibState`、`loadLunarLib()`、`tickClock()`、`renderLunarDetails()`。
- 宽屏：`requestIdleCallback`（超时 2s 兜底）自动加载 —— 与原行为一致，且不再抢首屏。
- 窄屏：**不加载**。hero 那行先用本地地支推算显示 `🕐 申时 15:04:07`，并挂一枚「查农历」小胶囊；
  点击才加载库并升级为干支/农历月日。库加载失败时可点按重试。
- 顺带修掉两个隐藏浪费：
  - 原 `updateLunar` 被 **两个** 秒级定时器各调一次 → 合并为单一 1s 定时器。
  - 原实现每秒重算节气并**重建 42 个日历格子**（`Lunar.fromYmd` × 31 + `innerHTML`）→
    拆出 `renderLunarDetails()`，按日缓存，且窄屏（右侧栏 `display:none`）直接短路。
- 删掉「5s 后降级为 `—`」的兜底：现在未加载时本来就有意义的时钟，不再需要。

### #2 dvh + 安全区
- `index.html` viewport 加 `viewport-fit=cover`。
- `.sidebar` / `.compose-full` 加 `100dvh` 回退（`100vh` 在前）。
- `.hamburger` 用 `max(9px, env(safe-area-inset-top))`、`.content` 底部补
  `env(safe-area-inset-bottom)`、`.topbar-inner` 补左右安全区。

### #3 触屏输入框 ≥16px
- 在 `style.css` **文件末尾**新增 `@media (max-width: 980px)` 专用块，覆盖
  search / compose / auth / guestbook 全部输入控件。

### ⚠️ 两个顺序陷阱（已写进守护断言）
1. `.topbar-inner` 的 `padding: 0 14px` 简写会重置安全区 —— 安全区声明必须写在它**之后**。
2. 触屏字号块必须放在组件自身字号规则**之后**（`style.css` 末尾），
   否则同特异性下会被 `.guestbook-form input{14px}` 覆盖。

### 新增回归
- `scripts/verify-mobile-guards.mjs`（**27 项**）：源码级约定守护（含上述两个顺序断言）。
- `scripts/verify-lunar-boot.mjs`（**9 项**）：**行为级**验证 —— 在 vm 里真跑 app.js，
  按窄/宽屏与「是否点击」四种组合断言 `lunar.js` 的请求次数、hero 行内容、秒级定时器个数。
- 两者均做过负向验证（6 + 1 个回退场景，全部能拦住）。
- 已接入 `scripts/run-all.sh`，全套 **7 秒**跑完。

---

## P1 实施记录（2026-09-12）

### #4 触控目标 ≥44×44
- `style.css` **文件末尾**新增 `@media (pointer: coarse)` 块（用**指针能力**而不是宽度断点：
  iPad、横屏手机、触屏笔记本同样适用；放末尾才能靠「后来居上」覆盖组件自身的 32px / 11px）。
- 两类处理，避免无脑放大破坏布局：
  - **只扩热区、视觉不变**：`.theme-toggle` / `.social-link` / `.modal-close` 用
    `::after { width: max(100%, 44px); height: max(100%, 44px) }` 撑出 44×44。
    `.theme-toggle` 与 `.social-link` 需补 `position: relative`；`.modal-close` **本身已是
    absolute，绝不能改 position**（会脱出弹窗定位）—— 这条写进了断言。
  - **直接放大真实尺寸**：编辑器工具按钮 32→**40px**（`gap` 同时 6→8px），
    `.theme-toggle` 42px、`.social-link` 40px。
- 正文/评论操作按钮：`.post-actions button` 等 11~12px → **13px**，
  并给 `.post-actions button / .comment-like / .comment-reply / .share-btn / .back-btn` 加 `min-height: 40px`。
- **便签删除按钮刻意不做 44 热区**：`.g-del` 提到 30px 即可。便签是密集网格，
  44px 的隐形热区会溢出到相邻便签 → 容易误删。

### #5 弹窗矮屏可滚
- `.modal-mask` 去掉 `align-items: center`（flex 居中会让溢出**同时向上下**发生，
  向上那部分**永远滚不到**），改为 `overflow-y: auto` + 子项 `.modal, .modal-auth { margin: auto }`
  —— auto 外边距「有富余才吸收、没富余归零」，等价于**安全居中**。
- 顺带补 `overscroll-behavior: contain`（弹窗滚到底不带着整页橡皮筋）。
- **坑**：水平内边距只能给 0 —— `.modal-auth` 宽度已是 `96vw`，加左右 padding 会横向溢出
  （`overflow-y:auto` 会把 `overflow-x` 一并算成 auto，直接出横向滚动条）。最终用 `padding: 16px 0`。

### #6 抽屉手势 / aria-expanded / ESC
- 新增 `setSidebar(open)` 作为**唯一出口**：class、遮罩、`body` 滚动锁、两个汉堡按钮的
  `aria-expanded` 全部在此同步；`toggleSidebar` 改为它的薄封装。
  `showView()` 里原先手写的三件套也收敛到 `setSidebar(false)`（避免漏掉 aria / 滚动锁）。
- 右滑关闭手势：`touchstart` 记起点 → `touchmove` 判定「右移 > 60px 且横向位移 > 纵向 ×1.5」才关，
  纵向位移一旦 > 40px 立即放弃（让位给抽屉自身滚动）；四个监听全部 `{ passive: true }`。
- ESC 改为逐层关闭：**抽屉 → 登录弹窗**（灯箱另有独立监听）。
- `index.html`：两个汉堡按钮补 `aria-controls="sidebar"` + `aria-expanded="false"`。
- 附带：`hamburgerTop` 的元素引用从 CSS 选择器段上移到顶部统一声明，避免函数作用域 TDZ 隐患。

### #7 hover 触屏隔离（52 条规则）
- **做法**：把所有 `:hover` 规则**原地**包进 `@media (hover: hover) and (pointer: fine)`。
  「原地」是关键 —— 不改变规则在源码中的相对顺序，因此**层叠顺序与特异性完全不变**，
  不会出现「hover 被挪到末尾后压过原本该赢的规则」这类隐蔽回归。
- 用一次性脚本完成（解析顶层/嵌套块、按顶层逗号切分选择器、括号配对），
  执行后自检：括号平衡 + `:hover` 总数不变（53 处）。
- **混合选择器必须拆分**：`pre:hover .code-copy, .code-copy:focus, .code-copy.copied { opacity: 1 }`
  → 前段进媒体查询，`:focus` / `.copied` 留在外面（否则触屏上复制按钮的焦点态会一起失效）。
- ⚠️ **连带可达性兜底**：原有两个按钮**只靠 hover 揭示**，隔离后在触屏上永远不可达，
  已在 `pointer: coarse` 块里常显：
  - `.code-copy { opacity: 1 }`（原 `pre:hover .code-copy`）
  - `.g-del { opacity: 1 }`（原 `.g-card:hover .g-del`）
  这两条是断言里的必查项 —— 以后新增「hover 才显示」的交互元素，必须同步补触屏兜底。

### 新增回归（P1）
- `verify-mobile-guards.mjs` 从 27 → **50 项**，新增 4 组：
  - `[6]` 弹窗：必须 `overflow-y:auto`、**不得**再有 `align-items:center`、子项 `margin:auto`、`overscroll-behavior`。
  - `[7]` 触控：`pointer:coarse` 块存在且在文件末尾、44 热区、`.modal-close` 不得被改成 `position:relative`、
    13px/40px 提升、两个 hover 揭示按钮必须常显。
  - `[8]` 抽屉：`setSidebar` 单出口 + aria 同步 + 手势的横向主导判定 + `passive` + ESC 覆盖 + `showView` 收敛 + HTML aria 属性。
  - `[9]` hover：**剥离所有 hover 媒体块后不得残留裸 `:hover`**（含去注释步骤，避免注释里的 `:hover` 误报）。
- 负向验证 **8 个回退场景全部拦住**（弹窗退回居中 / 删触屏块 / 删手势 / aria 不同步 / ESC 不管抽屉 /
  showView 退回手写 / 解开一条 hover / 混合选择器整体包裹）。
- 全量回归：`og 40 / xss 23 / jwt 18 / manage / cover 35 / asset 14 / frontend 15 / mobile 50 / lunar 9 / smoke`，**9 秒**跑完。
