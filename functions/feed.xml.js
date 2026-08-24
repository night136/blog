// /feed.xml —— RSS 2.0 订阅源（取最近 20 篇）
import { siteUrl, xesc, postUrl } from "./_lib/seo.js";

export async function onRequestGet({ env }) {
  const headers = { "Content-Type": "application/rss+xml; charset=utf-8" };
  const base = siteUrl(env);
  let items = "";
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
      items = `    <!-- error: ${xesc(e && e.message ? e.message : e)} -->`;
    }
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
  return new Response(xml, { headers });
}
