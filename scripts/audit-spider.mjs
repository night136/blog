// 爬虫视角复测：SSR 正文 / title / canonical / og。用真实存在的 slug。
const BASE = "https://blog-6p3.pages.dev";
const SLUG = process.argv[2] || "2026-09-13-心理学的领域-atn2";
const UA_SPIDER = "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)";
const UA_GOOGLE = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const UA_HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const url = `${BASE}/?post=${encodeURIComponent(SLUG)}`;

function analyze(tag, html, res) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, ""])[1].trim();
  const canons = [...html.matchAll(/<link[^>]+rel="canonical"[^>]*>/gi)].map((m) => m[0]);
  const m = html.match(/<!--SSR-BODY-START-->([\s\S]*?)<!--SSR-BODY-END-->/);
  const body = m ? m[1] : null;
  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`, "i")) || [, "—"])[1];
  const ogImg = og("og:image");
  console.log(`\n────── ${tag}   ${res.status}  ${html.length} B`);
  console.log(`  x-ssr-body      ${res.headers.get("x-ssr-body")}`);
  console.log(`  vary            ${res.headers.get("vary")}`);
  console.log(`  cache-control   ${res.headers.get("cache-control")}`);
  console.log(`  <title>         ${title}`);
  console.log(`  canonical       ${canons.length} 条`);
  canons.forEach((c) => console.log(`                  ${c}`));
  console.log(`  SSR 正文块      ${body === null ? "❌ 标记缺失" : body.trim().length + " 字符"}`);
  if (body && body.trim()) {
    const h = [...body.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)].map((x) => `${x[1]}:${x[2].replace(/<[^>]+>/g, "").trim().slice(0, 18)}`);
    console.log(`  正文标题        ${h.slice(0, 6).join(" | ")}`);
    console.log(`  正文首段        ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)}…`);
  }
  console.log(`  og:image        ${ogImg.slice(0, 100)}`);
  console.log(`  og:title        ${og("og:title").slice(0, 80)}`);
  console.log(`  JSON-LD         ${/application\/ld\+json/i.test(html) ? "✓" : "✗ 缺失"}`);
  return { tag, len: html.length, ssr: body ? body.trim().length : -1, canons: canons.length, title };
}

console.log(`测试地址 ${url}`);
console.log(`（对照：不带 ?post= 的首页大小约 33966 B）`);

const out = [];
for (const [tag, ua] of [["百度蜘蛛", UA_SPIDER], ["Googlebot", UA_GOOGLE], ["普通浏览器", UA_HUMAN]]) {
  const res = await fetch(url, { headers: { "User-Agent": ua, "Cache-Control": "no-cache" } });
  out.push(analyze(tag, await res.text(), res));
}

console.log("\n\n========== 汇总 ==========");
console.log("视角".padEnd(14) + "字节".padStart(8) + "  SSR正文".padStart(10) + "  canonical");
out.forEach((r) => console.log(r.tag.padEnd(14) + String(r.len).padStart(8) + String(r.ssr).padStart(10) + "  " + r.canons));
console.log("\n判据：SSR正文 > 0 且 canonical == 1 才算正常；正文为 0 或 canonical > 1 都是真故障。");
