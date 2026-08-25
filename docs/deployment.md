# 博客 Cloudflare Pages 部署与静态预渲染配置

本文档记录本博客（纯静态前端 + Cloudflare Pages Functions + D1）在 Cloudflare 上的完整部署步骤、静态预渲染方案与运维验证清单。复现或迁移时按此操作即可。

---

## 一、架构概览

- **前端**：纯静态 HTML/CSS/JS（`index.html` + `assets/`），由 Cloudflare Pages 直接 CDN 分发。
- **后端**：Pages Functions（`functions/`）连接 D1 数据库（`BLOG_DB` 绑定），负责文章增删改查、JWT 鉴权、阅读数、边缘缓存（Cache API）。
- **静态预渲染（治本提速）**：`build.mjs` 在**每次构建**时用 D1 REST API 拉全部文章，生成 `generated/` 静态 JSON。首页和文章详情**优先 CDN 直读静态文件**，首屏不再依赖函数冷启动，首次加载也快（≈10–50ms）。
- **降级保障**：静态文件缺失或拉取失败时，前端自动回退到 `/api/posts` 等 Function 接口，站点照常可用。

```
构建时：node build.mjs
        └─ D1 拉全量文章 → generated/posts.json（列表，不含 body）
                          └─ generated/posts/<slug>.json（详情，含 body）

用户访问：
  首页  GET /generated/posts.json       （CDN 秒回）  ──失败──▶ /api/posts
  文章  GET /generated/posts/<slug>.json（CDN 秒回）  ──失败──▶ POST /api/posts/detail
        静态打开时 → POST /api/posts/view（补实时阅读数 +1）
```

---

## 二、Cloudflare Pages 项目设置

> ⚠️ 前提：本项目根目录（Cloudflare 控制台 **Settings → Build → Root directory**）应设为 `blog-site`（即 `build.mjs` 所在目录）。构建命令与路径均相对于该根目录生效。

### 1. 绑定代码仓库
Workers & Pages → 创建 / 连接现有 Git 仓库 → 选择本仓库 → **Root directory = `blog-site`** → 进入项目。

### 2. Build command
**Settings → Build → Build configuration**，Build command 设为：
```
node build.mjs
```
（Build output directory 保持 `/`，`generated/` 会生成在根目录随站点一起发布。）

### 3. 构建环境变量（Build variables）
**Settings → Build → Variables and secrets → Build（构建时）** 添加 3 个变量（构建阶段 `build.mjs` 需要用来连 D1）：

| 变量名 | 说明 | 示例 |
|---|---|---|
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID | `64117e0a49c7008af4a0e197f67f3337` |
| `CF_DATABASE_ID` | D1 数据库 UUID | `630d0072-2d60-462d-97d6-ee527c7e4cd6` |
| `CF_API_TOKEN` | 具备 D1 读写权限的 API Token | `cfut_...`（见第九条安全提醒） |

> 账户 ID、D1 库 UUID 可在 **Workers & Pages → 你的 D1 数据库 → 右侧概览** 查到。

### 4. D1 数据库绑定（Functions 运行时）
页面 Functions 运行时需要 D1 绑定：项目 **Settings → Functions → D1 数据库绑定（或 Integrations）**，将 `BLOG_DB` 绑定到上述 D1 数据库。同时确认以下 Functions 环境变量已设置（**Settings → Environment variables → Production**）：
- `JWT_SECRET`：JWT 签名密钥（登录鉴权用，必须设置且保密）
- `BLOG_DB`：由上面的绑定自动注入
- `SITE_URL`（可选）：SEO canonical/og:url 域名，不设则兜底 `https://blog-6p3.pages.dev`

### 5. Deploy Hook（发布后自动重新预渲染）
**Settings → Deploy hooks → Create deploy hook**，取任意名称（如 `publish-hook`），创建后复制生成的 URL（形如 `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/...`）。

将 URL 写入 **Functions 环境变量（Production）**：
| 变量名 | 值 |
|---|---|
| `DEPLOY_HOOK_URL` | 上一步复制的 Deploy Hook URL |

作用：发布 / 修改 / 删除文章成功后，`functions/api/posts.js` 与 `functions/api/posts/manage.js` 会以 fire-and-forget 方式 `fetch(DEPLOY_HOOK_URL)` 触发一次新部署，使 `generated/` 静态文件自动刷新，新内容立即进入 CDN。

---

## 三、关键文件说明

| 文件 | 作用 |
|---|---|
| `build.mjs` | 构建脚本：用 D1 REST API 拉全量文章，生成 `generated/posts.json` 与 `generated/posts/<slug>.json`。容错：缺变量/异常只 warn，不中断部署。 |
| `functions/api/posts/view.js` | `POST {slug}`：非作者本人访问则阅读数 +1，返回最新 views。供静态详情打开时调用（静态 JSON 不会执行 Function 的 +1）。 |
| `functions/api/posts.js` | 列表接口（Cache API 边缘缓存 60s）+ 发布成功后触发 Deploy Hook。 |
| `functions/api/posts/manage.js` | 文章更新 / 删除成功后触发 Deploy Hook。 |
| `functions/api/posts/detail.js` | 详情接口（Cache API 边缘缓存 180s，命中仍 +1 阅读数）。 |
| `assets/app.js` | `fetchAllPosts` 优先 `GET /generated/posts.json`，`openPost` 优先 `GET /generated/posts/<slug>.json`；失败降级 Function。 |
| `docs/perf-audit.md` | 性能优化审计（CSS 分析、已落地优化清单、小米兼容事故、缓存坑等）。 |

---

## 四、验证清单

部署完成后逐项确认：

1. **首屏快**：打开首页，DevTools Network 里 `/generated/posts.json` 应命中 CDN（状态码 200，无函数冷启动耗时）。
2. **部署日志**：每次重新部署，构建日志应出现 `[build] 已生成 N 篇文章静态 JSON → generated/`。
3. **自动重渲染**：在后台发布/修改一篇新文章 → 回到 Cloudflare **Deployments** 列表，应看到**自动新增一条部署记录**（由 `DEPLOY_HOOK_URL` 触发）→ 刷新站点能看到新内容已进入静态。
4. **阅读数累加**：打开任意文章，阅读数实时 +1（静态详情打开会调用 `/api/posts/view`）。
5. **降级可用**：若临时清空 `generated/`，前端应自动回退到 `/api/posts`，站点不崩。

---

## 五、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建日志报「未配置 CF_*，跳过静态生成」 | 构建环境变量没填 / 拼写错 | 回到 Settings → Build variables 补 3 个变量后重新部署 |
| 发布文章后静态内容没更新 | `DEPLOY_HOOK_URL` 没配或填错 | 检查 Functions 环境变量 `DEPLOY_HOOK_URL` = Deploy Hook URL；Deployments 列表应出现自动部署 |
| 首页/文章走 Function 而非静态 | `Root directory` 没设为 `blog-site` | 控制台改 Root directory 为 `blog-site` 并重部署 |
| 静态生成失败但站点仍可用 | `build.mjs` 容错降级 | 看构建日志错误信息（通常是 D1 凭证权限不足），不影响线上运行 |

---

## 六、安全提醒（重要）

- `CF_API_TOKEN`（`cfut_...`）具有 D1 读写权限，**切勿提交进仓库或明文外传**。仅在 Cloudflare 控制台「Build variables」中设置。
- 该 Token 一旦不再需要或更换，请到 **My profile → API Tokens** 立即轮换 / 删除，并新建一个**最小权限** Token（仅 Pages + D1 权限）。
- `JWT_SECRET` 必须设为强随机值且只在 Functions 环境变量中保存，不要写进前端或仓库。
- `generated/` 已加入 `.gitignore`，不会进版本库（避免静态快照泄露待发布内容、也减小仓库体积）。

---

## 七、本地验证（可选）

如需本地跑 `build.mjs` 验证静态生成（需 Node 18+）：

```bash
cd blog-site
export CF_ACCOUNT_ID=xxxx
export CF_DATABASE_ID=xxxx
export CF_API_TOKEN=cfut_xxxx
node build.mjs        # 生成 ./generated/ 下 JSON
```

可用 `NODE` 临时只读 Token 先 `DRY_RUN` 校验连通性后再回填（参见 `scripts/backfill-words.mjs` 同款 D1 REST 用法）。
