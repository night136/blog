# OAuth Worker（Decap CMS 登录中继）

这个 Cloudflare Worker 让 Decap CMS（`/admin/`）能用 GitHub 账号登录写文章。
Cloudflare Pages 是纯静态站，没有后端处理 OAuth 回调，所以单独用一个 Worker 来干这事。

## 它做什么

1. CMS 打开弹窗访问 `https://<本Worker>/oauth/authorize`
2. Worker 把用户重定向到 GitHub 授权页
3. 用户在 GitHub 同意授权，GitHub 带着 `code` 跳回 `https://<本Worker>/oauth/callback`
4. Worker 用 `code` 向 GitHub 换取 `access_token`
5. Worker 返回一段 HTML，把 token 通过 `postMessage` 发给 CMS 弹窗 → 登录完成

## 部署方式（任选其一）

### 方式 A：Cloudflare 控制台（无需本地环境，推荐）

1. 登录 https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**
2. Worker 名称填 `blog-oauth-provider`
3. 把默认代码**全部删掉**，粘贴 `index.js` 的内容
4. 点 **Deploy**
5. 部署后进入该 Worker → **Settings** → **Variables**
   - 加一个 **Variable**（明文）：`GITHUB_CLIENT_ID` = 你的 OAuth App 的 Client ID
   - 加一个 **Secret**（加密）：`GITHUB_CLIENT_SECRET` = 你的 OAuth App 的 Client Secret
6. 记下这个 Worker 的地址，形如 `https://blog-oauth-provider.<你的子域>.workers.dev`

### 方式 B：命令行（wrangler）

```bash
cd oauth-worker
# 装 wrangler（若未装）
npm install -g wrangler
# 登录
wrangler login
# 设置密钥（会交互式让你输入 Client Secret）
wrangler secret put GITHUB_CLIENT_SECRET
# 在 wrangler.toml 里把 GITHUB_CLIENT_ID 填成变量，或也用 secret
wrangler secret put GITHUB_CLIENT_ID
# 部署
wrangler deploy
```

部署后地址：`https://blog-oauth-provider.<你的子域>.workers.dev`

## 关键：GitHub OAuth App 的回调地址

在你创建的 GitHub OAuth App 里，**Authorization callback URL** 必须填：

```
https://blog-oauth-provider.<你的子域>.workers.dev/oauth/callback
```

（即 Worker 地址 + `/oauth/callback`，**末尾不要加 `/`**）

## 然后

把 `admin/config.yml` 的 `backend.auth_endpoint` 改成这个 Worker 地址，
把 `site_url` / `display_url` 改成你的博客域名，重新部署即可。
详见根目录 `CMS-OAUTH.md`。
