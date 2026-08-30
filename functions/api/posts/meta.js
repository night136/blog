// /api/posts/meta
// 轻量「新鲜度探针」：只返回文章总数 + 最新一篇 slug（SELECT COUNT + LIMIT 1，不读 body）。
// 用途：静态预渲染（generated/posts.json）是构建期快照，无法感知数据库后续新增；
// 一旦 Deploy Hook 未生效或部署有延迟，快照就会长期停留在旧版本，导致"发布后文章不显示"。
// 前端先渲染静态列表保证首屏秒开，再用本接口后台校验，发现过期即自动回退动态列表。
import { json } from "../_lib/auth.js";

export async function onRequestGet({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);

  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch (_) { /* Cache API 不可用时降级为直连 D1 */ }

  try {
    const countRow = await env.BLOG_DB.prepare("SELECT COUNT(*) AS c FROM posts").first();
    const latestRow = await env.BLOG_DB.prepare(
      "SELECT slug FROM posts ORDER BY date DESC, id DESC LIMIT 1"
    ).first();
    const body = JSON.stringify({
      ok: true,
      count: (countRow && Number(countRow.c)) || 0,
      latest: (latestRow && latestRow.slug) || "",
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, s-maxage=60",
      },
    });
    // 写入边缘缓存（克隆，因为 response 正文只能消费一次）
    try { await cache.put(cacheKey, response.clone()); } catch (_) {}
    return response;
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}
