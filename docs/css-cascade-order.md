# CSS 层叠顺序 与 块级盒子的水平位置（一个真病历 + 一次被判错的「病历」）

`style.css` 是**逐段追加**长出来的，同一个选择器在不同位置被覆盖过多次。
本文记两件事：一个是「写了但从未生效」的真 bug，另一个是**被当成 bug 修掉、又被用户退回**的版式选择。
守护：`scripts/verify-mobile-guards.mjs` 第 `[12]` 节。

---

## 病历 ①：窄屏 60px 是**死规则**（真 bug）

### 现象
`.hero-avatar` 的窄屏尺寸写着 `60px`，但手机上量出来一直是 **72px**。

### 根因：同优先级下，**后写的赢**（不论在不在 `@media` 里）
两处规则**顺序反了**：

```css
/* 文件前段（约 674 行）—— 在 @media (max-width: 980px) 块内 */
.hero-avatar { width: 60px; height: 60px; }

/* ... 400 多行之后 ... */

/* 文件后段（约 1085 行，现约 1087 行）—— 无条件 */
.hero-avatar { width: 72px; ... }
```
两条规则**特异性相同**（都是单个类选择器），`@media` **不增加特异性**。
后出现的无条件 72px 直接盖掉前面断点里的 60px ⇒ 窄屏覆盖从来没生效过。

> 这是「媒体查询里写了的规则一定生效」这个直觉的反例。
> `@media` 只决定**是否参与层叠**，不决定**谁赢**。

### 修法
把窄屏覆盖挪到基样式**之后**的 `@media (max-width: 980px)` 块里
（本仓库放在「移动端布局补充」块）：
```css
@media (max-width: 980px) {
  ...
  /* Hero 头像窄屏尺寸：必须落在 .hero-avatar 基样式**之后**才生效 */
  .hero-avatar { width: 60px; height: 60px; }
}
```
原位置留一行注释指路，避免下次又被挪回去。

---

## 「病历」②：`.hero-avatar` 贴左 —— 这是**选定版式**，不是 bug

### 现象
首页 hero 是 `text-align: center`：`h1`「记录与思考」、描述、农历行、搜索框都在正中，
**唯独太极图头像贴在左上角**。

### 曾把它当 bug 修掉，用户看后要求退回
`text-align` 是**行内内容**的对齐属性，**管不了块级盒子**。
头像是 `display: block` + 固定宽度，其水平位置只由 `margin-left/right` 决定 ——
少了 `auto` 就贴左边缘。**这个因果分析是对的**，于是当时把 `margin` 改成 `0 auto 14px` 居中了。

用户看到居中版后明确要求：**退回「头像贴左上角、标题居中」**。
所以现在的 `margin: 0 0 14px` 是**刻意**的，不是漏写 —— 别再当 bug 修。

```css
/* 现在（刻意贴左） */
.hero-avatar { ... display: block; ... margin: 0 0 14px; }
```

### 实测（真浏览器 Edge + CDP，`node .diag/avatar-probe.mjs 1280 800 desktop`）
| | 贴左（现状/选定） | 居中（被退回的那版） |
|---|---|---|
| 头像 box | 72×72 @ x=361 | 72×72 @ x=596.5 |
| 自身中心 `cx` | 397 | 632.5 |
| 父 `.hero-text` 内容盒中心 | 632.5 | 632.5 |
| **偏移** | **-235.5**（= 贴左） | **0**（= 居中） |
| 移动端 390 | x=37，偏移 -128 | x=165，偏移 0 |

### 教训
**「元素中心 ≠ 父内容盒中心」不等于 bug。** 它只说明「没居中」，
是不是问题取决于**版式意图**。布局审计脚本报「❌ 没居中」时，
先确认意图，别直接改 —— 这次就是改对了因果、改错了结论。

---

## 怎么判定「哪一条真正生效」

**不要用「文件里有没有写」当判据** —— 病历 ① 就是「写了但没生效」。
要按**层叠顺序**算。`verify-mobile-guards.mjs [12]` 的做法（纯字符串分析，不需要浏览器）：

1. **剥注释，但用等长空格替换**（`m => " ".repeat(m.length)`）——
   注释里会**提到** `.hero-avatar`（解释为什么这么写），直接删会让 `match.index` 漂移；
   不剥则注释文字会被当成选择器（本仓库踩过这个坑）。
2. **算 `@media` 的括号范围** —— 用真括号匹配（`{` 计数到 0），
   不能正则「找到下一个 `}`」（`@media` 块里的大括号会嵌套）。
3. **逐条选择器比对**，不要整段字符串 `includes`：
   把 `rule[1].split(",").map(trim)` 后要求**恰好等于** `.hero-avatar`，
   否则 `.x .hero-avatar` 这类后代选择器会混进来。
4. **判定生效的那一条**：无 `!important` 时，最后一条设该属性的规则赢；
   断言它落在 `(max-width: 980px)` 里、且位置在 base 规则之后。
5. **水平 margin 兼容简写与长写**（`margin: a b c` / `margin-left`），
   两种写法都要能读出左右值，否则「简写看着没事、长写偷偷居中」会漏判。

### 口径自证（四条，缺一不可）
```js
heroAvatarSafe(GOOD) === true                 // 贴左 + 窄屏在后 → 判绿（证明口径不是恒 false）
heroAvatarSafe(BAD_ORDER) === false           // 窄屏在前 → 判红（正是病历 ①）
heroAvatarSafe(BAD_CENTER) === false          // margin: 0 auto 14px → 判红（被用户退回的那一版）
heroAvatarSafe(BAD_CENTER_LONGHAND) === false // margin-left: auto → 判红（长写偷偷居中）
```
只写负向自检不够：如果函数恒返回 `false`，负向自检也会「通过」。**正向样本必须存在**。

---

## 顺带：首页有两个太极图头像

| 位置 | 元素 | 尺寸 | 水平位置 |
|---|---|---|---|
| 侧边栏 `.brand` | `img.avatar` | 56×56 | flex 行内左对齐（**正确，别「修」**） |
| 首页 hero | `img.hero-avatar` | 72px（窄屏 60px） | **贴左**（选定版式，见上） |

两者 `md5` **相同**（`e5eca03979eafb2487c6906edd17410b`）—— `assets/logo-avatar.png`
与 `assets/logo-hero.png` 是同一张图。

已确认**保留双头像**：侧边栏那个在 flex 行里左对齐、移动端收进抽屉；
hero 那个是首屏唯一可见的。

⚠️ `.diag/avatar-probe.mjs` 会把**两处都**报「贴左」—— 侧边栏那个是误报
（它测「元素中心 vs 父内容盒中心」，对 flex 行内的子项不适用）；
hero 那个是**符合预期**，不是缺陷。**这个脚本只回答「居没居中」，不回答「该不该居中」。**

---

## 复现命令
```bash
# 量线上（当前部署版本）
node .diag/avatar-probe.mjs 1280 800 desktop
node .diag/avatar-probe.mjs 390 844 mobile

# 量本地未部署版本（/api/* 会 404，但头像在 index.html 里，不依赖 JS 注入）
node .diag/avatar-probe.mjs 1280 800 desktop local
node .diag/avatar-probe.mjs 390 844 mobile local
```
输出 `JSON` 含每个头像的 `box` / `centering`（自身中心 vs 父内容盒中心的偏移）/
`hitTest`（中心点上最顶的元素是不是自己）/ `visible`，
并落图到 `.diag/out/avatar/`。
