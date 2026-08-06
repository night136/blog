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

如果改了文章，要重新生成索引：

```bash
node scripts/build-index.js
```

## 部署到 Cloudflare Pages

1. 登录 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **连接到 Git**
2. 选择仓库 `night136/blog`
3. 构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `blog-site`
4. 部署完成后，在 **Custom domains** 里绑定你的域名（如 `blog.example.com`）

## 配置 GitHub OAuth（让 CMS 能登录写文章）

完整图文步骤见 **`CMS-OAUTH.md`**。这里简述关键点：

1. GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
   - **Homepage URL**: 你的站点域名，如 `https://blog.example.com`
   - **Authorization callback URL**: `https://blog.example.com/admin/`
2. 拿到 **Client ID** 和 **Client Secret**
3. 因为 Cloudflare Pages 是纯静态，没有后端处理 OAuth 回调，推荐方案：
   - **最简单**：把站点部署到 Netlify 并用 Git Gateway（详细步骤见 CMS-OAUTH.md 方案 A）
   - **保留 Cloudflare Pages**：用一个 Cloudflare Worker 做 OAuth 中继（详细步骤 + Worker 代码见 CMS-OAUTH.md 方案 B）
4. 改 `admin/config.yml` 顶部的 `site_url` / `display_url` 为你的真实域名。

> 如果只是想本地写、Git 提交文章，不强制登录 CMS：直接往 `content/posts/` 丢 `.md` 文件，然后运行 `node scripts/build-index.js` 更新 `index.json`，再 commit/push，Cloudflare 会自动重新部署。

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
