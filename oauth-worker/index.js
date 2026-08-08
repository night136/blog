// Cloudflare Worker —— 作为 Decap CMS 的 GitHub OAuth 中继
// 部署后，把本 Worker 的地址填到 admin/config.yml：
//   backend.base_url: https://<本Worker域名>
//   backend.auth_endpoint: /oauth/authorize
// GitHub OAuth App 的「Authorization callback URL」必须填： https://<本Worker域名>/oauth/callback
//
// 环境变量（在 Worker 设置里配置）：
//   GITHUB_CLIENT_ID     —— OAuth App 的 Client ID
//   GITHUB_CLIENT_SECRET —— OAuth App 的 Client Secret（建议用 Secret 类型，不要明文）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 第 1 步：把用户导向 GitHub 授权页 ──
    if (path === "/oauth/authorize" || path === "/auth" || path === "/") {
      const clientId = env.GITHUB_CLIENT_ID;
      const scope = "repo"; // Decap 需要写仓库权限
      const redirectUri = `${url.origin}/oauth/callback`;
      const state = url.searchParams.get("state") || crypto.randomUUID();
      const githubUrl =
        `https://github.com/login/oauth/authorize` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&scope=${encodeURIComponent(scope)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      return Response.redirect(githubUrl, 302);
    }

    // ── 第 2 步：GitHub 带着 code 跳回这里，我们用 code 换 token，再回传给 CMS 弹窗 ──
    if (path === "/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code parameter", { status: 400 });
      }

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;
      if (!token) {
        return new Response(
          "Token exchange failed: " + JSON.stringify(tokenData),
          { status: 400 }
        );
      }

      // Decap CMS 的弹窗会监听 'authorization:github:success:' 消息
      const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorizing…</title></head>
  <body>
    <script>
      window.opener.postMessage(
        'authorization:github:success:' + JSON.stringify({
          provider: 'github',
          token: '${token}'
        }),
        '*'
      );
      window.close();
    </script>
  </body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
