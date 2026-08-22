// /api/posts/[slug]/comments
//   GET  : 取某篇文章的评论列表（按时间升序）
//   POST : 发表评论（游客可评，name 缺省“匿名”）
import { json } from "../_lib/auth.js";

const MAX_NAME = 40;
const MAX_CONTENT = 2000;

export async function onRequestGet({ env, params }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  try {
    const { results } = await env.BLOG_DB.prepare(
      "SELECT id, name, content, created_at FROM comments WHERE post_slug = ? ORDER BY created_at ASC, id ASC"
    ).bind(params.slug).all();
    return json({ ok: true, comments: results });
  } catch (e) {
    return json({ error: "读取评论失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost({ request, env, params }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const name = (body.name || "").trim().slice(0, MAX_NAME) || "匿名";
  const content = (body.content || "").trim();
  if (!content) return json({ ok: false, error: "评论内容不能为空" }, 400);
  if (content.length > MAX_CONTENT) return json({ ok: false, error: "评论过长（最多 2000 字）" }, 400);

  const created_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    const { meta } = await env.BLOG_DB.prepare(
      "INSERT INTO comments (post_slug, name, content, created_at) VALUES (?, ?, ?, ?)"
    ).bind(params.slug, name, content, created_at).run();
    return json({ ok: true, comment: { id: meta && meta.last_row_id, name, content, created_at } });
  } catch (e) {
    return json({ ok: false, error: "评论失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
