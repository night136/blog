# 昉昕的博客

一个简洁现代风格的静态博客，支持 **Decap CMS 在线写文章**，可一键部署到 **Cloudflare Pages**（或 Netlify / Vercel）。

## 目录结构

```
blog-site/
├── index.html              # 博客前台（单页应用）
├── assets/
│   ├── style.css           # 样式
│   └── app.js              # 前端逻辑：fetch Markdown 并渲染
├── content/posts/          # 文章（Markdown + frontmatter）
│   └── *.md
├── admin/                  # Decap CMS 后台
│   ├── index.html
│   └── config.yml
└── README.md
```

## 本地预览

```bash
cd blog-site
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 注意：必须用 HTTP 服务器打开，不能直接双击 `index.html`（`fetch` 会被浏览器拦）。

## 部署到 Cloudflare Pages

1. 登录 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **连接到 Git**
2. 选择仓库 `night136/blog`
3. 构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `blog-site`
4. 部署完成后，在 **Custom domains** 里绑定你的域名（如 `blog.example.com`）

## 配置 GitHub OAuth（让 CMS 能登录写文章）

Decap CMS 用 GitHub 账号登录，需要一个 OAuth App：

1. GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
   - **Homepage URL**: 你的站点域名，如 `https://blog.example.com`
   - **Authorization callback URL**: `https://blog.example.com/admin/`
2. 拿到 **Client ID** 和 **Client Secret**
3. 因为 Cloudflare Pages 是纯静态，没有后端处理 OAuth 回调，官方推荐用 [Netlify](https://www.netlify.com/) 的 **Implicit Grant**（无需 Secret）或自托一个轻量 OAuth 回调。
   最简方案（无需自建服务）：
   - 把 `admin/config.yml` 的 `backend` 改成用 Netlify Identity（需部署到 Netlify），**或**
   - 用一个现成的 OAuth 中继，例如 [`decap-cms-oauth-proxy`](https://github.com/vencax/netlify-cms-oauth-provider) 部署到任意 Node 环境，把回调地址填进 GitHub OAuth App。
4. 改 `admin/config.yml` 顶部的 `site_url` / `display_url` 为你的真实域名。

> 如果只是想本地写、Git 提交文章，不强制登录 CMS：直接往 `content/posts/` 丢 `.md` 文件，commit 后 Cloudflare 自动重新部署即可。新增文件后记得在 `assets/app.js` 的 `POST_FILES` 数组里加上文件名。

## 新增一篇文章的格式

```markdown
---
title: 文章标题
date: 2026-08-06
tag: 分类
summary: 一句话摘要
---

正文支持 Markdown：**粗体**、*斜体*、`代码`、列表、代码块等。
```
