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

    // ⚠️ 不区分「用户不存在」与「密码错误」：两种情况的文案必须完全一致，
    // 否则攻击者可据此枚举出哪些用户名/邮箱已注册。同理，用户不存在时也走一次
    // 假哈希校验，让响应耗时与真实校验相当，避免时序侧信道。
    // 注意假哈希必须符合 "salt:hash" 格式（见 auth.js verifyPassword），
    // 否则会因 indexOf(":") < 0 直接返回 false，跳过 PBKDF2 计算而重新产生时序差异。
    const DUMMY_HASH = "AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return json({ error: "用户名或密码错误" }, 401);

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
    // 不回显 e.message：可能泄露表结构 / SQL 细节。仅记录到服务端日志。
    console.error("login failed:", e && e.stack ? e.stack : e);
    return json({ error: "登录失败，请稍后重试" }, 500);
  }
}