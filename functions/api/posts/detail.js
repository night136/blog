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
    views: row.views || 0,
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
    // 优先尝试带 views 列的查询；若数据库尚未执行迁移（缺 views 列）则自动降级，
    // 保证文章仍可正常打开，浏览量暂时显示 0。
    let row;
    try {
      row = await env.BLOG_DB.prepare(
        "SELECT id, slug, title, date, tag, summary, cover, author_username, views, body FROM posts WHERE slug = ?"
      ).bind(slug).first();
    } catch (e) {
      if (/no such column/i.test(e && e.message ? e.message : "")) {
        row = await env.BLOG_DB.prepare(
          "SELECT id, slug, title, date, tag, summary, cover, author_username, body FROM posts WHERE slug = ?"
        ).bind(slug).first();
        row.views = 0;
      } else throw e;
    }
    if (!row) return json({ error: "文章不存在" }, 404);
    // 浏览量：非作者本人访问才 +1（避免自己看自己的文章虚增）；列不存在时静默跳过
    const author = row.author_username || "昉昕";
    if (!(username && username === author)) {
      try {
        await env.BLOG_DB.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind(slug).run();
        row.views = (row.views || 0) + 1;
      } catch (_) {}
    }
    return json({ ok: true, post: publicPost(row, username) });
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
