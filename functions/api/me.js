// 当前会话：GET /api/me
import { verifyJWT, json, getCookie, isOwner, jwtSecret } from "./_lib/auth.js";

// ⚠️ 本接口回答的是「谁在登录」，绝不能进任何缓存：
//  - 浏览器缓存会把一个账号的会话给到同一浏览器里的另一个账号；
//  - 登出后若命中旧响应，界面会一直显示已登录。
// 原实现没有显式声明缓存策略，等于把判断权交给浏览器对「无缓存头响应」的启发式规则
// （哪天 Cloudflare 给响应补上 Last-Modified 就会被按比例缓存），太不可控 —— 显式钉住。
const NO_STORE = { "Cache-Control": "no-store" };

export async function onRequest({ request, env }) {
  const token = getCookie(request, "auth");
  if (!token) return json({ user: null }, 200, NO_STORE);
  try {
    const secret = jwtSecret(env);
    const payload = await verifyJWT(token, secret);
    const username = payload.username || payload.name || payload.sub || null;
    const owner = isOwner(username, env);
    return json({ user: { username, sub: payload.sub || null, isOwner: owner } }, 200, NO_STORE);
  } catch (e) {
    // token 无效或过期：视为未登录
    return json({ user: null }, 200, NO_STORE);
  }
}
