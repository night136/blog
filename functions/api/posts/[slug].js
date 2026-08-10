// /api/posts/[slug]
//   GET : 取单篇文章（含 body），供前台文章详情页使用
//   PUT : 会员更新自己写的文章（author 必须 = 当前用户）
//   DELETE: 会员删除自己写的文章
import { verifyJWT, getCookie, json } from "./_lib/auth.js";

function publicPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: row.cover || "",
    author: row.author_username || "昉昕",
    body: row.body,
  };
}

function unauthorized() {
  return json({ error: "请先登录" }, 401);
}

export async function onRequestGet({ env, params }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  const slug = params.slug;
  try {
    const row = await env.BLOG_DB.prepare(
      "SELECT id, slug, title, date, tag, summary, cover, author_username, body FROM posts WHERE slug = ?"
    ).bind(slug).first();
    if (!row) return json({ error: "文章不存在" }, 404);
    return json({ ok: true, post: publicPost(row) });
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestDelete({ env, params, request }) {
  const token = getCookie(request, "auth");
  let username;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    username = payload.username || payload.sub || payload.name;
  } catch (e) { return unauthorized(); }
  if (!username) return unauthorized();
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);

  const row = await env.BLOG_DB.prepare(
    "SELECT author_username FROM posts WHERE slug = ?"
  ).bind(params.slug).first();
  if (!row) return json({ error: "文章不存在" }, 404);
  if (row.author_username !== username) return json({ error: "只能删除自己写的文章" }, 403);

  await env.BLOG_DB.prepare("DELETE FROM posts WHERE slug = ?").bind(params.slug).run();
  return json({ ok: true });
}