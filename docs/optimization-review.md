# 博客优化审查（2026-09-11）

> 范围：Cloudflare Pages + Functions + D1 的个人博客
> 说明：性能部分已由 `docs/perf-audit.md` 覆盖，本报告聚焦**安全、SEO、功能缺陷、工程自动化**四个尚未审计的领域。
> 每项给出「现状 / 风险 / 建议做法 / 涉及文件」，可直接按条目执行。

---

## 一、概览

| 优先级 | 领域 | 条目 | 影响 |
|---|---|---|---|
| P0 | 安全 | JWT 密钥回退到公开默认值 | 身份可被伪造，最严重 |
| P0 | 安全 | 正文 Markdown 渲染属性注入 | 存储型 XSS |
| P1 | 安全 | 无速率限制 | 撞库 / 刷屏 |
| P1 | 功能 | 分享卡片封面失效 | 分享出去没图 |
| P2 | 安全 | Turnstile 软依赖 + 密码策略弱 | 垃圾注册 |
| P2 | SEO | 正文不被非 JS 爬虫收录 | 百度/微信搜不到 |
| P2 | 功能 | 正文内联图片未外置 | 详情 JSON 仍偏大 |
| P3 | SEO | URL 形式、sitemap、AI 爬虫 | 收录质量 |
| P3 | 工程 | 构建产物累积、就地改源文件 | 仓库膨胀 |
| P3 | 工程 | 部署未自动化 + 无 CI | 每次手动 Deploy |

---

## 二、P0 安全

### 1. JWT 密钥回退到公开默认值

**现状**：`functions/api/_lib/auth.js:85`

```js
export function jwtSecret(env) {
  return (env && env.JWT_SECRET) || "dev-secret-change-me";
}
```

只要线上环境变量 `JWT_SECRET` 没配置（或配错了名字），签名密钥就是代码里**公开可见**的 `dev-secret-change-me`。

**风险**：任何人都能用这个已知密钥自签一个 JWT，把 `sub` 填成站长用户名，直接以站长身份调用发文章 / 删文章 / 删评论接口。而且代码是公开仓库，密钥等于写在 README 里。

**建议**：
- 改为「缺失即拒绝服务」：`if (!env.JWT_SECRET) throw new Error(...)`，让配置错误在部署后立刻暴露，而不是静默降级到不安全状态。
- 顺带确认线上 Pages 项目的环境变量里确实存在 `JWT_SECRET`（长度建议 32 字节以上随机串）。
- 若历史上曾以 dev-secret 运行过，建议轮换密钥使旧 token 全部失效。

**涉及**：`functions/api/_lib/auth.js`

---

### 2. 文章正文 Markdown 渲染存在属性注入

**现状**：`assets/app.js:89-99`

```js
const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// ...
.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
```

两个问题：
1. `esc` **没有转义引号**，而 URL 被直接拼进 `src="..."` / `href="..."` 属性值里，引号可用来闭合属性、注入新的事件处理器。
2. `href` **没有协议白名单**，`javascript:` 链接会被原样输出，点击即执行。

**风险**：这是存储型 XSS。评论和留言墙的渲染已经正确用了 `escapeHtml`（`renderCommentItem` / `buildGuestCard`），**但文章正文这条路漏了**。而 `functions/api/register.js` 是开放注册的 —— 任何访客注册后都能发文，其正文会被渲染给所有读者，等于把 XSS 打到了全站。

**建议**：
- `esc` 增加 `"` → `&quot;` 和 `'` → `&#39;` 的转义。
- 链接/图片地址做协议白名单：只允许 `http:`、`https:`，以及 `data:image/` 用于图片；其余（`javascript:`、`vbscript:` 等）一律丢弃该标签，降级为纯文本。
- 更彻底的做法是引入 `DOMPurify`（约 20KB，可只在详情页按需加载）对最终 HTML 做一次净化，作为纵深防御。

**涉及**：`assets/app.js`（`mdToHtml`）

---

## 三、P1 安全与功能

### 3. 全站缺少速率限制

**现状**：登录、注册、发评论、写留言均无任何频率限制。

**风险**：
- `/api/login` 可被脚本无限撞库（密码最少只要 6 位，字典攻击成本低）。
- 评论 / 留言可被批量刷屏。
- 注册可被批量灌垃圾账号。

**建议**：
- 轻量方案：在 D1 建一张 `rate_limits` 表（key + window_start + count），在 login / register / comments / guestbook 入口按 IP（`getClientIp` 已有）+ 用户名做窗口计数，超出返回 429。
- 托管方案：用 Cloudflare 控制台的 Rate Limiting 规则，对 `/api/login`、`/api/register` 限速，零代码改动。
- 登录失败建议加指数退避或验证码升级。

**涉及**：`functions/api/login.js`、`register.js`、`posts/comments.js`、`guestbook.js`

---

### 4. 分享卡片的文章封面失效（真实缺陷）

**现状**：`functions/index.js:70`

```js
const image = post.cover && /^https?:\/\//i.test(post.cover)
  ? post.cover
  : new URL(DEFAULT_IMAGE, origin).toString();
```

只认 `http(s)` 开头的封面。但项目现在的流程是：
- 在后台用 `📷` 上传本地图片 → 存进 D1 的是 **base64 data URI**；
- 若没手填封面，后端从正文首图抽，同样是 base64；
- 构建期 `build.mjs` 的 `materializeCover()` 只把**静态快照里的** base64 落成 `/generated/covers/xxx.png`，**不回写 D1**。

于是 `functions/index.js` 从 D1 读到的一直是 base64（或空），两条路都命中不了 `^https?://`，**分享到微信/微博/X 时永远显示站点默认图**，而不是文章自己的封面。

**建议**：
- 前端发布时就把图片上传到静态目录（或 `assets/uploads/`），D1 只存相对路径；
- 或者让 `functions/index.js` 接受站内相对路径封面，拼成绝对 URL（`new URL(post.cover, origin)`），并把 base64 场景单独处理；
- 最省事的过渡方案：在构建期把 base64 封面落盘后，同时把 URL **写回 D1**，让 OG 注入能直接读到绝对地址。

**涉及**：`functions/index.js`、`functions/api/posts.js`、`build.mjs`

---

## 四、P2 安全与 SEO

### 5. Turnstile 软依赖 + 密码策略偏弱

**现状**：
- `register.js:20` 与留言/评论入口调用 `verifyTurnstile`，但 `TURNSTILE_SECRET_KEY` 未配置时**自动跳过校验**，等于无防护。
- 密码仅要求 6 位（`register.js:17`）。
- PBKDF2 迭代 100000 次（`auth.js:28`），OWASP 当前对 SHA-256 的建议是 600000 次。

**建议**：
- 确认线上已配置 `TURNSTILE_SECRET_KEY`；若没有，把「跳过校验」改为仅在本地开发环境生效（用 `env.ENVIRONMENT` 判断）。
- 密码下限提到 8 位，并做一次常见弱密码黑名单校验。
- PBKDF2 迭代提到 600000（注意单次哈希耗时上升，需实测冷启动影响）。

**涉及**：`functions/api/_lib/turnstile.js`、`register.js`、`_lib/auth.js`

---

### 6. 正文不被非 JS 爬虫收录

**现状**：整站是 SPA，文章地址是 `/?post=<slug>`。`functions/index.js` 会给爬虫注入 OG meta，但**只注入元信息，不注入正文 HTML**。

**风险**：Google 能执行 JS，但百度、搜狗、微信、Bing 的普通抓取拿到的是空壳页面 —— 正文内容不进索引，SEO 基本为 0。

**建议**：
- 在 `functions/index.js` 现有的爬虫分支里，把文章正文一并渲染进 HTML（dynamic rendering）。可以直接复用 `build.mjs` 已经生成好的 `/generated/posts/<slug>.json`（含 body），或用轻量 Markdown 渲染器在边缘转换。
- 正文用 `<article>` 包裹，并保留现有 JSON-LD，效果最好。
- 注意保持「真人走 SPA、爬虫走预渲染」的现有分流逻辑，避免 cloaking 争议（内容一致即可）。

**涉及**：`functions/index.js`、`build.mjs`

---

### 7. 正文内联图片未外置

**现状**：`build.mjs:102` `publicDetail()` 里 `body: row.body` 原样保留。

`materializeCover()` 只抽离了 `cover` 字段，**正文 body 里的 base64 图片仍在**。perf-audit 提到过「详情页封面已抽离」，但正文内的图没有。

**风险**：一篇配图多的文章，详情 JSON 仍可能是几百 KB，点开文章要等 JSON 下完才能开始渲染。

**建议**：
- 扩展 `materializeCover` 的思路，对 `body` 里的 `data:image/...;base64,` 做正则替换，落盘成 `/generated/covers/`（或新建 `/generated/inline/`）下的哈希文件，正文里换成相对 URL。
- 已有的前端懒加载（`IntersectionObserver`）会自动接管这些外链图，体验更好。

**涉及**：`build.mjs`

---

### 8. SEO 细节

| 项 | 现状 | 建议 |
|---|---|---|
| 文章 URL | `/?post=<slug>`（`_lib/seo.js:17`） | 改成 `/posts/<slug>` 路径式，对搜索引擎更友好；需同步改 SPA 路由、sitemap、canonical |
| sitemap lastmod | 用发布日 `date`（`sitemap.xml.js:13`） | 改用真实更新时间，并补上首页/归档等静态页 |
| AI 爬虫 | `BOT_RE` 未包含 GPTBot / PerplexityBot / ClaudeBot / Google-Extended | 补进正则，让 AI 搜索也能拿到正确元信息 |
| OG 缓存 | 边缘缓存 10 分钟（`index.js:161`） | 文章更新后分享卡片会滞后；可在更新时主动 purge，或把 TTL 降到 60s |

---

## 五、P3 工程与运维

### 9. 构建产物累积 + 就地改写源文件

**现状**：
- `build.mjs:109` `hashAssets()` 每次构建都生成一份新的 `app.<hash>.js` / `style.<hash>.css` / `lunar.<hash>.js`，**旧的哈希文件从不清理**，会随每次部署累积并全部上传。
- 同一个函数会**就地改写 `index.html`**（把引用换成哈希名），让源码文件在构建后被修改。

**建议**：
- 构建前先清理 `assets/` 下旧的 `*.{10位hex}.js|css` 产物，只保留本次生成的。
- 把哈希化做成「读源码 → 写产物 + 写 `dist/index.html`」的形式，不改动仓库里的 `index.html`（源头保持干净，`git status` 不再被构建污染）。

**涉及**：`build.mjs`、`.gitignore`

---

### 10. 部署未自动化 + 无 CI

**现状**：GitHub → Cloudflare 的自动部署 webhook 长期失效，每次 push 后都要去控制台手动 **Deploy latest**，极易遗忘（历史上多次因此以为「改了没生效」）。

**建议**：
- 在 GitHub Actions 里加一个部署 workflow，push 到 `main` 后调用 Cloudflare Deploy Hook 或 API 触发部署 —— 把「手动点按钮」变成「push 即上线」。
- 顺带在 CI 里跑已有的回归脚本：`scripts/verify-manage-update.mjs`、`scripts/smoke-app.mjs`，以及一次 Functions 的 import 完整性检查，防止再出现 `readingTime is not defined` 这类只在运行时才暴露的漏 import。
- 若坚持手动部署，至少在构建日志里打印 `generated/posts.json` 的体积和文章数，便于确认部署是否真的带上了新数据。

**涉及**：`.github/workflows/`、`scripts/`

---

## 六、建议的处理顺序

1. **先堵安全口子**：JWT 密钥回退（条目 1）→ 正文 XSS（条目 2）→ 确认 Turnstile 已配（条目 5）。
2. **再修用户可感知的缺陷**：分享卡片封面（条目 4）→ 正文图片外置（条目 7）。
3. **然后做 SEO**：爬虫正文预渲染（条目 6）→ URL 与 sitemap 细节（条目 8）。
4. **最后补工程债**：CI + 自动部署（条目 10）→ 构建产物清理（条目 9）。

> 说明：本报告只做静态代码审查，未连接线上环境验证实际配置（如 `JWT_SECRET`、`TURNSTILE_SECRET_KEY` 是否已设置）。第 1、5 条的风险程度取决于线上是否已配置对应环境变量，建议优先在 Cloudflare 控制台确认。
