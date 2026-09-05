// 当前会话：GET /api/me
import { verifyJWT, json, getCookie, isOwner, jwtSecret } from "./_lib/auth.js";

export async function onRequest({ request, env }) {
  const token = getCookie(request, "auth");
  if (!token) return json({ user: null }, 200);
  try {
    const secret = jwtSecret(env);
    const payload = await verifyJWT(token, secret);
    const username = payload.username || payload.name || payload.sub || null;
    const owner = isOwner(username, env);
    return json({ user: { username, sub: payload.sub || null, isOwner: owner } }, 200);
  } catch (e) {
    // token 无效或过期：视为未登录
    return json({ user: null }, 200);
  }
}
