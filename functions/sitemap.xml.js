// /sitemap.xml —— 动态生成站点地图（从 D1 读取全部文章）
import { siteUrl, xesc, postUrl } from "./_lib/seo.js";

// ⚠️ audit §七 #11：这个端点以前**完全没有 Cache-Control** ⇒ 每个爬虫每次来都打一遍 D1。
// 内容只在发文时变，所以给浏览器 5 分钟、边缘 30 分钟；SWR 让边缘先回旧版再后台更新。
const OK_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
};

// ⚠️ 错误响应**绝不能可缓存**：D1 一次抖动就会让「坏 sitemap」在每个爬虫面前挂半小时，
//    比不缓存还糟。（sitemap 是爬虫唯一的发现入口，缓存的坏结果会被搜索引擎长期记住。）
const ERR_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" };

export async function onRequestGet({ env, request }) {
  // ⚠️⚠️ **只加 Cache-Control 标头是不够的** —— 必须用 Cache API 显式写边缘缓存。
  //    2026-09-17 实测（一次性探针，同形态对照）：
  //      /api/posts/meta（用了 Cache API）→ cf-cache-status: HIT
  //      /api/_probe-a   （同 Content-Type、同 s-maxage、只是没用 Cache API）→ 连
  //      cf-cache-status 都不出现，边缘根本没缓存 ⇒ 每次请求照样打 D1。
  //    同一条结论仓库里早有记录：functions/api/posts.js:58。
  //    所以「加了 max-age 就不打 D1」是**错的**，光有标头只有浏览器会缓存。
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (_) { /* Cache API 不可用时降级为直连 D1 */ }

  if (!env.BLOG_DB) return new Response("<!-- BLOG_DB not configured -->", { status: 500, headers: ERR_HEADERS });
  try {
    const { results } = await env.BLOG_DB.prepare(
      "SELECT slug, date FROM posts ORDER BY date DESC, id DESC"
    ).all();
    const urls = results
      .map((r) => {
        const lastmod = (r.date || "").replace(/-/g, "");
        return `  <url><loc>${xesc(postUrl(env, r.slug))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
      })
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    const res = new Response(xml, { headers: OK_HEADERS });
    // ⚠️ 只有成功响应才写入缓存：把错误塞进边缘缓存 = 亲手把坏 sitemap 钉在所有爬虫面前。
    try { await cache.put(cacheKey, res.clone()); } catch (_) {}
    return res;
  } catch (e) {
    // ⚠️ catch 里必须 console.error：只把错误写进 XML 注释的话，
    //    「sitemap 一直是空的」在 crawl 日志里看不见，只能靠人肉 grep 才发现（三类静默失败之一）。
    console.error("[sitemap] 生成失败：" + (e && e.message ? e.message : e));
    return new Response("<!-- error: " + (e && e.message ? e.message : e) + " -->", { status: 500, headers: ERR_HEADERS });
  }
}
