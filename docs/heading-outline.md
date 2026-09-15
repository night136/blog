# 标题层级：文章页的 h1 该是谁

> 2026-09-15 实施。目标：**一页一个 h1，而且是「这一页的主题」**。
> 相关：`docs/seo-crawler-render.md`（爬虫拿正文）、`docs/site-review-2026-09.md`。
> 回归：`scripts/verify-heading-outline.mjs`（55 项，含 8 项负向验证）。

## 一、问题：文章页有两个 h1，而且两边都不对

改之前，站点名在侧边栏里是 `<h1>昉昕</h1>`，而侧边栏**挂在每一个视图上**。于是：

| 位置 | 改前 | 问题 |
|---|---|---|
| 侧边栏站点名 | `<h1>昉昕</h1>` | 每个视图都有，文章页因此出现第二个 h1 |
| 文章标题（前端 `app.js`） | `<h2>` | 和正文小标题**同级**——「文章」和「章节」一样大 |
| 文章标题（爬虫片段） | `<h2>` | 同上，且与 `<title>`/`og:title` 的主题不一致 |
| 正文 `# ` / `## ` | `<h2>` | 与文章标题撞级 |
| 侧栏小部件标题 | `<h4>` | 从 h1 直接跳到 h4，跳两级 |

搜索引擎判定页面主题时会看 h1；站点名和文章标题同时是 h1，等于把「这个站叫什么」和
「这页在讲什么」混为一谈。

## 二、决定：每个视图一个 h1，就是该页的主题

| 视图 | h1 | 原来的层级 |
|---|---|---|
| 首页 | `记录与思考`（hero） | h2 |
| 归档 | `归档` | h2 |
| 留言墙 | `留言墙` | h2 |
| 关于 | `关于` | h2 |
| 会员专区 | `👥 会员专区` | h2 |
| 文章页 | **文章标题** | h2 |
| 404 页 | `404` | 已是 h1（独立文档，不受影响） |

站点名降级为**无语义容器** `<div class="brand-name">`：它是「站点身份」，不是「本页主题」。
每个视图是一个 `<section>`，h1 在 section 作用域内，所以 DOM 里同时存在 5 个 h1 并不违反规范
（只有 `.active` 的那个可见）。

## 三、为什么不能只改一处：三处耦合

「文章标题是 h1」这一句话，牵动三个地方，任何一处单独改都会留下不一致：

1. **HTML/JS 标签** —— `app.js` 的 `openPost()`（完整渲染 + 骨架屏）与
   `scripts/lib/seo-render.mjs` 的 `buildArticleHtml()`（构建期给爬虫的片段）。
   两边必须一致，否则同一个 URL 对爬虫和真人是两套大纲。
2. **样式选择器** —— `.hero h2` → `.hero h1`、`.page-head h2` → `.page-head h1`、
   `.card h3` → `.card h2` …… 以及最关键的 `.post-detail h2` → `.post-detail > h1`。
3. **正向层级连带** —— 文章标题占掉 h1 之后，正文的 `# ` / `## ` 落 h2 刚好接得上
   （`### ` 落 h3）。`mdToHtml()` **永不产出 h1**，从结构上杜绝「正文里冒出第二个 h1」。

## 四、`.post-detail h2` 的坑：后代选择器会泄漏

旧写法是**后代选择器**：

```css
.post-detail h2 { font-size: 32px; font-weight: 900; letter-spacing: .5px; margin-bottom: 14px; }
```

`h2` 在 `.post-body` 里面，也是 `.post-detail` 的后代 —— 这条规则**同时命中了正文小标题**，
把标题的字号、字距、`margin-bottom` 泄漏到二级标题上。改之前之所以看不出问题，
只是因为 `.post-body h2` 恰好写在源码后面（同特异性、后者胜）才盖回去；样式顺序一调整就翻车。

现在锁定为直接子元素，并顺手消掉这个隐患：

```css
.post-detail > h1 { font-size: 32px; font-weight: 900; letter-spacing: .5px; margin-bottom: 14px; }
```

顺带把「衬线标题」那条规则从**类名清单**改回**元素选择器**：

```css
/* 改前：h1, h2, h3, .hero h2, .slide-title, .post-detail h2, .page-head h2, .brand-text h1, … */
/* 改后：h1, h2, h3, .brand-name, .compose-meta #composeTitle */
```

旧写法把「元素层级」抄成了类名清单（`.hero h2` 本身就是 `h2`，纯冗余），
层级一动就漏改；元素选择器天然覆盖全部标题，只有 `.brand-name`（已不是标题元素）
要单独补字体。

## 五、实现清单

| 文件 | 改动 |
|---|---|
| `index.html` | 站点名 `h1` → `<div class="brand-name">`；5 个视图页标题 `h2` → `h1`；4 个小部件标题 `h4` → `h2`；`写一张便签` / 分享面板标题 `h3` → `h2` |
| `assets/app.js` | 文章标题 `h2` → `h1`（完整渲染 + 骨架屏）；卡片 / 轮播 / 会员卡 / 评论块标题 `h3` → `h2`；`mdToHtml` 注释说明 h1 归文章标题 |
| `assets/style.css` | 标题选择器全部跟随新层级；`.post-detail h2` → `.post-detail > h1`；进场动画 `.post-detail.post-anim > h1`；衬线规则简化为元素选择器 + `.brand-name`；`.brand-text h1` → `.brand-text .brand-name` |
| `scripts/lib/seo-render.mjs` | `buildArticleHtml()` 的标题 `h2` → `h1`（否则爬虫看到 h2、真人看到 h1） |
| `scripts/verify-seo-render.mjs` | 夹具不再手抄 HTML，改由 `buildArticleHtml()` 生成（防夹具与真实现漂移） |

**视觉零变化**：`style.css` 有全局 reset（`* { margin: 0; padding: 0 }`），
`h1` 与 `div` 都是块级、无默认边距；每条 `X h3` 规则都一一对应改成了 `X h2`，
而元素也确实变成了 `h2` —— 计算后的样式不变。

## 六、已知边界

- **SPA 的所有视图都在同一个 HTML 里**，所以爬虫请求文章页时，文档里仍能看到 5 个
  静态 h1（首页/归档/留言墙/关于/会员），文章标题的 h1 排在第 6 个。
  这不违反 HTML 规范（每个 h1 在各自的 `<section>` 作用域内），
  但若想进一步强化，可选的后续动作是：边缘函数只对爬虫请求裁掉非当前视图，
  或把 `view-post` 挪到 `<main>` 首位（对真人无视觉影响，因为只有 `.active` 可见）。
- **文章页的 h1 依赖运行时**：真人由 `app.js` 渲染，爬虫由边缘注入的片段提供。
  若文章是构建后才发布的（映射表里没有它），爬虫只能拿到 meta、拿不到正文与 h1 ——
  这是 `docs/seo-crawler-render.md` 已记录的行为，不是本次引入的。

## 七、回归

`scripts/verify-heading-outline.mjs`（55 项，已接入 `run-all.sh`）：

- **[1]** 每个视图恰好一个 h1 且文本正确；`view-post` 静态壳不得有 h1；
- **[2]** 站点名不再占 h1，侧边栏 / 右栏 / 顶栏均无 h1；`.brand-name` 的字体与字号有人接手；
- **[3]** 小部件标题统一 h2，`index.html` 不再出现 h4/h5/h6；
- **[4]** `app.js`、骨架屏、爬虫片段三处的文章 h1 一致；h1 是 `.post-detail` 的直接子元素；
- **[5]** `.post-detail` 无后代式标题选择器；样式表的标题选择器与 **16 条白名单**整集一致
      （白名单比对比「逐个列旧选择器」彻底：漏改的那条即使不在清单里也会作为「多出」暴露）；
- **[6]** `mdToHtml` 与 `renderMarkdown` 都不产出 h1，且对同一样本输出一致；
- **[7]** index.html 大纲无跳级；
- **[8]** 8 项负向验证：把改动「改回旧写法」，上面的检测必须报警
      （写负向验证时自己踩到两次坑，已记在脚本注释里：
      `String.replace` 只替第一处；`Number("h1")` 是 `NaN` 会把跳级静默判成没跳级）。
