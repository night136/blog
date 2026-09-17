// /robots.txt —— 允许抓取并指向 sitemap
import { siteUrl } from "./_lib/seo.js";

// ⚠️ audit §七 #11：以前没有 Cache-Control，每次请求都白跑一趟函数。
// robots.txt 只有换域名/改抓取策略才会变，所以给得比 sitemap 更宽：浏览器 1 小时、边缘 1 天。
const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
};

export async function onRequestGet({ env }) {
  const base = siteUrl(env);
  const txt = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
  return new Response(txt, { headers: HEADERS });
}
