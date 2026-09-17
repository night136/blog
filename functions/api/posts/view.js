// /api/posts/view
//   POST : 文章阅读数 +1（非作者本人），返回最新 views。
//          供静态预渲染详情打开时调用，因为静态 JSON 不会执行 Function 的 +1 逻辑。
import { json, getCookie, verifyJWT, jwtSecret } from "../_lib/auth.js";
import { bumpViews } from "../_lib/views.js";

async function getUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const payload = await verifyJWT(token, jwtSecret(env));
    return payload.username || payload.sub || payload.name || null;
  } catch (e) { return null; }
}

export async function onRequestPost({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "请求格式错误" }, 400); }
  const slug = (body.slug || "").toString();
  if (!slug) return json({ error: "缺少 slug" }, 400);
  const username = await getUsername(request, env);
  try {
    const row = await env.BLOG_DB.prepare(
      "SELECT author_username FROM posts WHERE slug = ?"
    ).bind(slug).first();
    if (!row) return json({ error: "文章不存在" }, 404);
    const author = row.author_username || "昉昕";
    let views = null;
    let how = "skip";
    // 非作者本人访问才 +1（避免自己看自己的文章虚增）
    if (!(username && username === author)) {
      // 一次往返拿到自增后的真实值（旧实现是「读旧值 → 自增 → 用旧值 +1 返回」，并发下会少报）
      const r = await bumpViews(env.BLOG_DB, slug);
      views = r.views;
      how = r.how;
    } else {
      // 作者自己看：不 +1，但也要如实回报当前值
      const cur = await env.BLOG_DB.prepare("SELECT views FROM posts WHERE slug = ?").bind(slug).first();
      views = cur ? Number(cur.views || 0) : null;
    }
    if (views == null) views = 0;
    return json({ ok: true, views }, 200, { "X-Views-Atomic": how === "returning" ? "1" : "0" });
  } catch (e) {
    return json({ error: "更新失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
