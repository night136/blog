# Decap CMS 登录与在线发文章 · 逐步指引

目标：让你在浏览器打开 `https://你的域名/admin/`，用 **GitHub 账号登录**，可视化写文章，点一下就发布到 `night136/blog` 仓库，Cloudflare 自动重新部署。

> 为什么需要这些步骤？Cloudflare Pages 是纯静态托管，没有后端处理登录。Decap CMS 用 GitHub OAuth 登录时，需要一个「OAuth 中继」来在 GitHub 和 CMS 之间传递授权令牌。本仓库已准备好这个中继（见 `oauth-worker/` 目录），照下面做即可。

---

## 总览（先看清要做什么）

1. 在 GitHub 建一个 **OAuth App**，拿到 Client ID / Client Secret
2. 把 `oauth-worker/index.js` 部署成一个 **Cloudflare Worker**（OAuth 中继）
3. 把 Worker 地址填进 `admin/config.yml` 的 `base_url` 和 `auth_endpoint`
4. 重新部署博客到 Cloudflare Pages
5. 打开 `/admin/` 登录，写文章

---

## 第 1 步：创建 GitHub OAuth App

1. 打开 👉 https://github.com/settings/developers
2. 左侧点 **OAuth Apps** → 右上角 **New OAuth App**
3. 填写：
   - **Application name**：`blog-cms`（随便写）
   - **Homepage URL**：你的博客域名，例如
     `https://blog.zhongfangxin682.workers.dev`
   - **Authorization callback URL**：**先空着**，第 3 步拿到 Worker 地址后再回来填。
     （最终会是 `https://blog-oauth-provider.<子域>.workers.dev/oauth/callback`）
4. 点 **Register application**
5. 页面上能看到 **Client ID**（一串字符），先复制留着
6. 点 **Generate a new client secret**，生成后**立刻复制** Client Secret（只显示一次）

> 把 Client ID 和 Client Secret 先记到记事本，下面两步都要用。

---

## 第 2 步：部署 OAuth Worker（中继）

这个 Worker 的源码在 `oauth-worker/index.js`，已经写好，直接部署。

### 用控制台部署（最简单，不用装东西）

1. 登录 https://dash.cloudflare.com → 左侧 **Workers & Pages** → **Create** → **Create Worker**
2. Worker 名称填 `blog-oauth-provider`，点 **Deploy**（先随便部署一版）
3. 部署后进入这个 Worker → 点 **Edit code**（或 Quick edit）
4. 把编辑器里默认的代码**全部删掉**，粘贴 `oauth-worker/index.js` 的内容 → **Save and Deploy**
5. 进入该 Worker → **Settings** → **Variables**
   - 加 **Variable**（明文）：`GITHUB_CLIENT_ID` = 第 1 步拿到的 Client ID
   - 加 **Secret**（加密）：`GITHUB_CLIENT_SECRET` = 第 1 步拿到的 Client Secret
   - 保存
6. 记下这个 Worker 的地址，形如：
   `https://blog-oauth-provider.<你的子域>.workers.dev`
   （在 Worker 概览页顶部能看到）

### 用命令行部署（可选）

```bash
cd oauth-worker
npm install -g wrangler
wrangler login
wrangler secret put GITHUB_CLIENT_ID      # 交互输入 Client ID
wrangler secret put GITHUB_CLIENT_SECRET  # 交互输入 Client Secret
wrangler deploy
```

---

## 第 3 步：回填 GitHub OAuth App 的回调地址

1. 回到 https://github.com/settings/developers → 打开 `blog-cms` 这个 OAuth App
2. 编辑 **Authorization callback URL**，填：

   ```
   https://blog-oauth-provider.<你的子域>.workers.dev/oauth/callback
   ```

   ⚠️ 必须是 Worker 地址 + `/oauth/callback`，**末尾不要加 `/`**
3. 保存

> 为什么回调在 Worker 而不是博客站？因为登录令牌的交换必须发生在一个能跑代码的地方，Worker 就是干这个的。

---

## 第 4 步：更新 config.yml 并重新部署

编辑 `admin/config.yml`，做两处确认/修改：

```yaml
backend:
  name: github
  repo: night136/blog
  branch: main
  base_url: https://blog-oauth-provider.<你的子域>.workers.dev       # ← 改成你的 Worker 地址
  auth_endpoint: /oauth/authorize

site_url: https://blog.zhongfangxin682.workers.dev   # ← 改成你的博客域名
display_url: https://blog.zhongfangxin682.workers.dev
```

改完 `git push`（或直接连 Cloudflare Pages 的仓库会自动部署）。Cloudflare Pages 检测到 `main` 更新后会自动重新构建。

> 如果你还没把仓库连到 Cloudflare Pages：
> Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → 连接 GitHub 仓库 `night136/blog` →
> **Build command** 留空 → **Build output directory** 填 `blog-site` → 部署。

---

## 第 5 步：登录并写第一篇正式文章

1. 浏览器打开 `https://你的域名/admin/`
2. 点 **Login with GitHub** → 跳到 GitHub 授权页 → 点 **Authorize**
3. 授权后自动回到 CMS 后台
4. 点左上角 **New Posts**（或「新建文章」）
5. 填写字段：
   - 标题、日期、分类标签
   - **作者**：默认「昉昕」，写别人文章就改名字
   - 摘要、正文（支持 Markdown 工具栏）
6. 点 **Save**（保存）
7. 因为开了 `publish_mode: editorial_workflow`，文章会先成草稿：
   - 在右侧状态里把 **Draft → In Review → Ready → Publish**
   - 每次状态变化 Decap 会在 GitHub 建一个 PR，Publish 时自动合并到 `main`
8. 合并后 Cloudflare Pages 自动重新部署，前台就能看到新文章

> 如果不想走审核流程，把 `admin/config.yml` 里的 `publish_mode: editorial_workflow` 删掉，保存即直接发布。

---

## 常见问题

### 登录后白屏 / 报 `Unable to parse`
- GitHub OAuth App 的 **callback URL** 和 Worker 地址不一致，或末尾多了 `/`
- 确认回调是 `https://<Worker>/oauth/callback`

### 点 Login 没反应 / 弹窗被挡
- 浏览器拦截了弹窗，允许该站点的弹窗后重试
- 确认 `backend.base_url` 是 `https` 且能从公网访问
- 确认 `backend.auth_endpoint` 填的是 `/oauth/authorize`

### 发布后网站没更新
- 去 GitHub 仓库看 `main` 分支有没有新 commit / 新 PR
- 去 Cloudflare Pages 的 **Deployments** 看有没有新构建；如有红叉，点开看日志
- 用了 editorial workflow 时，必须走到 **Publish** 才会合并 PR

### 图片上传失败
- 确认 `GITHUB_CLIENT_SECRET` 正确、token 有 `repo` 权限
- 确认 `media_folder` / `public_folder` 路径配置无误

### 我想多人都能写
- 在 GitHub 仓库 Settings → **Collaborators** 把他们的 GitHub 账号加为协作者即可，无需改代码
