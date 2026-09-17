// /sitemap.xml —— 动态生成站点地图（从 D1 读取全部文章）
import { siteUrl, xesc, postUrl } from "./_lib/seo.js";

// ⚠️ audit §七 #11：这个端点以前**完全没有 Cache-Control** ⇒ 每个爬虫每次来都打一遍 D1。
// 内容只在发文时变，所以给浏览器 5 分钟、边缘 30 分钟；SWR 让边缘先回旧版再后台更新，
// 发文后最迟 30 分钟被收录（s-maxage 是这里的关键：没有它边缘根本不缓存函数响应）。
const OK_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
};

// ⚠️ 错误响应**绝不能可缓存**：D1 一次抖动就会让「坏 sitemap」在每个爬虫面前挂 30 分钟，
//    比不缓存还糟。（sitemap 是爬虫唯一的发现入口，缓存的坏结果会被搜索引擎长期记住。）
const ERR_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" };

export async function onRequestGet({ env }) {
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
    return new Response(xml, { headers: OK_HEADERS });
  } catch (e) {
    // ⚠️ catch 里必须 console.error：只把错误写进 XML 注释的话，
    //    「sitemap 一直是空的」在 crawl 日志里看不见，只能靠人肉 grep 才发现（三类静默失败之一）。
    console.error("[sitemap] 生成失败：" + (e && e.message ? e.message : e));
    return new Response("<!-- error: " + (e && e.message ? e.message : e) + " -->", { status: 500, headers: ERR_HEADERS });
  }
}
