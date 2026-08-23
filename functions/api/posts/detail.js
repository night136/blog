// /api/posts/detail
//   POST : 取单篇文章（含 body）。slug 通过 JSON body 传递，避免 URL 百分号编码
//          在部分国产浏览器（如小米浏览器）fetch 中被二次编码/损坏的问题。
import { json, getCookie, verifyJWT } from "../_lib/auth.js";

async function getUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET || "dev-secret-change-me");
    return payload.username || payload.sub || payload.name || null;
  } catch (e) { return null; }
}

function publicPost(row, username) {
  const author = row.author_username || "昉昕";
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: row.cover || "",
    author,
    isAuthor: !!(username && username === author),
    body: row.body,
  };
}

export async function onRequestPost({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "请求格式错误" }, 400); }
  const slug = (body.slug || "").toString();
  if (!slug) return json({ error: "缺少 slug" }, 400);
  try {
    const username = await getUsername(request, env);
    const row = await env.BLOG_DB.prepare(
      "SELECT id, slug, title, date, tag, summary, cover, author_username, body FROM posts WHERE slug = ?"
    ).bind(slug).first();
    if (!row) return json({ error: "文章不存在" }, 404);
    return json({ ok: true, post: publicPost(row, username) });
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
