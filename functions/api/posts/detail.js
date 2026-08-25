// /api/posts/detail
//   POST : 取单篇文章（含 body）。slug 通过 JSON body 传递，避免 URL 百分号编码
//          在部分国产浏览器（如小米浏览器）fetch 中被二次编码/损坏的问题。
import { json, getCookie, verifyJWT } from "../_lib/auth.js";
import { readingTime } from "../../_lib/readingTime.js";

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
  const rt = readingTime(row.body);
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
    readingMinutes: rt.minutes,
    words: rt.words,
    body: row.body,
  };
}

export async function onRequestPost({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "请求格式错误" }, 400); }
  const slug = (body.slug || "").toString();
  if (!slug) return json({ error: "缺少 slug" }, 400);

  // 边缘缓存：详情响应体可能含 base64 大图（单篇数百 KB～1MB+），从源站到边缘的传输是主要开销。
  // POST 请求 CDN 不自动缓存，且 Cache API 不缓存非 GET 响应，故用 GET 形式的 key 绕过限制。
  // 缓存 180s；命中时仍执行阅读数 +1，并 SELECT 真实 views 返回（轻量、不含 body），保证计数准确。
  const cache = caches.default;
  const cacheUrl = new Request(
    `${new URL(request.url).origin}/api/posts/detail-cache?slug=${encodeURIComponent(slug)}`,
    { method: "GET" }
  );
  try {
    const cached = await cache.match(cacheUrl);
    if (cached) {
      const username = await getUsername(request, env);
      const data = await cached.json();
      const author = (data.post && data.post.author) || "";
      if (!(username && username === author)) {
        try {
          await env.BLOG_DB.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind(slug).run();
        } catch (_) {}
      }
      try {
        const fresh = await env.BLOG_DB.prepare("SELECT views FROM posts WHERE slug = ?").bind(slug).first();
        if (data.post) data.post.views = (fresh && fresh.views) || 0;
      } catch (_) {}
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }
  } catch (_) { /* Cache API 不可用时降级直连 D1 */ }

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
    const payload = { ok: true, post: publicPost(row, username) };
    const bodyStr = JSON.stringify(payload);
    const response = new Response(bodyStr, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    // 写入边缘缓存（克隆，避免正文流被消费）：缓存含当时 views 快照的大响应体
    try {
      await cache.put(
        cacheUrl,
        new Response(bodyStr, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=180, s-maxage=180",
          },
        })
      );
    } catch (_) {}
    return response;
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
