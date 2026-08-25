# 博客性能审计记录（2026-08-25）

> 适用站点：Cloudflare Pages 博客（Cloudflare Pages Functions + D1）
> 目的：定位「文章加载慢 / 首页卡顿 / 小米浏览器布局错乱」等问题的根因并优化。

---

## 一、CSS 体积分析（结论：不是瓶颈）

| 指标 | 数值 |
|---|---|
| `style.css` 源码体积 | 62.7KB / 964 行 |
| 去注释 + 折叠空白后 | ~52KB（占原始 85%） |
| gzip/brotli 线上实际传输 | **约 10–12KB**（压缩率 80%+） |
| 疑似未用选择器 | 34 个，全部为误报 |

**为什么 34 个「疑似未用」是误报**
- 30+ 个 `.hljs-*`：代码高亮主题类，highlight.js 运行时动态加到 `<code>`，静态扫描看不到但必用。
- `.like-burst` / `.read-progress` / `lightbox-open`：分别用于点赞粒子、顶部阅读进度条、图片灯箱（app.js 有引用）。
- `.toc-l3`：目录组件按标题层级动态生成 `.toc-l1/2/3`，存在三级标题时即用。

**结论**：源码无可安全删除的死规则；CSS 实际传输体积很小，不是瓶颈。

**建议**：**不要压缩源码**（会牺牲可读性、且 Cloudflare 边缘已能处理）。改去 Cloudflare 控制台 **Speed → Optimization → Auto Minify**，勾选 CSS/JS/HTML，由边缘节点自动压缩，效果等同手动压缩且源码保持可读。

---

## 二、已落地的性能优化（按收益排序）

| 优先级 | 优化项 | 做法 | 提交 |
|---|---|---|---|
| 🔴 最高 | 列表接口不再 SELECT body | `posts.js` 列表查询去掉 `body`，改用发布/更新时预存的 `words` 列；三分支均不再读大文本 | `e6fcaac` |
| 🟠 高 | 有图文章图片懒解码 | `app.js` 新增 `lazyLoadImages()`：base64 图先占位，滚到视口（`IntersectionObserver`, rootMargin 300px）才回填 src，首屏文字先出 | `c751cea` |
| 🟠 高 | `lunar.js` 436KB 动态加载 | 移除阻塞 `<script>`，改 `requestIdleCallback`（兜底 2.5s）空闲时再注入；库未加载时 widget 显示占位（已有 `typeof Lunar` 保护） | `1874cbc` |
| 🟡 中 | 列表接口边缘缓存 | 列表 `GET /api/posts` 返回 `Cache-Control: s-maxage=60, stale-while-revalidate=300` | `1874cbc` |
| 🟡 中 | 详情客户端缓存 + 会话只校验一次 | `postCache` 避免重复拉大正文；`sessionReady` 只请求一次 `/api/me` | `f643261` |
| 🟢 低 | 代码高亮延后 + 按需懒加载 | 仅当文章含代码块才加载 122KB highlight，且延后到正文绘制后执行，文字先出 | `f643261` |
| — | 首屏关键 CSS 内联（已回退） | 曾把变量/布局骨架内联、完整样式 `media="print" onload` 非阻塞加载，**在小米/360 上失败**，已回退为正常阻塞加载 | `9e979c5` |

---

## 三、小米/360 浏览器布局错乱事故与修复

**起因**：上一轮把 `style.css` 改为
```html
<link rel="stylesheet" href="assets/style.css" media="print" onload="this.media='all'">
```
意图非阻塞加载。但小米/360 兼容模式对 `media="print"` 切回 `all` 的 `onload` 支持不良，导致 `style.css` **一直停留在 print 状态、从未套用到屏幕**。

**表现**：卡片 `.card { opacity:0 }` 永不翻转 → 文章全空白；三栏桌面布局未加载、右栏 `.rightbar` 掉到主内容下方。

**修复（`9e979c5`）**：
1. `style.css` 改回**阻塞加载**（最稳妥）。
2. 关键规则内联到 `<head>` 作兜底：卡片入场动画 `cardIn` keyframes + `.card.in-view`，移动端 `@media (max-width:980px)` 三栏改单栏 + 隐藏 `.rightbar`。

**教训**：非阻塞 CSS 技巧（`media=print` + `onload`）在国产兼容浏览器上风险高，对 <70KB 的样式表不值得；宁可阻塞加载 + 内联关键兜底。

---

## 四、数据层收尾（需用户在 Cloudflare 控制台执行）

| 项 | 状态 |
|---|---|
| `scripts/migrate-views.sql`（`ALTER TABLE posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0`） | ✅ 用户已执行；打开文章 `views+1` 写入（`detail.js`）生效 |
| `scripts/migrate-words.sql`（`ALTER TABLE posts ADD COLUMN words INTEGER NOT NULL DEFAULT 0`） | ✅ 已通过 `scripts/backfill-words.mjs`（D1 REST API）回填 8 篇存量文章字数，新文章发布/更新自动算准 |
| `SITE_URL` 环境变量 | ⬜ 可选；`functions/_lib/seo.js` 兜底已改为 `https://blog-6p3.pages.dev`，不设也能跑 |

---

## 五、未采纳方案（与结论）

- **R2 对象存储外链图片**：用户无可用信用卡，放弃。图片外链化对 D1 瘦身有效，但非当前必需（前端懒解码已解决首屏卡顿）。
- **`assets/uploads/` 仓库静态托管外链**：零成本可行（目录已存在且未被 gitignore 忽略），但用户选择维持现状。
- **源码 CSS 压缩**：效益低且牺牲可读性，交由 Cloudflare Auto Minify 在边缘处理。

---

## 六、验证清单（小米浏览器）

1. 清缓存重开博客 → 首页文章卡片应由小变大淡入，布局单栏、无右栏。
2. 点开有图文章 → 标题文字先出，图片灰色占位后淡入。
3. 点开文章再回首页 → 卡片「X 阅读」+1；存量文章显示真实「约 N 分钟 · M 字」。
4. Cloudflare 控制台开 Auto Minify（CSS/JS/HTML）→ 线上静态资源自动压缩。
