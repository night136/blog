# Decap CMS 登录与发文章指南

Decap CMS 的后台地址是：

```
https://<你的站点域名>/admin/
```

首次使用需要 **GitHub OAuth App** 授权登录。

---

## 第一步：创建 GitHub OAuth App

1. 打开 https://github.com/settings/developers
2. 左侧选择 **OAuth Apps** → 点 **New OAuth App**
3. 填写：
   - **Application name**：`blog-cms`（随便写）
   - **Homepage URL**：你的站点首页，如
     - `https://blog.zhongfangxin682.workers.dev`
     - 或你绑定的自定义域名 `https://blog.example.com`
   - **Application description**（可选）：`Decap CMS for my blog`
   - **Authorization callback URL**：必须是
     - `https://blog.zhongfangxin682.workers.dev/admin/`
     - 或 `https://blog.example.com/admin/`
     - **注意**：末尾的 `/` 不能少，否则 CMS 会报 `Unable to parse` 错误。
4. 点 **Register application**
5. 页面跳转后，能看到 **Client ID**。点 **Generate a new client secret**，复制 secret。

---

## 第二步：处理 OAuth 回调（Cloudflare Pages 是静态站，需要中继）

Decap CMS 用 GitHub 登录时，GitHub 会把用户重定向到 **Authorization callback URL**，这个地址必须能处理 code 并换取 token。

Cloudflare Pages 是纯静态托管，没有后端，所以需要选一个方案：

### 方案 A：部署到 Netlify（最简单，自带 Identity）

如果你愿意把站点从 Cloudflare Pages 迁移到 Netlify：

1. 在 Netlify 创建站点，连接 `night136/blog` 仓库
2. 构建设置：
   - Build command: 留空
   - Publish directory: `blog-site`
3. 进入站点设置 → **Identity** → **Enable Identity**
4. 把 `admin/config.yml` 的 `backend` 改成：
   ```yaml
   backend:
     name: git-gateway
     branch: main
   ```
5. 在 GitHub OAuth App 里把 callback URL 改成 Netlify 的 `https://<你的netlify域名>/admin/`
6. 开启 Git Gateway：Netlify → Site settings → Identity → Services → Git Gateway → Enable

Netlify 的 Git Gateway 会自动处理 OAuth，登录最省心。

### 方案 B：保留 Cloudflare Pages + 自托 OAuth 中继（推荐保持 Cloudflare 时使用）

不想换平台的话，需要一个小型 OAuth 中继服务。这里用一个社区常用的 Node 脚本 [`decap-cms-oauth-provider`](https://github.com/vencax/netlify-cms-oauth-provider)：

#### 1. 新建一个 Cloudflare Worker（或 Node 服务器）

在 Cloudflare 控制台 → **Workers & Pages** → **Create application** → **Create Worker**。

把默认脚本替换成下面这个（简化版，直接支持 GitHub OAuth）：

```js
// Cloudflare Worker: 处理 Decap CMS OAuth 回调
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const provider = "github";

    if (!code) {
      // 第 1 步：把用户导向 GitHub 授权
      const clientId = env.GITHUB_CLIENT_ID;
      const scope = "repo";
      const redirectUri = encodeURIComponent(url.origin + url.pathname);
      return Response.redirect(
        `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}`,
        302
      );
    }

    // 第 2 步：用 code 换 access_token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    // 返回给 Decap CMS 的回调页面
    const html = `
<!DOCTYPE html>
<html>
  <body>
    <script>
      window.opener.postMessage(
        'authorization:github:success:{"provider":"github","token":"${tokenData.access_token}"}',
        "*"
      );
      window.close();
    </script>
  </body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },
};
```

#### 2. 设置环境变量

在 Worker → Settings → Variables：

- `GITHUB_CLIENT_ID`：你的 OAuth App Client ID
- `GITHUB_CLIENT_SECRET`：你的 OAuth App Client Secret

#### 3. 把 Worker 路由绑定到 `/oauth/callback`

Worker → Triggers → Add Custom Domain 或 Route：

- Route: `blog.zhongfangxin682.workers.dev/oauth/callback`

或者更简单：给 Worker 一个子域名如 `oauth.yourdomain.workers.dev`，然后在 GitHub OAuth App 的 callback URL 里填这个 Worker 地址。

#### 4. 修改 admin/config.yml

Decap CMS 的 `backend` 默认用 GitHub OAuth，回调地址是 `<site_url>/admin/`。要让 CMS 用你自己的 Worker，需要自定义 `auth_endpoint`（不是所有版本都支持，Decap 2.x+ 支持 `auth_endpoint`）：

```yaml
backend:
  name: github
  repo: night136/blog
  branch: main
  auth_endpoint: https://oauth.yourdomain.workers.dev  # 你的 Worker 地址
```

**注意**：如果 Worker 路由和站点同域，callback URL 要填 Worker 地址，并在 Worker 内处理 `redirect_uri`。

---

## 第三步：改 `admin/config.yml` 里的站点域名

把 `site_url` 和 `display_url` 改成你的真实域名：

```yaml
site_url: https://blog.zhongfangxin682.workers.dev
display_url: https://blog.zhongfangxin682.workers.dev
```

---

## 第四步：用 CMS 发文章

1. 打开 `https://<你的域名>/admin/`
2. 点 **Login with GitHub**
3. 授权后进入后台
4. 点 **New Posts** 写文章
5. 填标题、日期、分类、摘要、正文
6. 保存后 Decap 会自动在 GitHub 创建一个 Pull Request / Draft PR
7. 在 CMS 里把状态从 **Draft** → **In Review** → **Ready** → **Publish**
8. 发布后，Cloudflare Pages 会检测到 `main` 分支更新并自动重新部署

---

## 常见问题

### 登录后白屏 / 报错 `Unable to parse`

多半是 GitHub OAuth App 的 **Authorization callback URL** 末尾少了 `/`，或和 `site_url` 不一致。

### 发布后网站没更新

- 检查 GitHub 仓库 `main` 分支是否真的收到了新的 commit
- 检查 Cloudflare Pages 的 **Deployments** 里有没有新的构建
- 如果用了 editorial workflow，发布时 Decap 会合并一个 PR，确认 PR 已合并

### 图片上传失败

- 检查 `media_folder` 路径是否正确
- 确认 OAuth token 有 `repo` 权限（能写仓库文件）
