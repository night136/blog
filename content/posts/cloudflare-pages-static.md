---
title: 把静态网站托管到 Cloudflare Pages 的几种姿势
date: 2026-07-28
tag: 部署
summary: 从 Git 自动部署到 CLI 上传，聊聊 Cloudflare Pages 的便利与坑。
---

Cloudflare Pages 对静态站和前端框架极其友好：全球 CDN、自动 HTTPS、免费额度也很慷慨。

## 方式一：Git 连接（推荐）

在控制台连接 GitHub 仓库，设定构建命令与输出目录，之后每次 push 都会自动部署并生成预览链接。

## 方式二：wrangler CLI

不想连 Git 时，可以本地直接上传：

```bash
npx wrangler pages deploy ./blog-site --project-name=my-blog
```

记住构建产物目录要和命令里的路径一致，否则会部署一个空站。
