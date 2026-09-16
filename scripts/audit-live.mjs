// 线上体检：响应头 / 压缩 / CDN 缓存 / TTFB。只读，不改任何东西。
// 用法：node scripts/audit-live.mjs [baseUrl]
//   默认打线上 canonical 域名；本地预览时传 http://127.0.0.1:8788
const BASE = (process.argv[2] || "https://blog-6p3.pages.dev").replace(/\/+$/, "");

// 注意：Node 的 fetch 忽略 {cache:"no-store"}，必须显式发请求头，否则读到的是本地缓存
const H = { "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0 (audit)" };

async function probe(path, note) {
  const url = BASE + path;
  const t0 = Date.now();
  const res = await fetch(url, { headers: H });
  const buf = Buffer.from(await res.arrayBuffer());
  const ttfb = Date.now() - t0;
  const h = res.headers;
  const hdr = (k) => h.get(k) || "—";
  console.log(`\n── ${path}   ${note || ""}`);
  console.log(`   ${res.status}  ${buf.length} B   ${ttfb}ms`);
  console.log(`   content-type      ${hdr("content-type")}`);
  console.log(`   content-encoding  ${hdr("content-encoding")}`);
  console.log(`   cache-control     ${hdr("cache-control")}`);
  console.log(`   cf-cache-status   ${hdr("cf-cache-status")}   age=${hdr("age")}`);
  console.log(`   etag              ${hdr("etag")}`);
  console.log(`   x-ssr-body        ${hdr("x-ssr-body")}   vary=${hdr("vary")}`);
  const sec = ["x-frame-options", "content-security-policy", "strict-transport-security", "permissions-policy", "referrer-policy", "x-content-type-options"];
  console.log(`   安全头            ${sec.map((k) => `${k}=${h.get(k) ? "✓" : "✗"}`).join("  ")}`);
  return { path, status: res.status, size: buf.length, ttfb, enc: hdr("content-encoding"), cc: hdr("cache-control"), cf: hdr("cf-cache-status") };
}

const rows = [];
console.log("========== 线上体检 " + new Date().toISOString() + " ==========");

// 先拿首页，从中解析出带 ?v= 的真实资源地址
const home = await fetch(BASE + "/", { headers: H });
const html = await home.text();
console.log(`\n[首页] ${home.status}  ${html.length} B`);
console.log(`   cache-control ${home.headers.get("cache-control")}  cf=${home.headers.get("cf-cache-status")}`);
const refs = [...new Set(html.match(/assets\/[A-Za-z0-9._-]+(?:\?v=[a-z0-9]+)?/g) || [])];
console.log(`   引用资源 ${refs.length} 个：`);
refs.forEach((r) => console.log("     " + r));

for (const r of refs) rows.push(await probe("/" + r));
rows.push(await probe("/sitemap.xml", "← 应带缓存头（#11）"));
rows.push(await probe("/feed.xml", "← 应带缓存头（#11）"));
rows.push(await probe("/robots.txt", "← 应带缓存头（#11）"));
rows.push(await probe("/api/posts/meta", "探针，必须 no-store"));
rows.push(await probe("/api/posts", "公开只读，应 default"));
rows.push(await probe("/api/me", "登录态，必须 no-store"));
rows.push(await probe("/api/guestbook", "登录态，必须 no-store"));

// 爬虫视角：文章页是否拿到预渲染正文
const post = await fetch(BASE + "/?post=" + encodeURIComponent("hello-world"), {
  headers: { ...H, "User-Agent": "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)" },
});
const ph = await post.text();
console.log(`\n[爬虫视角 /?post=hello-world] ${post.status}  ${ph.length} B  x-ssr-body=${post.headers.get("x-ssr-body")}`);
const m = ph.match(/<!--SSR-BODY-START-->([\s\S]*?)<!--SSR-BODY-END-->/);
console.log(`   SSR 正文块 ${m ? "存在，长 " + m[1].length + " 字符" : "❌ 缺失"}`);
console.log(`   含 <h1>：${/<h1/i.test(ph) ? "✓" : "✗"}   canonical 条数：${(ph.match(/rel="canonical"/g) || []).length}   JSON-LD：${/application\/ld\+json/.test(ph) ? "✓" : "✗"}`);

// TTFB 波动（跨境）
console.log("\n── TTFB 连测 5 次（跨境抖动参考）");
const ts = [];
for (let i = 0; i < 5; i++) {
  const t = Date.now();
  await fetch(BASE + "/assets/style.css", { headers: H });
  ts.push(Date.now() - t);
}
console.log("   " + ts.join("ms  ") + "ms   中位=" + ts.slice().sort((a, b) => a - b)[2] + "ms");

console.log("\n========== 汇总 ==========");
console.log("路径".padEnd(42) + "状态".padStart(5) + "体积".padStart(10) + "编码".padStart(9) + "  cf-cache");
for (const r of rows) {
  console.log(r.path.padEnd(42) + String(r.status).padStart(5) + String((r.size / 1024).toFixed(1) + "K").padStart(10) + String(r.enc || "—").padStart(9) + "  " + r.cf);
}
