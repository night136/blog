// 当前会话：GET /api/me
import { verifyJWT, json, getCookie } from "./_lib/auth.js";

export async function onRequest({ request, env }) {
  const token = getCookie(request, "auth");
  if (!token) return json({ user: null }, 200);
  try {
    const secret = env.JWT_SECRET || "dev-secret-change-me";
    const payload = await verifyJWT(token, secret);
    return json({ user: { username: payload.name, sub: payload.sub } }, 200);
  } catch (e) {
    // token 无效或过期：视为未登录
    return json({ user: null }, 200);
  }
}
