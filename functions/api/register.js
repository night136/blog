// 注册：POST /api/register
import { hashPassword, json, sessionCookie, signJWT } from "./_lib/auth.js";
import { verifyTurnstile, getClientIp } from "./_lib/turnstile.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BLOG_DB) {
      return json({ error: "服务端未配置数据库（BLOG_DB），请联系站长。" }, 500);
    }
    const body = await request.json();
    const username = (body.username || "").trim();
    const password = body.password || "";
    const email = (body.email || "").trim();

    if (!username || !password) return json({ error: "用户名和密码必填" }, 400);
    if (username.length < 2 || username.length > 32) return json({ error: "用户名长度需 2–32 位" }, 400);
    if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);

    // Turnstile 人机验证（未配置 TURNSTILE_SECRET_KEY 时自动跳过）
    const ts = await verifyTurnstile(
      body.turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      getClientIp(request)
    );
    if (!ts.success) {
      return json({ error: ts.error || "人机验证失败，请重试" }, 403);
    }

    // 检查用户名是否已存在
    const existing = await env.BLOG_DB.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind(username).first();
    if (existing) return json({ error: "该用户名已被注册" }, 409);

    const salt = crypto.randomUUID();
    const pwHash = await hashPassword(password, salt);

    await env.BLOG_DB.prepare(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)"
    ).bind(username, email || null, salt + ":" + pwHash).run();

    const secret = env.JWT_SECRET || "dev-secret-change-me";
    const token = await signJWT(
      { sub: username, name: username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
      secret
    );
    return json(
      { ok: true, user: { username, email } },
      200,
      { "Set-Cookie": sessionCookie(token, 7 * 24 * 3600) }
    );
  } catch (e) {
    return json({ error: "注册失败：" + (e && e.message ? e.message : e) }, 500);
  }
}