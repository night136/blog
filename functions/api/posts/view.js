// /api/posts/view
//   POST : 文章阅读数 +1（非作者本人），返回最新 views。
//          供静态预渲染详情打开时调用，因为静态 JSON 不会执行 Function 的 +1 逻辑。
import { json, getCookie, verifyJWT } from "../_lib/auth.js";

async function getUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET || "dev-secret-change-me");
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
      "SELECT author_username, views FROM posts WHERE slug = ?"
    ).bind(slug).first();
    if (!row) return json({ error: "文章不存在" }, 404);
    const author = row.author_username || "昉昕";
    let views = row.views || 0;
    // 非作者本人访问才 +1（避免自己看自己的文章虚增）
    if (!(username && username === author)) {
      await env.BLOG_DB.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind(slug).run();
      views = (row.views || 0) + 1;
    }
    return json({ ok: true, views });
  } catch (e) {
    return json({ error: "更新失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
