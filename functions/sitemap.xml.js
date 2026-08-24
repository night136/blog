// /sitemap.xml —— 动态生成站点地图（从 D1 读取全部文章）
import { siteUrl, xesc, postUrl } from "./_lib/seo.js";

export async function onRequestGet({ env }) {
  const headers = { "Content-Type": "application/xml; charset=utf-8" };
  if (!env.BLOG_DB) return new Response("<!-- BLOG_DB not configured -->", { status: 500, headers });
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
    return new Response(xml, { headers });
  } catch (e) {
    return new Response("<!-- error: " + (e && e.message ? e.message : e) + " -->", { status: 500, headers });
  }
}
