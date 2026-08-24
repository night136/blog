// /api/posts/search?q=关键词 —— 全文搜索（标题/摘要/正文）
export async function onRequestGet({ env, request }) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  const q = new URL(request.url).searchParams.get("q") || "";
  const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!tokens.length) return json({ ok: true, posts: [] });

  const like = tokens.map(() => "(title LIKE ? OR summary LIKE ? OR body LIKE ?)").join(" AND ");
  const params = [];
  tokens.forEach((t) => { const w = `%${t}%`; params.push(w, w, w); });

  try {
    const { results } = await env.BLOG_DB.prepare(
      `SELECT id, slug, title, date, tag, summary, cover, author_username FROM posts WHERE ${like} ORDER BY date DESC, id DESC`
    ).bind(...params).all();
    const posts = results.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      date: row.date,
      tag: row.tag || "未分类",
      summary: row.summary || "",
      cover: row.cover || "",
      author: row.author_username || "昉昕",
    }));
    return json({ ok: true, posts });
  } catch (e) {
    return json({ ok: false, error: "搜索失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
