# 让爬虫拿到文章正文（dynamic rendering）

> 2026-09-15 实施。目标：**百度/搜狗能收录文章正文**。
> 相关：`docs/site-review-2026-09.md` 待办第 2 项「爬虫拿不到正文」。

## 一、问题（线上实测）

本站是 SPA，`/?post=<slug>` 的正文完全由前端 JS 渲染。而搜索引擎爬虫**不执行 JS**。
用百度蜘蛛 UA 实测线上（`2026-09-15`）：

```
$ curl -A "Baiduspider/2.0" "https://blog-6p3.pages.dev/?post=2026-09-13-心理学的领域-atn2"
```

| 项 | 实测结果 | 后果 |
|---|---|---|
| `#postDetail` 容器 | **空** | 正文一个字都抓不到，文章进不了索引 |
| `<title>` | `昉昕的博客 · 记录与思考`（站点名） | 搜索结果里每篇文章的标题都显示成站点名 |
| `<link rel="canonical">` | **两条**：首页一条 + 文章一条 | 搜索引擎会据此把文章判为首页副本，等于放弃收录 |

只有 `og:*` / JSON-LD 是好的（那是上一轮修的分享卡片），但**社交分享和搜索收录是两回事** ——
有卡片、没正文，对 SEO 毫无帮助。

### 关于双 canonical 的成因

`functions/index.js` 的注入逻辑是「整块替换 `<!--OG-DEFAULT-START-->…<!--OG-DEFAULT-END-->`」，
而 `index.html` 里站点级的 `canonical` / `description` / `author` 三行**写在块外面**，
替换 OG 块时它们被原样留下，于是文章页同时存在：

```html
<link rel="canonical" href="https://blog-6p3.pages.dev/" />            <!-- 站点级，块外，没被换掉 -->
<link rel="canonical" href="https://blog-6p3.pages.dev/?post=xxx" />   <!-- 文章级，注入的 -->
```

## 二、方案与取舍

### 正文渲染放在构建期，不放边缘

| 方案 | 结论 |
|---|---|
| 边缘读 D1 的 `body` 现渲染 | ❌ Pages Functions 免费版 CPU 预算只有 **10ms 量级**，而单篇 `body` 实测 **147KB**（99% 是内嵌 base64 图）。取回 + 解码 + 替换 + 逐行渲染极易超预算，还要把整段 base64 拉进 Worker 内存 |
| **构建期预渲染成静态片段，边缘只读片段** | ✅ 构建期无 CPU 限制；片段仅 0.6KB 且可缓存；边缘只做「读 + 注入」 |

### 只对爬虫注入，不改真人路径

保留 UA 判断（真人请求直接 `next()` 放行）。真人访问路径零改动、零风险，
爬虫单独走「注入版」。这不是 cloaking —— 见下。

反过来说，**「对所有请求都 SSR」曾是一个候选方案**（真人首屏也能更快、不依赖跨境网络加载 JS），
但需要改 `app.js` 的渲染时序避免闪烁，改动面大，本次不做。

### ⚠️ 这不是 cloaking

注入的正文与真人看到的是**同一份内容**：同一份 markdown、同一套渲染规则。
`scripts/verify-seo-render.mjs` 会把两边输出逐条比对（见 §5），
从机制上防止「爬虫版」和「真人版」漂移成两套内容。

## 三、数据流

```
构建期（build.mjs，每次部署跑一次）
  D1 posts.body
    ├─ materializeBodyImages()  正文里的 data: base64 图 → /generated/body-images/<内容哈希>.<ext>
    └─ renderMarkdown()         markdown → HTML（与前端 mdToHtml 同规则）
         ↓
    generated/post-html/<sha256(slug)前16位>.html   每篇一个片段（纯 ASCII 文件名）
    generated/post-html.json                        slug → 片段路径 的映射表

边缘（functions/index.js，爬虫请求 /?post=<slug>）
  读映射表（isolate 缓存 5 分钟）→ 读片段（isolate 缓存 5 分钟）→ injectArticle()
    ├─ ① 替换 <title> 为「文章标题 · 站点名」
    ├─ ② 整块替换 OG 区（含 canonical / description / author，不再是双份）
    └─ ③ 把片段塞进 <!--SSR-BODY-START-->…<!--SSR-BODY-END-->
```

## 四、关键决策与踩过的坑

| 决策 | 原因 |
|---|---|
| 片段文件名用 **slug 哈希**，不用 slug | slug 含中文；Pages 对非 ASCII 静态资源名不可靠（本项目线上实测过「映射表登记了、文件却 404」）。映射表负责 slug → 路径，任何一方都不从文件名反推 |
| 站点级 `canonical`/`description`/`author` **移入 OG 块内** | 这是双 canonical 的根因。块外的东西不会被整块替换掉。回归脚本 [10] 专门钉住「块外不许再有这三个标签」 |
| 正文内嵌 base64 图**落盘成静态文件** | 一是爬虫无法把 `data:` URI 当图片抓（图片搜索收不了），二是 base64 会把单篇响应从 0.6KB 撑到 147KB |
| 落盘图扩展名按 **MIME 子类型**取，不 `split("/")[1]` | 踩过：正则捕获组拿到的已经是 `jpeg`，再 split 一次得到 `undefined` → 静默落到 `png` 兜底，把 JPEG 存成 `.png`，而 Pages 按扩展名发 `Content-Type`，等于对外宣称了错误类型 |
| `data:image/svg+xml` **不落盘** | svg 是唯一能执行脚本的图片格式，前端 `safeUrl()` 会拒收它并降级成纯文本。若这里落盘成可访问文件，爬虫看到图、真人看到文字，两边就不一致了 —— 原样交给渲染器走同一条降级路径 |
| 爬虫 UA 兜底**不用 `\b` 词边界** | 踩过：`YisouSpider`（神马）里 `uS` 之间不构成词边界，加 `\b` 会漏判。宽松匹配的代价最多是给某个名字含 `bot` 的客户端多注入几 KB 文本；漏判等于文章不被收录 |
| 缓存里也写 `X-SSR-Body` | 踩过：只在返回的响应上加了标记，写进 `caches.default` 的那份没加 → 命中缓存时读到 `0`，线上排查会误判成「没注入正文」 |
| 边缘**不做**渲染 | 同上，CPU 预算 |

## 五、验证

### 回归：`scripts/verify-seo-render.mjs`（59 项，已入 `run-all.sh`）

直调 `onRequestGet`（mock ctx/env/内存 ASSETS/可读写的 `caches.default`），覆盖：

- **注入**：正文进容器、多段完整、`X-SSR-Body: 1`
- **title**：等于「文章标题 · 站点名」，且站点默认 title 不残留、`<title>` 只出现一次
- **canonical 唯一**：恰好一条且指向文章；`description` / `author` 各一条
- **OG / JSON-LD 完好**
- **真人不受影响**：浏览器 UA、`curl` 均放行
- **未知爬虫**：`YisouSpider`、名字含 `crawler` 的新爬虫也能拿到正文
- **降级不崩**：无 `?post=`、无 `DB`、文章不存在、映射表缺失、片段 404、文章是构建后才发布的（映射表没有它）
- **路径白名单**：编码式目录穿越 `%2e%2e%2f`、非 `.html`、无扩展名一律拒
- **边缘缓存**：MISS → HIT，且 HIT 时正文与标记都还在
- **index.html 结构守护**：站点 canonical/description/author 必须在 OG 块内、块外不许有第二条
- **渲染一致性**：从 `app.js` 截取 `mdToHtml`/`safeUrl` 在 `Function` 里执行，与构建期渲染器对 **20 组样本**逐条比对（含 XSS、`data:` 图片边界、`javascript:` 链接、svg）
- **内嵌图落盘**：扩展名与 MIME 对应、字节一致、同图只落一份、svg 不落盘

### 负向验证 8/8

把实现改回错误写法，断言必须失败。全部拦住：

| 场景 | 被拦住的断言 |
|---|---|
| ① 完全不注入正文 | 正文已进入 #postDetail 容器 |
| ② `<title>` 不替换 | title = 文章标题 · 站点名 |
| ③ 站点 canonical 挪回块外 | 站点 canonical 在 OG 块内部 |
| ④ 去掉片段路径白名单 | 编码式目录穿越被拒 |
| ⑤ 去掉爬虫 UA 兜底 | YisouSpider 也注入正文 |
| ⑥ 写缓存不带 `X-SSR-Body` | HIT 时 X-SSR-Body 被透传 |
| ⑦ 渲染器少转义双引号 | 两边输出逐条一致 |
| ⑧ 内嵌图扩展名取错 | JPEG 内嵌图落盘为 .jpg |

> ⚠️ 场景 ④ 第一次**没被拦住**：mock 的 ASSETS 对任何非预期路径都返回 404，
> 于是「路径被拒」实际是 404 挡的，白名单删掉也测不出来。
> 改成「`/generated/post-html/` 下默认一律 200」后，只有白名单能挡住非法路径。
> 另外最初用的穿越载荷 `../../etc/passwd` 会被 URL 规范化成 `/etc/passwd`，
> 同样绕过白名单 —— 换成编码形式 `%2e%2e%2f` 才真正测到白名单。
> **教训：断言通过 ≠ 断言有效，必须做负向验证。**

## 六、体积影响

| 产物 | 大小 |
|---|---|
| 单篇正文片段 | **0.65KB**（源 body 147.4KB，去掉 base64 后压缩 99.9%） |
| 爬虫拿到的完整 HTML | 30KB 左右（与原来基本持平，只是容器里多了正文） |
| 正文内嵌图 | 单独落盘，文件名 = 内容哈希，可长缓存 |

## 七、上线与验收

1. 部署后（Pages 控制台 **Deploy latest**），用爬虫 UA 验证：

```bash
UA="Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)"
SLUG="<文章 slug，URL 编码>"
curl -sS -A "$UA" -D- "https://blog-6p3.pages.dev/?post=$SLUG" | grep -E "X-SSR-Body|<title>|canonical"
curl -sS -A "$UA" "https://blog-6p3.pages.dev/?post=$SLUG" | grep -c "正文里的某个词"
```

期望：`X-SSR-Body: 1`；`<title>文章标题 · 昉昕的博客</title>`；canonical 一条且指向文章；正文关键词能命中。

2. 到百度搜索资源平台提交 `sitemap.xml`（`/sitemap.xml` 已在，robots 也指向它），并「抓取诊断」。

## 八、已知局限

- **构建滞后**：片段来自构建期。文章发布后若 Deploy Hook 未触发（本项目 GitHub→Cloudflare webhook 长期失效，需手动 Deploy latest），
  则该篇暂时只能注入 meta、拿不到正文（`X-SSR-Body: 0`）。不会报错，其余文章不受影响。
- **只覆盖 `?post=` 这一种地址**。`/generated/posts/<slug>.json` 等快照路径本来就可被爬虫直读。
- **真人仍是 CSR**：正文首屏依赖 JS 与跨境网络。彻底解决需要 SSR，见 §2。
