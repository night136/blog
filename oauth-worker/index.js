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

      // Decap CMS 的双向握手协议：
      // ① 先发 "authorizing:github" 告诉 CMS 要授权了
      // ② CMS 回复确认后，再发 token（字符串格式：authorization:github:success:{JSON}）
      // ③ 如果 3 秒没收到回复，兜底发送（默认 origin 为 *）
      const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorizing…</title></head>
  <body>
    <p style="text-align:center;font-family:sans-serif;margin-top:40px;">
      授权成功，正在返回博客后台…
    </p>
    <script>
      var tokenData = ${JSON.stringify({ provider: 'github', token: token })};
      var responded = false;

      // 发送 token 到指定 origin
      function sendToken(targetOrigin) {
        if (responded) return;
        responded = true;
        window.opener.postMessage(
          'authorization:github:success:' + JSON.stringify(tokenData),
          targetOrigin
        );
        setTimeout(function() { window.close(); }, 200);
      }

      // 兜底：3 秒后强制发送
      var fallback = setTimeout(function() { sendToken('*'); }, 3000);

      // ② 等待 CMS 回复确认
      window.addEventListener('message', function receiveMessage(e) {
        clearTimeout(fallback);
        sendToken(e.origin);
      });

      // ① 告诉 CMS "我要开始授权了"
      window.opener.postMessage('authorizing:github', '*');
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
