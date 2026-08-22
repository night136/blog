// /api/posts/[slug]/comments
//   GET  : 取某篇文章的评论列表（按时间升序，含 likes）
//   POST : action=create 发表 / action=like 点赞 / action=delete 删除（仅楼主）
import { json, getCookie, verifyJWT } from "../../_lib/auth.js";

const MAX_NAME = 40;
const MAX_CONTENT = 2000;

// 从 Cookie 解析当前登录用户名（楼主校验用）；无效/未登录返回 null
async function currentUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const secret = env.JWT_SECRET || "dev-secret-change-me";
    const payload = await verifyJWT(token, secret);
    return payload.name || null;
  } catch (e) { return null; }
}

export async function onRequestGet({ env, params }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  try {
    const { results } = await env.BLOG_DB.prepare(
      "SELECT id, name, content, created_at, parent_id, COALESCE(likes,0) AS likes FROM comments WHERE post_slug = ? ORDER BY created_at ASC, id ASC"
    ).bind(params.slug).all();
    return json({ ok: true, comments: results });
  } catch (e) {
    return json({ error: "读取评论失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost({ request, env, params }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "请求格式错误" }, 400); }

  const action = (body.action || "create").toLowerCase();

  // ---- 点赞（游客可点，前端 localStorage 去重） ----
  if (action === "like") {
    const id = Number(body.id);
    if (!id) return json({ ok: false, error: "缺少评论 id" }, 400);
    try {
      const { meta } = await env.BLOG_DB.prepare(
        "UPDATE comments SET likes = COALESCE(likes,0) + 1 WHERE id = ? AND post_slug = ?"
      ).bind(id, params.slug).run();
      if (!meta || meta.changes === 0) return json({ ok: false, error: "评论不存在" }, 404);
      const { results } = await env.BLOG_DB.prepare("SELECT COALESCE(likes,0) AS likes FROM comments WHERE id = ?").bind(id).all();
      const likes = results[0] ? results[0].likes : 0;
      return json({ ok: true, likes });
    } catch (e) { return json({ ok: false, error: "点赞失败：" + (e && e.message ? e.message : e) }, 500); }
  }

  // ---- 删除（仅楼主） ----
  if (action === "delete") {
    const id = Number(body.id);
    if (!id) return json({ ok: false, error: "缺少评论 id" }, 400);
    const username = await currentUsername(request, env);
    if (!username) return json({ ok: false, error: "请先登录后再删除评论" }, 401);
    try {
      const { results } = await env.BLOG_DB.prepare(
        "SELECT p.author_username AS author FROM comments c JOIN posts p ON p.slug = c.post_slug WHERE c.id = ? AND c.post_slug = ?"
      ).bind(id, params.slug).all();
      if (!results.length) return json({ ok: false, error: "评论不存在" }, 404);
      if (results[0].author !== username) return json({ ok: false, error: "只有楼主可以删除评论" }, 403);
      await env.BLOG_DB.prepare("DELETE FROM comments WHERE (id = ? OR parent_id = ?) AND post_slug = ?").bind(id, id, params.slug).run();
      return json({ ok: true });
    } catch (e) { return json({ ok: false, error: "删除失败：" + (e && e.message ? e.message : e) }, 500); }
  }

  // ---- 发表评论（支持楼中楼 parent_id） ----
  const name = (body.name || "").trim().slice(0, MAX_NAME) || "匿名";
  const content = (body.content || "").trim();
  if (!content) return json({ ok: false, error: "评论内容不能为空" }, 400);
  if (content.length > MAX_CONTENT) return json({ ok: false, error: "评论过长（最多 2000 字）" }, 400);

  let parent_id = Number(body.parent_id) || 0;
  if (parent_id) {
    const { results: pr } = await env.BLOG_DB.prepare("SELECT id FROM comments WHERE id = ? AND post_slug = ?").bind(parent_id, params.slug).all();
    if (!pr.length) return json({ ok: false, error: "回复的评论不存在" }, 400);
  }

  const created_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    const { meta } = await env.BLOG_DB.prepare(
      "INSERT INTO comments (post_slug, name, content, created_at, parent_id, likes) VALUES (?, ?, ?, ?, ?, 0)"
    ).bind(params.slug, name, content, created_at, parent_id).run();
    return json({ ok: true, comment: { id: meta && meta.last_row_id, name, content, created_at, parent_id, likes: 0 } });
  } catch (e) { return json({ ok: false, error: "评论失败：" + (e && e.message ? e.message : e) }, 500); }
}
