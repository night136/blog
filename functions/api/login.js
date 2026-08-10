// 登录：POST /api/login
import { verifyPassword, json, sessionCookie, signJWT } from "./_lib/auth.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BLOG_USERS) {
      return json({ error: "服务端未配置用户存储（BLOG_USERS KV），请联系站长。" }, 500);
    }
    const body = await request.json();
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) return json({ error: "请输入用户名和密码" }, 400);

    // 支持用邮箱或用户名登录
    let key = "user:" + username;
    if (username.includes("@")) {
      const mapped = await env.BLOG_USERS.get("email:" + username.toLowerCase());
      if (mapped) key = "user:" + mapped;
    }
    const raw = await env.BLOG_USERS.get(key);
    if (!raw) return json({ error: "用户不存在" }, 401);

    const user = JSON.parse(raw);
    const ok = await verifyPassword(password, user.pw);
    if (!ok) return json({ error: "密码错误" }, 401);

    const secret = env.JWT_SECRET || "dev-secret-change-me";
    const token = await signJWT(
      { sub: user.username, name: user.username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
      secret
    );
    return json(
      { ok: true, user: { username: user.username, email: user.email } },
      200,
      { "Set-Cookie": sessionCookie(token, 7 * 24 * 3600) }
    );
  } catch (e) {
    return json({ error: "登录失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
