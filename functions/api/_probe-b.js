// ⚠️ 临时探针：只为判定「Cloudflare 边缘到底为什么缓存 / 不缓存函数响应」。用完即删。
export async function onRequestGet() {
  return new Response("probe-body", { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600" } });
}
