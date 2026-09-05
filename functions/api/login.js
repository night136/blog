// 登录：POST /api/login
import { verifyPassword, json, sessionCookie, signJWT, jwtSecret } from "./_lib/auth.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BLOG_DB) {
      return json({ error: "服务端未配置数据库（BLOG_DB），请联系站长。" }, 500);
    }
    const body = await request.json();
    const id = (body.username || "").trim();
    const password = body.password || "";
    if (!id || !password) return json({ error: "请输入用户名和密码" }, 400);

    // 同时支持用户名或邮箱登录
    const user = await env.BLOG_DB.prepare(
      "SELECT username, email, password_hash FROM users WHERE username = ? OR email = ?"
    ).bind(id, id.toLowerCase()).first();

    if (!user) return json({ error: "用户不存在" }, 401);

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return json({ error: "密码错误" }, 401);

    const secret = jwtSecret(env);
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