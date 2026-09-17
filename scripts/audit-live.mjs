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
  const missing = sec.filter((k) => !h.get(k));
  console.log(`   安全头            ${sec.map((k) => `${k}=${h.get(k) ? "✓" : "✗"}`).join("  ")}`);
  return { path, status: res.status, size: buf.length, ttfb, enc: hdr("content-encoding"), cc: hdr("cache-control"), cf: hdr("cf-cache-status"), missing, sec };
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
rows.push(await probe("/assets/style.css", "静态资源：长缓存 + SWR（内联后仍可访问，供陈旧外壳）"));
rows.push(await probe("/generated/covers.json", "映射表：必须短缓存（60s）"));
rows.push(await probe("/sitemap.xml", "← 应带缓存头（#11）"));
rows.push(await probe("/feed.xml", "← 应带缓存头（#11）"));
rows.push(await probe("/robots.txt", "← 应带缓存头（#11）"));
rows.push(await probe("/api/posts/meta", "探针，必须 no-store"));
rows.push(await probe("/api/posts", "公开只读，应 default"));
rows.push(await probe("/api/me", "登录态，必须 no-store"));
rows.push(await probe("/api/guestbook", "登录态，必须 no-store"));

// ── /api/logout：不需要登录态就返回 Set-Cookie，正好用来端到端验证
//    「中间件有没有把 Set-Cookie 吃掉」。如果这里没 cookie，登录/登出就全哑了。
console.log("\n── POST /api/logout   ← Set-Cookie 必须穿过中间件");
const lo = await fetch(BASE + "/api/logout", { method: "POST", headers: H });
const loCookie = lo.headers.getSetCookie();
console.log(`   ${lo.status}  set-cookie=${loCookie.length} 条  ${JSON.stringify(loCookie)}`);
console.log(`   安全头            ${["x-content-type-options", "x-frame-options"].map((k) => `${k}=${lo.headers.get(k) ? "✓" : "✗"}`).join("  ")}`);

// 爬虫视角：文章页是否拿到预渲染正文
// ⚠️ 必须用**真实 slug**，而且要拿「假 slug」做负向对照。原因：
//    外壳 index.html:378 里本来就写着 `<!--SSR-BODY-START--><!--SSR-BODY-END-->` 这个**空占位**，
//    所以随便拿一个不存在的 slug 去探，正文块正则**照样命中**（内容为空）——
//    配上 `([\s\S]*?)` 这种允许空匹配的写法，就会得出「注入成功」的假结论。（本次踩过。）
const BOT_UA = "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)";
async function botView(slug) {
  const res = await fetch(BASE + "/?post=" + encodeURIComponent(slug), { headers: { ...H, "User-Agent": BOT_UA } });
  const html = await res.text();
  // `+?` 而不是 `*?`：空占位不算「有正文」
  const mm = html.match(/<!--SSR-BODY-START-->([\s\S]+?)<!--SSR-BODY-END-->/);
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
  return { res, html, body: mm ? mm[1] : "", title: title.trim() };
}
const pj = await (await fetch(BASE + "/generated/posts.json?cb=" + Math.random(), { headers: H })).json();
const postList = pj.posts || pj;
const realSlug = postList[0].slug;
const post = await botView(realSlug);
const fakePost = await botView("__no_such_post__");
console.log(`\n[爬虫视角 /?post=${realSlug}] ${post.res.status}  ${post.html.length} B  x-ssr-body=${post.res.headers.get("x-ssr-body")}`);
console.log(`   SSR 正文块 ${post.body ? "存在，长 " + post.body.length + " 字符" : "❌ 缺失"}`);
console.log(`   <title> ${post.title}`);
console.log(`   含 <h1>：${/<h1/i.test(post.html) ? "✓" : "✗"}   canonical 条数：${(post.html.match(/rel="canonical" href=/g) || []).length}   JSON-LD：${/application\/ld\+json/.test(post.html) ? "✓" : "✗"}`);
console.log(`   负向对照（不存在的 slug）x-ssr-body=${fakePost.res.headers.get("x-ssr-body")}  正文块=${fakePost.body ? "有内容（！）" : "空（符合预期）"}`);

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

// ══════════ 判据（有 PASS/FAIL 与退出码，能当验收用）══════════
// 这组断言盯的是**响应头的不变量**，与 scripts/verify-security-headers.mjs 互补：
// 那个跑的是函数逻辑（离线、假 D1），这个跑的是**线上真实的响应**（含边缘、含 `_headers`）。
// ⚠️ 两件事只有在这里才能证明：
//   ① Root 中间件到底有没有真的挂上（离线的假 context 证明不了运行时接线）；
//   ② `_headers` 给静态资源的缓存头有没有被中间件碰掉 —— 这是本次改动最大的回归风险。
let bad = 0;
const judge = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok || !detail ? "" : "\n      实际: " + detail}`);
  if (!ok) bad++;
};
const SEC6 = ["x-content-type-options", "referrer-policy", "strict-transport-security", "x-frame-options", "permissions-policy", "content-security-policy"];

console.log("\n── 判据（audit §八 安全头 / §七 #11 缓存头）");

// ① 函数侧：/api/* 与三个 XML/TXT 端点，以前一个安全头都没有
const funcPaths = ["/sitemap.xml", "/feed.xml", "/robots.txt", "/api/posts/meta", "/api/posts", "/api/me", "/api/guestbook"];
const funcRows = rows.filter((r) => funcPaths.includes(r.path));
judge("函数响应全都有 6 个安全头（以前是 0 个 —— 唯一需要防护的入口反而全裸）",
  funcRows.length === funcPaths.length && funcRows.every((r) => r.missing.length === 0),
  funcRows.map((r) => `${r.path}: 缺 ${r.missing.join(",") || "无"}`).join(" | "));

// ② 静态侧：_headers 那份也得补上 HSTS/XFO/Permissions-Policy
judge("静态资源也都有 6 个安全头（_headers 的全局块）",
  rows.every((r) => r.missing.length === 0),
  rows.filter((r) => r.missing.length).map((r) => `${r.path}: 缺 ${r.missing.join(",")}`).join(" | "));

// ③ 缓存头（#11）：三个端点要可缓存、带 s-maxage（没它边缘不缓存函数响应）
const cachePaths = ["/sitemap.xml", "/feed.xml", "/robots.txt"];
for (const p of cachePaths) {
  const r = rows.find((x) => x.path === p);
  judge(`${p} 有缓存头且带 s-maxage（以前完全没有 ⇒ 每次爬虫都打 D1）`,
    !!r && /max-age=\d+/.test(r.cc) && /s-maxage=\d+/.test(r.cc) && /public/.test(r.cc), r ? r.cc : "（没探到）");
}

// ④ **最关键的回归风险**：静态资源的缓存策略来自 _headers，绝不能被中间件改写
const EXPECT_CC = {
  "/assets/style.css": "public, max-age=86400, stale-while-revalidate=604800",
  "/generated/covers.json": "public, max-age=60",
};
for (const [p, want] of Object.entries(EXPECT_CC)) {
  const r = rows.find((x) => x.path === p);
  judge(`${p} 的 Cache-Control 逐字未变（中间件不许碰缓存策略）`,
    !!r && r.cc === want, r ? `${r.cc}  ← 期望 ${want}` : "（没探到）");
}
judge("首页外壳仍是 max-age=0 + swr=300（永远及时换新壳）",
  /max-age=0/.test(home.headers.get("cache-control") || "") && /stale-while-revalidate=300/.test(home.headers.get("cache-control") || ""),
  home.headers.get("cache-control"));

// ⑤ Set-Cookie 必须穿过中间件（否则登录/登出全哑）—— 这条只有线上能验
judge("/api/logout 的 Set-Cookie 穿过中间件（证明中间件只加头、没重造响应丢掉 cookie）",
  lo.status === 200 && loCookie.length >= 1 && /auth=/.test(loCookie.join(";")),
  `${lo.status} set-cookie=${JSON.stringify(loCookie)}`);

// ⑥ 爬虫注入没被中间件弄坏（用真 slug 的**非空**正文块判，不用外壳里的空占位）
judge("爬虫视角仍拿到 SSR 正文（中间件没破坏 index.js 的注入）",
  post.res.status === 200 && post.res.headers.get("x-ssr-body") === "1" && post.body.length > 100,
  `status=${post.res.status} x-ssr-body=${post.res.headers.get("x-ssr-body")} 正文块长=${post.body.length}`);
// ⑥b 负向对照：不存在的 slug 必须**不**注入 —— 否则上面那条读到的可能只是外壳里的空占位
judge("负向对照：不存在的 slug 不会注入正文（证明上一条的「有正文」不是空占位）",
  fakePost.res.headers.get("x-ssr-body") !== "1" && fakePost.body.length === 0,
  `x-ssr-body=${fakePost.res.headers.get("x-ssr-body")} 正文块长=${fakePost.body.length}`);

// ⑦ 没有任何 5xx
judge("所有探测端点都没有 5xx", rows.every((r) => r.status < 500) && lo.status < 500,
  rows.filter((r) => r.status >= 500).map((r) => `${r.path}=${r.status}`).join(", "));

console.log("\n" + "─".repeat(56));
if (bad > 0) { console.log(`RESULT: FAIL（${bad} 条判据未通过）`); process.exit(1); }
console.log("RESULT: PASS —— 函数侧与静态侧都戴上了安全头，缓存策略未被中间件碰掉");
