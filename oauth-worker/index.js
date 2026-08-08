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

      // Decap CMS 完整握手协议（多重保险）：
      // ① 发 "authorizing:github" 告知 CMS
      // ② 监听 CMS 回复
      // ③ 同时 100ms/1s/3s 三次兜底，发送 token（多重格式）
      // ④ 30 秒后才关闭（不急）
      const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorizing…</title>
  <style>
    body { font-family: -apple-system, sans-serif; text-align: center; padding: 40px; background: #f5f5f7; }
    .ok { color: #2c7; font-size: 18px; margin: 20px 0; }
    .sub { color: #666; font-size: 13px; }
    button { padding: 10px 24px; background: #d52b5b; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 14px; margin-top: 20px; }
  </style>
  </head>
  <body>
    <p class="ok">✓ 授权成功！</p>
    <p class="sub">正在返回博客后台… 如果页面没自动跳转，请点击下方按钮手动关闭。</p>
    <button onclick="window.close()">关闭此窗口</button>
    <script>
      var tokenData = ${JSON.stringify({ provider: 'github', token: token })};
      var sent = false;

      function sendToken(targetOrigin) {
        if (sent) return;
        sent = true;
        try {
          // 格式 1: 字符串格式（Decap CMS 期望的标准）
          window.opener.postMessage(
            'authorization:github:success:' + JSON.stringify(tokenData),
            targetOrigin
          );
          // 格式 2: 对象格式（一些 Decap 版本/其他 CMS 可能用）
          window.opener.postMessage(
            { type: 'authorization:github:success', provider: 'github', token: tokenData.token },
            targetOrigin
          );
        } catch (e) {
          console.error('postMessage failed:', e);
        }
      }

      // 100ms 后立刻发（不等 CMS 回复，最大兼容）
      setTimeout(function() { sendToken('*'); }, 100);

      // 同时监听 CMS 回复（如果 CMS 用新的握手协议）
      window.addEventListener('message', function(e) {
        sendToken(e.origin);
      });

      // ① 发起握手
      try {
        window.opener.postMessage('authorizing:github', '*');
      } catch (e) {
        console.error('handshake failed:', e);
      }

      // 30 秒后自动关闭（防止长时间挂着）
      setTimeout(function() { window.close(); }, 30000);
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
