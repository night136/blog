// /feed.xml —— RSS 2.0 订阅源（取最近 20 篇）
import { siteUrl, xesc, postUrl } from "./_lib/seo.js";

// ⚠️ audit §七 #11：以前没有 Cache-Control ⇒ 每次拉订阅源都打一遍 D1。
// 与 /sitemap.xml 同策略（两者是同一批数据的两种呈现）。
const OK_HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
};

// ⚠️ 读库失败时仍然回 200（订阅器对非 200 常常直接报「源坏了」），
//    但**必须 no-store** —— 否则一个空 feed 会被缓存 30 分钟，所有订阅者一起空窗。
const ERR_HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": "no-store",
};

export async function onRequestGet({ env, request }) {
  // ⚠️⚠️ 只加标头不够：Pages Functions **不会**因 s-maxage 自动走 CDN 缓存，
  //    必须用 Cache API 显式写边缘（同 functions/api/posts.js:58、实测对照见 sitemap.xml.js 注释）。
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (_) { /* Cache API 不可用时降级为直连 D1 */ }

  const base = siteUrl(env);
  let items = "";
  let dbError = false;
  if (env.BLOG_DB) {
    try {
      const { results } = await env.BLOG_DB.prepare(
        "SELECT slug, title, date, summary, tag FROM posts ORDER BY date DESC, id DESC LIMIT 20"
      ).all();
      items = results
        .map((r) => {
          const link = postUrl(env, r.slug);
          const pubDate = r.date ? new Date(r.date + "T08:00:00+08:00").toUTCString() : "";
          return [
            `    <item>`,
            `      <title>${xesc(r.title)}</title>`,
            `      <link>${xesc(link)}</link>`,
            `      <guid isPermaLink="false">${xesc(link)}</guid>`,
            pubDate ? `      <pubDate>${pubDate}</pubDate>` : "",
            `      <category>${xesc(r.tag || "未分类")}</category>`,
            `      <description>${xesc(r.summary || "")}</description>`,
            `    </item>`,
          ].join("\n");
        })
        .join("\n");
    } catch (e) {
      // ⚠️ catch 里必须 console.error：原来只把错误写成 XML 注释，
      //    「订阅源一直是空的」在日志里完全看不见（三类静默失败之一）。
      console.error("[feed] 读取文章失败：" + (e && e.message ? e.message : e));
      dbError = true;
      items = `    <!-- error: ${xesc(e && e.message ? e.message : e)} -->`;
    }
  } else {
    dbError = true;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>昉昕的博客</title>
    <link>${xesc(base)}</link>
    <description>昉昕的个人博客，记录技术实践、读书笔记与生活思考。</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>`;
  const res = new Response(xml, { headers: dbError ? ERR_HEADERS : OK_HEADERS });
  // ⚠️ 读库失败时**绝不**写入缓存：空 feed 被缓存住 = 所有订阅者一起空窗
  if (!dbError) {
    try { await cache.put(cacheKey, res.clone()); } catch (_) {}
  }
  return res;
}
