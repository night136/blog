// /api/posts/search?q=关键词 —— 全文搜索（标题/摘要/正文）
import { readingTime } from "../../_lib/readingTime.js";
import { listCover, loadCoverMap } from "../../_lib/cover.js";

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

  // 结果上限：LIKE '%kw%' 无法走索引，必然全表扫描；不限制条数时，
  // 一旦文章变多，既慢又会把大量含 base64 图片的 body 一次性返回给前端。
  const MAX_RESULTS = 60;

  try {
    // 优先查询 views 列；若数据库尚未迁移则降级查询，views 显示 0
    let results;
    try {
      ({ results } = await env.BLOG_DB.prepare(
        `SELECT id, slug, title, date, tag, summary, cover, author_username, body, views FROM posts WHERE ${like} ORDER BY date DESC, id DESC LIMIT ?`
      ).bind(...params, MAX_RESULTS).all());
    } catch (e) {
      if (/no such column/i.test(e && e.message ? e.message : "")) {
        ({ results } = await env.BLOG_DB.prepare(
          `SELECT id, slug, title, date, tag, summary, cover, author_username, body FROM posts WHERE ${like} ORDER BY date DESC, id DESC LIMIT ?`
        ).bind(...params, MAX_RESULTS).all());
        results.forEach((row) => { row.views = 0; });
      } else throw e;
    }
    // 与列表接口同一套封面取值（见 listCover）：base64 内联封面不进结果（体积爆炸），
    // 但改用构建产物里的静态文件路径 —— 否则同一篇文章在首页有封面、在搜索结果里没有。
    const covMap = await loadCoverMap(env, request.url);
    const posts = results.map((row) => {
      const rt = readingTime(row.body);
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        date: row.date,
        tag: row.tag || "未分类",
        summary: row.summary || "",
        cover: listCover(row.cover, row.slug, covMap),
        author: row.author_username || "昉昕",
        readingMinutes: rt.minutes,
        words: rt.words,
        views: row.views || 0,
      };
    });
    return json({ ok: true, posts });
  } catch (e) {
    return json({ ok: false, error: "搜索失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
