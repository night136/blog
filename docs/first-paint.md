# 首绘与「打开文章」的关键路径

> 「不止农历挂件卡，文章和左侧列表也会卡」—— 2026-09-15 的排查与修复。
> 相关守护：`scripts/verify-first-paint.mjs`（45 项）；复测工具：`scripts/perf-probe.mjs`。
> 封面单独成篇：**阻塞与否、为什么不加载、怎么少下一次 → `docs/cover-delivery.md`**
> （封面不是渲染阻塞资源，但它是 LCP；同一张图曾占两个 URL、各下一份）。

## 怎么量的（别再靠猜）

装不了 puppeteer/playwright（要下 ~500MB Chromium，国内很慢），改为**直接驱动本机 Edge**：
`scripts/perf-probe.mjs` 用 CDP 打开页面，取 `performance.getEntriesByType()` 的真实数据。

```
node scripts/perf-probe.mjs https://blog-6p3.pages.dev/            # 冷缓存（全新 profile）
node scripts/perf-probe.mjs "https://blog-6p3.pages.dev/?post=<slug>" --warm
```

它同时会抓**控制台错误与未捕获异常** —— 这个项目的 P0 事故（TDZ 被 catch 吞掉）就是
「功能全错、控制台安静」，所以每次探针都顺手看一眼。

⚠️ **不要用 curl 的耗时直接下结论**：每次 `curl` 都要重新握手，跨境 TLS 就要 0.5~1.1s，
会把每个请求都算大 0.6s 左右。实测同一份 `posts.json`：curl 报 790ms，浏览器只用了 **179ms**
（复用了 HTTP/2 连接）。两者差的不是网络，是握手。

## 三个真因（按影响排序）

### ① 正文里的 base64 内嵌图（最大，也是「打开文章卡」的主因）

`generated/posts/<slug>.json` 直接用了 `row.body` —— 而正文里的图常是 base64 内联的。

| | 不含内嵌图的文章 | 含内嵌图的文章 |
|---|---|---|
| 篇数 | 9 / 16 | **7 / 16** |
| 平均详情体积 | 0.8KB | **530KB** |
| 最大一篇 | — | **1,148,543 字节（1.14MB）** |

一篇正文只有 68 字的文章，详情也有 151KB（全是那张图）。跨境网络下拉 1.1MB 的 JSON，
表现就是「点开文章愣好几秒」。

**改法**：`materializeBodyImages()` 早就写好了（把 base64 抽成
`/generated/body-images/<内容哈希>.<ext>`），只是**结果只喂给了爬虫片段**。
现在详情快照也用它 → 详情只剩几 KB，图片走独立文件：可被浏览器长期缓存（`immutable` 一年）、
可懒加载、也不再和正文抢同一个响应体。

### ② 两次纯装饰的请求挡在正文渲染之前（~600ms，且**永不缓存**）

`openPost()` 原先的顺序是：

```
静态详情(563ms 就到了) → await /api/me → await /api/posts/view → 才渲染(1171ms)
```

`/api/me` 只用来决定显不显示「编辑/删除」按钮，`/api/posts/view` 只是阅读数 +1 ——
与正文内容毫无关系，而且两者都是 `no-store`（**永远不走缓存**），所以**每次打开文章都要等**。

**改法**：先渲染正文，再由 `patchPostMeta()` 异步补齐。
另外 `/api/me` 实测会被请求**两次**（启动一次、打开文章一次），改用 `ensureSession()` 去重复用同一个 promise。

实测：正文 1171ms → **约 570ms**（暖缓存）。

### ③ 跨站渲染阻塞样式表（字体，冷缓存 ~400ms）

`<link rel="stylesheet" href="https://fonts.font.im/css2?...">`
未压缩 **339KB / gzip 91KB / 303 条 @font-face / 101 个子集**，是**跨站**资源，
而 `<link rel=stylesheet>` 会阻塞首绘 —— 于是首屏所有内容（文章、侧栏、挂件）一起等它：
实测冷缓存 FCP 从约 900ms 被拖到 **1296ms**。

**改法**：从 `index.html` 移出，由 `app.js` 在首绘之后（两层 rAF）动态注入。
动态插入的 `<link>` 不参与渲染阻塞，字体到达后由 `font-display:swap` 自然替换。

- ⚠️ **不要用 `media="print" onload="this.media='all'"`**：小米/360 兼容模式对该切换支持不良，
  会导致样式表永远不生效（项目已因此回滚过一次，见 `index.html` 里 style.css 上方那条注释）。
- ⚠️ 注入的 link 必须带 `data-optional="1"`，否则它加载失败会触发 `index.html` 的全局 error 监听、
  弹出「资源加载失败」横幅 —— 字体下不来不该吓用户。

### 顺带：骨架屏的微光动画

`.skeleton` 原来动 `background-position`（400% 宽的渐变 → 每帧重绘整块元素），
而骨架屏会连续显示数秒（等 `posts.json` / 封面图）。改成覆盖层 + `transform` 位移，
只走合成器。**这条是预防性的**：本机实测没有长任务掉帧证据，属于「顺手消掉的隐患」。

## ⚠️ 随之而来的硬约束：详情快照的 body 是构建产物

`generated/posts/<slug>.json` 里的 `body` 现在含 `/generated/body-images/…` 路径，
而**编辑器是从快照加载文章的**（`openCompose`）—— 拿它预填再保存，就会把产物路径写回 D1，
而 `generated/` 不入库、每次构建都可能改名甚至消失 → **原始图片永久丢失**。
这和封面那次是同一类事故（`3afafdd`），所以按同样的方式做了两道防线：

1. **前端**：点「编辑」一律从 `/api/posts/detail` 取**原始**正文再进编辑器；
   取不到就**不进编辑器**（宁可让用户重试，也不能拿快照正文顶替）。
2. **后端**：`manage.js` 加了绊线 `isBuildArtifactBody()` —— 正文里出现**图片形式**的
   `/generated/body-images/` 引用就直接 **400**。

第 2 条刻意选择「响亮失败」而不是像封面那样静默保留旧值：正文是用户这次真正在编辑的东西，
静默保留会让他以为改动生效了、实际白改。
判定只看**图片引用**（markdown `![]()` 或 `<img src=>`），不做全文匹配 ——
本博客就写技术文章，正文里完全可能出现这条路径的文字示例，全文匹配会误伤、把作者卡在保存不了。

### 一个已知取舍

`/generated/body-images/*` 是内容哈希命名、`immutable` 一年，但**旧文件会随新部署消失**。
若作者替换了某张图，而某个客户端还握着 SWR 期内的旧快照（最长约 24h），那张图会 404。
影响面很小（只有作者改图时、且只有旧快照），与封面原有的行为一致。
新发布的文章若还没构建，走 `/api/posts/detail` 降级路径，返回的是**原始**（含 base64）正文 ——
功能正常，只是没有这份优化。

## 线上实测对照（2026-09-15，本机 Edge + CDP）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 首页列表 + 左侧栏（暖缓存） | 368ms | 368ms（本来就快） |
| 文章正文（暖缓存） | **1171ms** | 预计 ~570ms |
| 首页 FCP（冷缓存） | **1296ms** | 预计 ~900ms |
| 单篇详情体积（含图文章） | **平均 530KB / 最大 1.14MB** | 预计几 KB + 图片独立缓存 |

> 后两列是「预计」：改动尚未部署，部署后用 `scripts/perf-probe.mjs` 复测并回填真实数字。

## 部署后请复测

```bash
node scripts/perf-probe.mjs "https://blog-6p3.pages.dev/?post=<任一含图文章>" --warm
```

看三个数：`文章正文` 出现时刻、`控制台错误` 是否为空、`/generated/posts/<slug>.json` 的传输字节。
