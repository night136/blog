# 推送到 GitHub 并部署到 Cloudflare Pages

本地仓库已经初始化并完成了首次 commit（`3646467`），远程 `origin` 已指向
`https://github.com/night136/blog.git`。**只差最后一步 push。**

---

## 第一步：拿到 GitHub 个人访问令牌（PAT）

1. 打开 https://github.com/settings/tokens
2. 点 **Generate new token (classic)**
3. 勾选 `repo`（整项打勾即可）
4. 设个过期时间，点 **Generate token**
5. **复制那一长串 token**（只显示一次，存好）

> 如果 `night136/blog` 是空仓库，用 PAT 即可。
> 如果该仓库已有内容且你不想覆盖，请先告诉我，我帮你改成拉取合并流程。

---

## 第二步：执行推送

在 `blog-site/` 目录下，把下面命令里的 `你的TOKEN` 换成刚复制的 token，直接粘贴执行：

```bash
cd blog-site

git push https://你的TOKEN@github.com/night136/blog.git HEAD:main --force
```

> 说明：`HEAD:main` 把本地提交推到远程的 `main` 分支；`--force` 是因为空仓库/分支不存在时需要强制建立。
> 如果远程默认分支是 `master` 而不是 `main`，把命令里的 `main` 改成 `master`。

推送成功后，可以删掉命令行历史里的 token（或关掉终端窗口），token 不会留在仓库里。

---

## 第三步：在 Cloudflare Pages 连接部署

1. 登录 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **连接到 Git**
2. 授权 GitHub，选仓库 **night136/blog**
3. 构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `blog-site`
4. 点 **Save and Deploy**，几分钟后得到你的 `*.pages.dev` 域名

---

## 第四步（可选）：让 CMS 后台能登录写文章

纯静态站没有后端处理 OAuth 回调，Decap CMS 登录需要一个 GitHub OAuth App：

1. GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
   - **Homepage URL**: 你的 Pages 域名，如 `https://blog.xxx.pages.dev`
   - **Authorization callback URL**: `https://blog.xxx.pages.dev/admin/`
2. 拿到 **Client ID**（和可选的 Client Secret）
3. Cloudflare Pages 是纯静态，最简单的方式是用 **Netlify Identity（Implicit Grant）**——
   或者把站点部署到 Netlify 而非 Cloudflare，登录开箱即用。
   如果不换平台，可自托一个轻量 OAuth 中继（如 `decap-cms-oauth-provider`）。

---

## 之后日常发文章

**方式一（用后台）**：访问 `https://<你的域名>/admin/`，GitHub 登录后在可视化编辑器里写，点发布 → 自动 commit 回仓库 → Cloudflare 自动重新部署。

**方式二（手动）**：直接往 `content/posts/` 丢一个 `.md` 文件（格式见 README），然后：
```bash
git add -A && git commit -m "add post" && git push origin main
```
> 注意：新增 md 文件后，还要在 `assets/app.js` 顶部的 `POST_FILES` 数组里加上文件名，前台才会显示。
