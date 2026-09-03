# 昉昕的博客 · 函数与接口功能文档

> 适用版本：night136/blog（`blog-site/` 目录，Cloudflare Pages + Pages Functions + D1）
> 本文档梳理后端 Pages Functions、前端 `assets/app.js`、构建脚本 `build.mjs` 的职责与调用关系。

---

## 1. 架构总览

```
浏览器 (SPA: index.html + assets/app.js)
        │  fetch /api/*  ──────────────┐
        │  ?post=<slug> (爬虫 UA)       │
        ▼                               ▼
 functions/index.js  (边缘函数)    functions/api/*  (Pages Functions)
   └ 注入 OG/Twitter 元信息           ├ _lib/auth.js (PBKDF2+JWT)
   └ 命中 Cache API                   ├ _lib/turnstile.js (人机验证)
                                       ├ 业务端点 (posts/guestbook/auth)
        │                               ▼
        └──────────►  env.BLOG_DB (Cloudflare D1 SQLite)
                      env.ASSETS (静态 index.html)
构建期: build.mjs ──► generated/posts.json + generated/posts/<slug>.json (CDN 直读)
```

- **静态优先**：前端首屏直接读 `generated/posts.json`（构建期快照，经 CDN 秒开）。
- **动态兜底**：`/api/posts/meta` 探针判断快照是否过期，过期则前端自动回退到 `/api/posts` 等动态接口。
- **发布即重建**：`posts` 的创建/更新/删除通过 `DEPLOY_HOOK_URL` 触发 Cloudflare 重新构建（`ctx.waitUntil` 保证 Hook 真的发出）。
- **边缘缓存**：公开只读接口用 `caches.default`（Cache API）显式缓存 30–180s，规避函数冷启动。
- **爬虫兼容**：SPA 不执行 JS，故 `functions/index.js` 在边缘为社交平台/搜索引擎注入 OG 元信息。

---

## 2. 数据模型（D1 表）

定义在 `scripts/schema.sql`，评论表在 `scripts/comments.sql`，留言墙表在 `scripts/migrate-guestbook.sql`。

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | `username`(唯一), `email`, `password_hash`(`salt:hash`), `created_at` | 会员账号，PBKDF2 派生哈希 |
| `posts` | `slug`(唯一), `title`, `date`, `tag`, `summary`, `cover`, `author_username`, `body`(Markdown), `views`, `words`, `created_at`, `updated_at` | 文章，`words` 发布/更新时算好存入；索引 on `date`/`author_username`/`tag` |
| `comments` | `id`, `post_slug`, `name`, `content`, `created_at`, `parent_id`(楼中楼), `likes` | 评论；索引 on `post_slug` |
| `guestbook_notes` | `id`, `name`, `content`, `color`, `ip_hash`(SHA-256(IP+secret)，不存原 IP), `created_at`(UTC+8) | 公开留言墙便签；索引 on `created_at`/`ip_hash` |

---

## 3. 后端 Pages Functions

### 3.1 共享库 `_lib/`（不对外暴露路由）

| 模块 | 导出 | 职责 |
|---|---|---|
| `functions/api/_lib/auth.js` | `hashPassword` / `verifyPassword` | PBKDF2-SHA256 100k 迭代，`salt:hash` 存储，恒定时间比较防时序攻击 |
| | `signJWT` / `verifyJWT` | HS256 JWT 签发与校验（7 天过期） |
| | `getCookie` / `json` | Cookie 解析 / 统一 JSON 响应 |
| | `sessionCookie` / `clearCookie` | `auth` Cookie（HttpOnly+Secure+SameSite=Strict，7 天 / 清除） |
| | `isOwner(username, env)` | 站长判定：`env.BLOG_OWNER` 等于登录名时为真，可管理任意文章/便签 |
| `functions/api/_lib/turnstile.js` | `verifyTurnstile(token, secret, ip)` | 服务端校验 Cloudflare Turnstile；**未配 `TURNSTILE_SECRET_KEY` 直接放行** |
| | `getClientIp(request)` | 取 `CF-Connecting-IP` / `X-Forwarded-For` |
| `functions/_lib/seo.js` | `siteUrl(env)` / `xesc(s)` / `postUrl(env, slug)` | 站点地址、`XML` 转义、文章链接构造 |
| `functions/_lib/readingTime.js` | `readingTime(md)` | 中文字数 + 英文词数，返回 `{words, minutes}`（与前端一致） |

### 3.2 认证与配置

| 方法 | 路由 | 入参 | 说明 | 鉴权 |
|---|---|---|---|---|
| POST | `/api/register` | `username,password,email,turnstileToken` | 注册：Turnstile 校验 → 用户名查重（2–32 位、密码≥6 位）→ 随机 salt 哈希入库 → 直接签发 JWT 并种 Cookie | 公开（含人机验证） |
| POST | `/api/login` | `username,password` | 支持用户名**或**邮箱登录；校验密码 → 签发 JWT + Cookie | 公开 |
| POST | `/api/logout` | — | 清除 `auth` Cookie | 公开 |
| GET | `/api/me` | — | 返回当前会话 `{user:{username,isOwner}}`，无效/过期 token 视为未登录 | 公开 |
| GET | `/api/config` | — | 下发公开配置（仅 `turnstileSiteKey`，Site Key 本身可暴露） | 公开 |

### 3.3 文章接口 `functions/api/posts*`

| 方法 | 路由 | 入参 | 说明 | 鉴权 |
|---|---|---|---|---|
| GET | `/api/posts` | — | 列表（按 `date desc`）。**只 SELECT 文本列，绝不读 `body`**（body 含 base64 大图）；`words` 列预存；缺失 `words`/`views` 列逐级降级；边缘缓存 60s | 公开 |
| POST | `/api/posts` | `title,tag,summary,cover,body` | 发布文章：校验会话 → 校验长度/上限（body≤1.9MB）→ 未填封面则从正文抽首图 → 生成 `日期-标题-短哈希` slug → 写入 D1 → **触发重新构建** | 登录 |
| GET | `/api/posts/[slug]` | (path) | 取单篇（含 body）；`PUT` 更新、`DELETE` 删除（仅作者或站长，见 `functions/api/posts/[slug].js`） | GET 公开 / 写操作登录 |
| POST | `/api/posts/detail` | `slug` | 取单篇（含 body，slug 走 body 规避国产浏览器 URL 中文编码损坏）；边缘缓存 180s，命中仍 +1 阅读量并保证计数准确；非作者才计数 | 公开 |
| POST | `/api/posts/manage` | `action:update|delete, slug,...` | 文章管理统一入口（作者或站长）：更新/删除 → 删除后触发重新构建 | 登录 |
| POST | `/api/posts/view` | `slug` | 阅读数 +1（非作者本人），返回最新 `views`；供静态详情页调用 | 公开 |
| GET | `/api/posts/meta` | — | 新鲜度探针：返回 `{count, latest}`，供前端判断静态快照是否过期；边缘缓存 60s | 公开 |
| GET | `/api/posts/search?q=` | `q` | 全文搜索（标题/摘要/正文），最多 5 个分词 AND 匹配；缺失 `views` 列降级；不缓存 | 公开 |
| GET/POST | `/api/posts/comments` | `action:list|create|like|delete, slug, id, name, content, parent_id` | 评论统一接口（slug 走 body）：列表/发表（支持 `parent_id` 楼中楼）/点赞（游客可点）/删除（仅楼主） | 列表/点赞公开，删/发需登录 |
| GET/POST | `/api/posts/[slug]/comments` | 同 comments（slug 在 path） | 与上述 `comments.js` 逻辑一致的 path 版本，存在两份以便不同前端调用 | 同上 |

> 删除评论同时删除其楼中楼（`parent_id = id` 的子评论）。

### 3.4 留言墙 `functions/api/guestbook*`

| 方法 | 路由 | 入参 | 说明 | 鉴权 |
|---|---|---|---|---|
| GET | `/api/guestbook` | `?limit=&before=&before_id=` | 列出便签（分页，默认 50/页、上限 100），按 `(created_at,id) desc` 游标；返回 `notes, canDelete, total, streak(连续打卡天数), turnstileSiteKey, currentUser, hasMore, nextCursor`；边缘缓存 30s | 公开 |
| POST | `/api/guestbook` | `name,content,turnstileToken` | 写便签：Turnstile 校验 → 长度校验（内容≤200、名字≤20）→ **已登录则强制用登录名**（杜绝伪造署名）→ 随机颜色 → `ip_hash` 每天每 IP 限 5 条 → 入库 | 公开（含人机验证） |
| POST | `/api/guestbook/manage` | `id` | 删除便签（仅站长 `BLOG_OWNER`） | 站长 |

> `streak` 计算（UTC+8）：今天写了从今天往前数；今天没写但昨天写了从昨天数；昨天也没写则 0。

### 3.5 SEO / Feed / 边缘注入

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `functions/index.js`（边缘函数，对 `/?post=<slug>` + 爬虫 UA 生效） | 动态渲染：在边缘读取文章，把 **OG / Twitter Card / JSON-LD** 内联进 `index.html` 再返回（替换 `<!--OG-DEFAULT-START/END-->` 标记内的默认 OG）。不执行 JS 的爬虫也能拿到正确卡片。`Cache API` 缓存 600s。**任何一步失败都 `next()` 回退静态响应，不影响正常访问**。 |
| GET | `/feed.xml` | RSS 2.0（最近 20 篇，用 `seo.js` 转义与 `postUrl` 构造） |
| GET | `/sitemap.xml` | 动态站点地图（全部文章，读 D1） |
| GET | `/robots.txt` | 允许抓取并指向 `/sitemap.xml` |

> 爬虫 UA 白名单覆盖微信/微博/X/Facebook/Telegram/Discord/Baidu/Google/Bing 等（见 `index.js` 的 `BOT_RE`）。真人访问直接 `next()`，零额外开销。

---

## 4. 前端 `assets/app.js`（主要函数）

按职责分组（函数名均取自源码，行号为编写时快照，可能随迭代偏移）。

### 4.1 渲染与路由
- `mdToHtml(md)` (79) — Markdown→HTML，含代码块/图片/转义
- `lazyLoadImages` / `getImgObserver` (121/139) — 图片懒加载（IntersectionObserver）
- `renderSlider` / `goSlide` / `startAuto` / `stopAuto` (206/220/221/222) — 首页轮播
- `renderFilters` / `getFiltered` (225/234) — 分类筛选
- `cardHtml` / `paintCards` / `renderCardsFrom` / `renderCards` / `renderArchive` (245/280/296/302/309) — 文章卡片与归档
- `renderWidgets` (315) — 侧边栏小部件
- `showView(name)` (774) / `refreshHomeList` (787) / `loadPosts` (794) — 视图切换与列表加载
- `openPost(slug)` (345) — 打开文章详情，含 TOC、阅读进度、代码高亮、评论加载

### 4.2 文章详情增强
- `buildToc` / `initTocSpy` (330/470) — 目录与滚动高亮
- `escapeHtml` / `readingTime` (413/414) — 转义与阅读时长（与后端一致）
- `sharePost` / `updateMeta` / `resetMeta` (421/443/460) — 分享与动态写入 OG meta
- `addCodeCopyButtons` / `highlightCodeBlocks` / `ensureHljs` (517/540/559) — 代码复制与高亮
- `initReadingProgress` (572) — 顶部阅读进度条
- `buildPostNav` (496) — 上一篇/下一篇

### 4.3 评论系统
- `renderCommentItem` / `loadComments` (594/601) — 渲染与加载（含楼中楼）
- `bindCommentForm` (633) — 绑定发表（登录用户自动填昵称）
- `handleLike` / `handleDelete` / `handleReply` / `resetReply` (718/742/755/768) — 点赞/删除/回复
- `loadComments` 内部用 `localStorage` 对点赞去重

### 4.4 留言墙
- `formatGuestDate` / `buildGuestCard` / `renderGuestbook` (821/828/930) — 便签卡片与渲染
- `loadMineIds` / `saveMineIds` / `addMineId` / `removeMineId` (848/856/860/867) — 「我的便签」标记（localStorage）
- `groupNotesByDate` / `renderGuestStats` (882/900) — 按日期分组 + 总数/连续打卡展示
- `updateGuestbookAuthHint` (912) — **登录态隐藏名字栏**，便签直接显示登录名
- `loadMoreGuestbook` (997) / `bindGuestDeletes` (1019) — 分页加载 / 站长删除绑定

### 4.5 人机验证（Turnstile）
- `renderTurnstile` / `renderRegisterTurnstile` (1046/1074) — 留言墙与注册两处 widget
- `loadTurnstileConfig` (1096) — 拉取 `/api/config` 的 Site Key
- `bindGuestbookForm` (1129) — 提交前取 `turnstile.getResponse(token)`

### 4.6 会员 / 认证 UI
- `checkSession` (1506) — 拉 `/api/me` 设置 `currentUser`
- `openAuth` / `closeAuth` / `switchTab` / `openCompose` (1507/1508/1509/1640) — 登录/注册弹窗、写文章
- `handleLogin` / `handleRegister` / `handleLogout` (1574/1596/1630) — 登录/注册/登出
- `renderMember` (1632) — 会员视图（发文章、管理自己文章）
- `compressImage` / `compressOnce` / `estimateBase64Bytes` (1722/1744/1738) — 发布时图片压缩
- `handlePublish` (1781) — 发布/更新文章（调用 `/api/posts` 或 `/api/posts/manage`）
- `insertAtCursor` (1769) — 文本框光标处插入（emoji 快捷插入）

### 4.7 主题 / 时钟 / 搜索
- `applyTheme` / `themeBg` / `toggleTheme` (1247/1253/1262) — 明暗主题
- `updateLunar` (1288) — 农历时辰
- `updateSideClock` (1371) — 侧边时钟 / 时钟动画
- `openLightbox` / `closeLightbox` (1407/1412) — 图片灯箱
- `doSearch` (1448) — 站内搜索（调 `/api/posts/search`）

---

## 5. 构建与部署

### 5.1 `build.mjs`（构建期静态预渲染）
- 用 `CF_ACCOUNT_ID` / `CF_DATABASE_ID` / `CF_API_TOKEN` 经 D1 REST API 拉全部文章。
- 产物：
  - `generated/posts.json` — 列表（含 `count`/`latest`/`generatedAt` 新鲜度元信息，**不含 body**）
  - `generated/posts/<slug>.json` — 单篇详情（**含 body**）
- 容错：未配置环境变量或 D1 报错时**不抛出**，仅告警，前端降级到 Functions 接口（保证部署不因构建失败中断）。
- 字数算法与 `functions/_lib/readingTime.js` 保持一致。

### 5.2 发布 → 重建链路
- 文章创建/更新/删除成功后，调用 `triggerRedeploy(env, ctx)` POST `DEPLOY_HOOK_URL`（存于 Functions 环境变量，不暴露前端）。
- ⚠️ **必须用 `ctx.waitUntil`** 等待 Hook：Pages Functions 在 Response 返回后会取消未完成 fetch，裸 fire-and-forget 会导致静态快照永不刷新（表现为「发布后首页不显示」）。
- 静态快照刷新后最多延迟 60s（列表缓存）生效；`/api/posts/meta` 探针可让前端在快照过期时立即回退动态列表。

### 5.3 环境变量（Pages Settings → Environment variables，Production scope）
| 变量 | 用途 | 必填 |
|---|---|---|
| `BLOG_DB` | D1 数据库绑定（变量名固定，在 Functions→D1 bindings 绑定） | 是 |
| `JWT_SECRET` | JWT 签名 / 密码 salt 派生盐；**必须长随机串** | 是 |
| `BLOG_OWNER` | 站长登录名（可管理任意文章/便签） | 建议 |
| `TURNSTILE_SITE_KEY` | 前端 Turnstile Site Key（公开） | 否 |
| `TURNSTILE_SECRET_KEY` | 服务端校验密钥；未配则 Turnstile 自动跳过 | 否 |
| `SITE_URL` | 站点域名（feed/sitemap/OG 用），默认 `https://blog-6p3.pages.dev` | 否 |
| `DEPLOY_HOOK_URL` | 文章变更触发重新构建的 Hook 地址 | 否（不设则不自动重建静态） |
| `CF_ACCOUNT_ID` / `CF_DATABASE_ID` / `CF_API_TOKEN` | `build.mjs` 构建期访问 D1（仓库 Secrets / 环境变量） | 构建期需要 |

---

## 6. 关键实现要点（避坑）

1. **TDZ 陷阱**：`let currentUser` 必须声明在 IIFE 顶部，否则函数提前访问会抛 `ReferenceError` 导致整站空白（已由 `scripts/smoke-app.mjs` 防回归）。
2. **中文 slug 编码**：国产浏览器对 URL 中文 slug 会二次编码损坏，故 `detail`/`manage`/`comments` 改为 slug 走 **POST body**。
3. **列表不读 body**：避免把每篇 base64 大图从 D1 搬出；`words` 预存。
4. **边缘缓存只读公开数据**：用 `caches.default` 显式缓存；POST 用 GET 形式 key 绕过 CDN 不缓存非 GET 的限制（`posts/detail`）。
5. **隐私**：留言墙 `ip_hash` 仅存哈希，不存原 IP；限频按天每 IP 5 条。
6. **安全**：密码 PBKDF2+恒定时间比较；JWT HttpOnly+Secure+SameSite=Strict；删除操作严格校验作者/站长。

---

> 维护提示：Cloudflare 自动部署（GitHub webhook）在本项目曾失效，代码 `git push` 后常需在 Pages 控制台手动 **Deploy latest** 才能让 Functions 变更上线。本文档随代码迭代更新，函数行号仅供参考。
