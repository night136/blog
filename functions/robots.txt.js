// /robots.txt —— 允许抓取并指向 sitemap
import { siteUrl } from "./_lib/seo.js";

// ⚠️ audit §七 #11：以前没有 Cache-Control，每次请求都白跑一趟函数。
// 这个端点**不读 D1**（只用 env.SITE_URL），所以缓存纯粹是省一次函数调用；
// 也正因为改抓取策略的代价高（写错会把搜索引擎挡在门外），边缘 TTL 只给 1 小时 ——
// 比 sitemap/feed 那 30 分钟更保守，宁可多跑几次函数。
const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
};

export async function onRequestGet({ env, request }) {
  // ⚠️ 同 sitemap/feed：必须用 Cache API 显式写边缘，标头本身不会让 Pages Functions 进 CDN 缓存。
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (_) { /* Cache API 不可用时降级为直算 */ }

  const base = siteUrl(env);
  const txt = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
  const res = new Response(txt, { headers: HEADERS });
  try { await cache.put(cacheKey, res.clone()); } catch (_) {}
  return res;
}
