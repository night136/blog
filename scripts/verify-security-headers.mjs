// 安全响应头 + 端点缓存头回归（audit §八 安全头、§七 #11 缓存头）
//
// 背景
// ────
// A. **安全头**：Cloudflare Pages 的 `_headers` 只对**静态资源**生效，
//    Functions 自己 `new Response(...)` 出来的响应完全绕过它。2026-09-17 线上实测：
//        /assets/style.css → nosniff ✓        /sitemap.xml → 一个安全头都没有
//    结果全站**唯一真正需要防护的入口（/api/* 写接口与登录口）反而全裸**。
//    修法 = `functions/_lib/security.js`（唯一来源）+ `functions/_middleware.js`（兜全站函数响应）。
// B. **缓存头**：`/sitemap.xml` `/feed.xml` `/robots.txt` 以前完全没有 `Cache-Control`
//    ⇒ 每个爬虫每次来都白打一遍 D1。加上缓存头之后，**错误响应又绝不能跟着被缓存** ——
//    一次 D1 抖动会让「坏 sitemap」在每个爬虫面前挂半小时，比不缓存更糟。
//
// 这个守护盯的判据全部是**真调用**（动态 import 后用假 context / 假 D1 跑一遍），
// 不做源码 grep —— 因为「源码里有那行字」和「响应真的带那个头」是两回事。
//
// [1] 两份拷贝不许漂：`_headers`（静态资源那份）与 `security.js`（函数那份）是手工同步的，
//     六个头的值必须逐字相同；同一个头也不许被两条规则重复设置（`_headers` 会拼成 "a, a"）。
// [2] 中间件**只加不删**：过一遍之后，那 6 个头之外的一切必须逐字节不变 ——
//     尤其是 Cache-Control（静态资源的缓存策略来自 `_headers`，被碰掉就是全站缓存崩）
//     和多个 `Set-Cookie`（登录/登出就靠它）。
// [3] 覆盖范围：中间件必须在 `functions/` **根目录**、必须导出 `onRequest`
//     （写成 `onRequestGet` 就会漏掉全部 POST/DELETE 写接口）。
// [4] 三个端点的缓存头：成功可缓存且带 `s-maxage`（没有它边缘根本不缓存函数响应，
//     #11 的病根就在这里）、失败必须 `no-store`、`catch` 里必须留痕（不许静默吞错）。
// 外加**负向自证**：四种故障（删一个安全头 / 改一边拷贝 / 去掉错误分支的 no-store）
// 必须各自让判据变红 —— 否则这个守护只是恒真的摆设。
//
// 用法：node scripts/verify-security-headers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
// --root=<dir> 是给负向自证用的：让同一套判据跑在**被改坏的那份副本**上。
const argRoot = (process.argv.find((a) => a.startsWith("--root=")) || "").slice("--root=".length);
const ROOT = argRoot ? path.resolve(argRoot) : REPO;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 沙箱：仓库里没有 package.json，Node 会把 functions/*.js 当成 CJS 解析、直接 import 会炸。
//    所以每个沙箱自带一个 {"type":"module"} 的 package.json（只在临时目录里，不动仓库）。──
function makeSandbox(mutate = null) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-sechdr-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  fs.cpSync(path.join(ROOT, "functions"), path.join(tmp, "functions"), { recursive: true });
  for (const f of ["_headers", "index.html"]) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  const appJs = path.join(ROOT, "assets", "app.js");
  if (fs.existsSync(appJs)) {
    fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
    fs.copyFileSync(appJs, path.join(tmp, "assets", "app.js"));
  }
  if (mutate) mutate(tmp);
  return tmp;
}
const imp = (sandbox, rel) => import(pathToFileURL(path.join(sandbox, rel)).href);

// `_headers` 解析：非缩进行 = 一条规则（路径模式），其下缩进的 `Name: value` 属于它；空行结束。
function parseHeadersFile(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || /^\s*#/.test(raw)) { cur = null; continue; }
    if (/^\s/.test(raw)) {
      const m = raw.match(/^\s+([A-Za-z0-9-]+):\s*(.*)$/);
      if (m && cur) cur.headers.set(m[1].toLowerCase(), m[2].trim());
      continue;
    }
    cur = { pattern: raw.trim(), headers: new Map() };
    blocks.push(cur);
  }
  return blocks;
}

// 假 D1
let d1Calls = 0;
const makeOkDb = () => ({
  prepare: () => {
    d1Calls++;
    return { all: async () => ({ results: [{ slug: "hello-world", date: "2026-09-17", title: "标题", summary: "摘要", tag: "技术" }] }) };
  },
});
const throwDb = { prepare: () => { d1Calls++; return { all: async () => { throw new Error("D1 挂了"); } }; } };

// 假 Cache API：**必须存在**，否则 `caches.default` 直接 ReferenceError。
// 这三个端点靠它才真的不进 D1（只加 Cache-Control 标头是不够的，见 sitemap.xml.js 注释）。
function fakeCaches() {
  const store = new Map();
  const log = { match: 0, put: 0, puts: [] };
  return {
    log,
    default: {
      match: async (req) => { log.match++; const hit = store.get(req.url); return hit ? hit.clone() : undefined; },
      put: async (req, res) => {
        log.put++;
        log.puts.push({ url: req.url, status: res.status, cc: String(res.headers.get("cache-control")) });
        store.set(req.url, res);
      },
    },
  };
}
const REQ = (p) => new Request("https://blog-6p3.pages.dev" + p);

// console.error 间谍：catch 里必须留痕，不留痕就是「静默失败」
async function spyErr(fn) {
  const orig = console.error;
  const calls = [];
  console.error = (...a) => { calls.push(a.map((x) => String(x)).join(" ")); };
  try { return { value: await fn(), calls }; } finally { console.error = orig; }
}

const bodyStream = (s) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
const sortHdrs = (h) => [...h].map(([k, v]) => k + "=" + v).sort();

let sandbox = null;
try {
  sandbox = makeSandbox();

  // ⚠️ 判据跑在副本上，所以必须先证明副本没被动过 —— 否则「拷贝步骤自己撒谎」也会全绿。
  console.log("\n[0] 沙箱与源文件的完整性");
  {
    const pairs = [["functions/_lib/security.js"], ["functions/_middleware.js"], ["functions/sitemap.xml.js"], ["functions/feed.xml.js"], ["functions/robots.txt.js"], ["_headers"]];
    const bad = pairs.filter(([f]) => fs.readFileSync(path.join(ROOT, f), "utf8") !== fs.readFileSync(path.join(sandbox, f), "utf8"));
    check("判据跑的那份副本与源文件逐字节相同（拷贝没撒谎）", bad.length === 0, bad.map((b) => b[0]).join(" / "));
  }

  const sec = await imp(sandbox, "functions/_lib/security.js");
  const mw = await imp(sandbox, "functions/_middleware.js");
  const sitemap = await imp(sandbox, "functions/sitemap.xml.js");
  const feed = await imp(sandbox, "functions/feed.xml.js");
  const robots = await imp(sandbox, "functions/robots.txt.js");
  const SEC = sec.SECURITY_HEADERS;

  // ══ [1] 唯一来源与两份拷贝的一致性 ══
  console.log("\n[1] 安全头的定义与两份拷贝（_headers ↔ security.js）");
  const EXPECTED = ["x-content-type-options", "referrer-policy", "strict-transport-security", "x-frame-options", "permissions-policy", "content-security-policy"];
  const haveNames = Object.keys(SEC).map((k) => k.toLowerCase());
  check(`六个头齐备（${EXPECTED.join(", ")}）`,
    EXPECTED.every((n) => haveNames.includes(n)) && haveNames.length === EXPECTED.length,
    haveNames.join(", "));
  check("每个头都有非空值", Object.values(SEC).every((v) => typeof v === "string" && v.trim() !== ""),
    JSON.stringify(Object.entries(SEC).filter(([, v]) => !v || !String(v).trim())));
  for (const [k, v] of Object.entries(SEC)) {
    check(`${k} 值前后没有多余空白或换行`, v === v.trim() && !/[\r\n]/.test(v), JSON.stringify(v));
  }

  const blocks = parseHeadersFile(fs.readFileSync(path.join(ROOT, "_headers"), "utf8"));
  const globalBlock = blocks.find((b) => b.pattern === "/*");
  check("_headers 里有全局规则 `/*`（静态资源的兜底）", !!globalBlock, blocks.map((b) => b.pattern).join(" / ") || "（一条规则都没解析出来）");
  if (globalBlock) {
    for (const [k, v] of Object.entries(SEC)) {
      const got = globalBlock.headers.get(k.toLowerCase());
      check(`_headers 的全局块里 ${k} 与 security.js 逐字一致`, got === v,
        got === undefined ? "（_headers 里没有这个头 —— 静态资源就少一层防护）" : JSON.stringify(got) + " ≠ " + JSON.stringify(v));
    }
  }
  // _headers 里两条规则同时设同一个头 → Cloudflare 会把值拼成 "a, a"
  for (const n of EXPECTED) {
    const owners = blocks.filter((b) => b.headers.has(n)).map((b) => b.pattern);
    check(`_headers 里 ${n} 只被一条规则设置（避免值被拼接）`, owners.length <= 1, owners.join(" + "));
  }
  const hsts = SEC["Strict-Transport-Security"];
  check("HSTS 不含 includeSubDomains / preload（pages.dev 是所有 Pages 项目共用的域）",
    !/includeSubDomains|preload/i.test(hsts), hsts);
  check("HSTS 有效期 ≥ 180 天", Number((hsts.match(/max-age=(\d+)/) || [])[1] || 0) >= 15552000, hsts);
  check("X-Frame-Options 是 DENY 或 SAMEORIGIN", /^(DENY|SAMEORIGIN)$/i.test(SEC["X-Frame-Options"] || ""), SEC["X-Frame-Options"]);

  // CSP 只许上「不需要 nonce」的那几条 —— 一旦有人补上 script-src/style-src，页面会当场白屏
  const csp = SEC["Content-Security-Policy"] || "";
  check("CSP 里没有 script-src / style-src / default-src（页面有 3 段内联 <script> + 构建期内联的整张 style.css，加了就白屏）",
    !/(script-src|style-src|default-src)/i.test(csp), csp);
  check("CSP 覆盖 object-src / base-uri / frame-ancestors 三条",
    /object-src\s+'none'/.test(csp) && /base-uri\s+'self'/.test(csp) && /frame-ancestors\s+'none'/.test(csp), csp);

  // Permissions-Policy 反查站点真实用法：禁掉了真在用的能力，按钮就死了
  {
    const appJson = path.join(ROOT, "assets", "app.js");
    const app = fs.existsSync(appJson) ? fs.readFileSync(appJson, "utf8") : "";
    const pp = SEC["Permissions-Policy"] || "";
    const usesClipboard = /navigator\.clipboard/.test(app);
    const usesShare = /navigator\.share/.test(app);
    check("Permissions-Policy 没有禁掉站内真在用的能力（复制链接 / 分享）",
      (!usesClipboard || !/clipboard-(read|write)/i.test(pp)) && (!usesShare || !/web-share/i.test(pp)),
      `app.js 用 clipboard=${usesClipboard} share=${usesShare}，而 Permissions-Policy=${pp}`);
    check("Permissions-Policy 确实禁掉了未使用的敏感能力（geolocation/camera/microphone）",
      /geolocation=\(\)/.test(pp) && /camera=\(\)/.test(pp) && /microphone=\(\)/.test(pp), pp);
  }

  // ══ [2] 中间件行为：只加不删 ══
  console.log("\n[2] 中间件行为（真调用 onRequest）");
  check("functions/_middleware.js 在 functions/ 根目录（只有这个位置能覆盖全部路由）",
    fs.existsSync(path.join(ROOT, "functions", "_middleware.js")) &&
    !fs.existsSync(path.join(ROOT, "functions", "api", "_middleware.js")), "位置不对");
  check("中间件导出的是 onRequest（不是 onRequestGet —— 那会漏掉全部 POST/DELETE 写接口）",
    typeof mw.onRequest === "function", Object.keys(mw).join(", ") || "（没有导出）");

  {
    const origHeaders = [
      ["content-type", "application/json; charset=utf-8"],
      ["cache-control", "private, no-store"],
      ["set-cookie", "auth=tok; HttpOnly; Secure"],
      ["set-cookie", "theme=dark; Path=/"],
      ["x-custom-thing", "keep-me"],
    ];
    const out = await mw.onRequest({ next: async () => new Response(bodyStream("payload"), { status: 201, headers: new Headers(origHeaders) }) });

    check("状态码保留（201）", out.status === 201, String(out.status));
    check("响应体逐字保留（流式 body 没被吃掉）", (await out.text()) === "payload", "body 变了");
    for (const [k, v] of Object.entries(SEC)) {
      check(`加上 ${k}`, out.headers.get(k.toLowerCase()) === v, String(out.headers.get(k.toLowerCase())));
    }
    check("Cache-Control 逐字不变（静态资源的缓存策略来自 _headers，绝不能被这一层碰）",
      out.headers.get("cache-control") === "private, no-store", String(out.headers.get("cache-control")));
    check("多个 Set-Cookie 一个不丢（登录 / 登出就靠它）",
      JSON.stringify(out.headers.getSetCookie()) === JSON.stringify(origHeaders.filter(([k]) => k === "set-cookie").map(([, v]) => v)),
      JSON.stringify(out.headers.getSetCookie()));
    check("原有自定义头仍在（这一层只加不删）", out.headers.get("x-custom-thing") === "keep-me", String(out.headers.get("x-custom-thing")));
    check("Content-Type 未被改写", out.headers.get("content-type") === "application/json; charset=utf-8", String(out.headers.get("content-type")));
    const names = [...new Set(out.headers.keys())].sort();
    const want = [...new Set([...origHeaders.map(([k]) => k), ...Object.keys(SEC).map((k) => k.toLowerCase())])].sort();
    check("头集合恰好等于「原有的 ∪ 六个安全头」（没有顺手多塞别的）",
      JSON.stringify(names) === JSON.stringify(want), names.join(", "));

    // 静态资源形态：长缓存不能被改
    const stat = await mw.onRequest({ next: async () => new Response("css", { headers: new Headers([["cache-control", "public, max-age=86400, stale-while-revalidate=604800"]]) }) });
    check("静态资源的长缓存头原样穿过中间件（Cache-Control: public, max-age=86400, swr=604800）",
      stat.headers.get("cache-control") === "public, max-age=86400, stale-while-revalidate=604800",
      String(stat.headers.get("cache-control")));

    // 幂等：同一层被套两遍（比如将来又加了 api/_middleware.js）不许把值拼起来。
    // ⚠️ 必须用**没被读过 body** 的新响应：body 一旦被 text() 消费就 locked，
    //    再包一次会抛 "body object should not be disturbed or locked" —— 那是测试自身的坑。
    const fresh = await mw.onRequest({ next: async () => new Response(bodyStream("payload"), { status: 201, headers: new Headers(origHeaders) }) });
    const twice = sec.withSecurityHeaders(fresh);
    check("幂等：套两遍头不重复、值不变",
      JSON.stringify(sortHdrs(twice.headers)) === JSON.stringify(sortHdrs(fresh.headers)),
      sortHdrs(twice.headers).filter((x, i, a) => a.indexOf(x) !== i).join(" / ") || "头集合变了");

    // 304 / 空 body 这种「无 body 状态码」不许把中间件弄炸
    let threw = null;
    let out304 = null;
    try { out304 = await mw.onRequest({ next: async () => new Response(null, { status: 304 }) }); }
    catch (e) { threw = e; }
    check("304 + 空 body 不抛异常且状态保留", !threw && out304 && out304.status === 304,
      threw ? String(threw.message) : `status=${out304 && out304.status}`);
    check("304 也带上了安全头", !!out304 && out304.headers.get("x-content-type-options") === "nosniff");
  }

  console.log("\n[3] 优雅降级：包装抛异常时必须放行原始响应，且必须留痕");
  {
    // 造一个「真的会让包装炸掉」的响应：304（无 body 状态码）配一个非 null 的 body。
    // 这不是臆造的故障 —— 将来若有人把中间件改成 `new Response(res.body, {status: res.status})`
    // 之类，这就是真实会踩的形态。
    const evil = { status: 304, statusText: "", headers: new Headers(), body: bodyStream("x") };
    const { value, calls } = await spyErr(() => mw.onRequest({ next: async () => evil }));
    check("包装失败时不抛给调用方（站点照常工作）", value === evil, "返回的不是原始响应对象");
    check("包装失败时 console.error 留痕（不许静默 —— 否则「安全头集体消失」会变成看不见的故障）",
      calls.some((c) => c.includes("安全头")), calls.join(" | ") || "（一次都没打）");
  }

  // ══ [4] 三个端点的缓存（audit §七 #11）══
  console.log("\n[4] /sitemap.xml /feed.xml /robots.txt 的缓存头与边缘缓存");
  const ccOf = (res) => String(res.headers.get("cache-control") || "");
  const hasSmaxage = (res) => /s-maxage=\d+/.test(ccOf(res));
  const isPublic = (res) => /^\s*public\b/.test(ccOf(res));
  const maxAge = (res) => Number((ccOf(res).match(/max-age=(\d+)/) || [])[1] || 0);
  // 每个端点用**独立**的 cache + url，避免互相污染
  const fc = { sitemap: fakeCaches(), feed: fakeCaches(), robots: fakeCaches() };
  const isFreshCache = (f) => f.log.match > 0;

  {
    globalThis.caches = fc.sitemap;
    d1Calls = 0;
    const r = await sitemap.onRequestGet({ env: { BLOG_DB: makeOkDb() }, request: REQ("/sitemap.xml") });
    check("sitemap 成功响应可缓存 public", r.status === 200 && isPublic(r), `${r.status} ${ccOf(r)}`);
    check("sitemap 成功响应带 s-maxage", hasSmaxage(r), ccOf(r));
    check("sitemap 成功响应 max-age 在合理区间（60s~1h）", maxAge(r) >= 60 && maxAge(r) <= 3600, ccOf(r));
    check("sitemap 成功响应注入了文章 URL（顺带证明假 D1 真的被调用）", (await r.text()).includes("hello-world"), "正文里没有文章");
    check("sitemap 冷启动时确实查了一次 D1", d1Calls === 1, `d1Calls=${d1Calls}`);
    check("sitemap 冷启动把成功响应写进了边缘缓存（Cache API）",
      fc.sitemap.log.put === 1 && /^\s*public\b/.test((fc.sitemap.log.puts[0] || {}).cc || ""),
      JSON.stringify(fc.sitemap.log.puts));

    // ⚠️ 这条是 #11 的核心判据：**命中边缘缓存时不许碰 D1**。
    //    用「把 D1 换成必炸的实现」来证：只要还能拿到 200 + 文章，就说明它压根没走到 D1。
    d1Calls = 0;
    const warm = await sitemap.onRequestGet({ env: { BLOG_DB: throwDb }, request: REQ("/sitemap.xml") });
    check("sitemap 命中边缘缓存时**完全不碰 D1**（D1 被换成必炸的实现也照样 200）",
      warm.status === 200 && (await warm.text()).includes("hello-world") && d1Calls === 0,
      `status=${warm.status} d1Calls=${d1Calls} ⇒ 边缘缓存没挡住 D1，#11 等于没修`);
    check("命中缓存的响应没有重新写缓存（put 次数仍为 1）", fc.sitemap.log.put === 1, `put=${fc.sitemap.log.put}`);
  }
  {
    globalThis.caches = fc.sitemap; // 复用同一个 cache：下面这几次请求会命中，所以不会覆盖 put 计数
    const before = fc.sitemap.log.put;
    const { value: r } = await spyErr(() => sitemap.onRequestGet({ env: {}, request: REQ("/sitemap.xml?err=1") }));
    check("sitemap 没配 D1 时 500 + no-store（错误绝不能被缓存）",
      r.status === 500 && /no-store/.test(ccOf(r)), `${r.status} ${ccOf(r)}`);
    const { value: r2, calls: c2 } = await spyErr(() => sitemap.onRequestGet({ env: { BLOG_DB: throwDb }, request: REQ("/sitemap.xml?err=2") }));
    check("sitemap 读库抛异常时 500 + no-store", r2.status === 500 && /no-store/.test(ccOf(r2)), `${r2.status} ${ccOf(r2)}`);
    check("sitemap 读库异常时不静默（catch 里必须 console.error）", c2.length > 0, "一次都没打 ⇒ 只把错误塞进 XML 注释，日志里查不到");
    check("sitemap 错误响应绝不写入边缘缓存（否则坏 sitemap 会被钉在所有爬虫面前）",
      fc.sitemap.log.put === before, `put 从 ${before} 变成了 ${fc.sitemap.log.put}`);
  }
  {
    globalThis.caches = fc.feed;
    d1Calls = 0;
    const r = await feed.onRequestGet({ env: { BLOG_DB: makeOkDb() }, request: REQ("/feed.xml") });
    check("feed 成功响应可缓存 public", r.status === 200 && isPublic(r), `${r.status} ${ccOf(r)}`);
    check("feed 成功响应带 s-maxage", hasSmaxage(r), ccOf(r));
    check("feed 成功响应 max-age 在合理区间（60s~1h）", maxAge(r) >= 60 && maxAge(r) <= 3600, ccOf(r));
    check("feed 成功响应注入了文章 item", (await r.text()).includes("<item>"), "正文里没有 item");
    check("feed 冷启动把成功响应写进了边缘缓存", fc.feed.log.put === 1, `put=${fc.feed.log.put}`);

    d1Calls = 0;
    const warm = await feed.onRequestGet({ env: { BLOG_DB: throwDb }, request: REQ("/feed.xml") });
    check("feed 命中边缘缓存时完全不碰 D1", warm.status === 200 && (await warm.text()).includes("<item>") && d1Calls === 0,
      `status=${warm.status} d1Calls=${d1Calls}`);
  }
  {
    globalThis.caches = fc.feed;
    const before = fc.feed.log.put;
    const { value: r, calls } = await spyErr(() => feed.onRequestGet({ env: { BLOG_DB: throwDb }, request: REQ("/feed.xml?err=1") }));
    check("feed 读库异常时 no-store（否则一个空 feed 会被缓存 30 分钟，全部订阅者一起空窗）",
      /no-store/.test(ccOf(r)), `${r.status} ${ccOf(r)}`);
    check("feed 读库异常时不静默（catch 里必须 console.error）", calls.length > 0, "一次都没打");
    const { value: r2 } = await spyErr(() => feed.onRequestGet({ env: {}, request: REQ("/feed.xml?nodb=1") }));
    check("feed 没配 D1 时也是 no-store", /no-store/.test(ccOf(r2)), ccOf(r2));
    check("feed 失败响应绝不写入边缘缓存", fc.feed.log.put === before, `put 从 ${before} 变成了 ${fc.feed.log.put}`);
  }
  {
    globalThis.caches = fc.robots;
    const r = await robots.onRequestGet({ env: {}, request: REQ("/robots.txt") });
    const txt = await r.text();
    check("robots 成功响应可缓存 public 且带 s-maxage", r.status === 200 && isPublic(r) && hasSmaxage(r), `${r.status} ${ccOf(r)}`);
    check("robots 的 Content-Type 是 text/plain", /text\/plain/.test(String(r.headers.get("content-type"))), String(r.headers.get("content-type")));
    check("robots 正文仍指向 sitemap（加固没改内容）", /Sitemap: https:\/\/\S+\/sitemap\.xml/.test(txt), txt);
    check("robots 也写进了边缘缓存", fc.robots.log.put === 1, `put=${fc.robots.log.put}`);
    // robots 不读 D1，边缘 TTL 应更保守（改抓取策略的代价高）
    const warm = await robots.onRequestGet({ env: {}, request: REQ("/robots.txt") });
    check("robots 命中缓存时不再重算", (await warm.text()).includes("Sitemap:") && fc.robots.log.match >= 2, `match=${fc.robots.log.match}`);
  }
  // 三个端点都必须真的用上 Cache API —— 光有 Cache-Control 标头是**不够**的（实测已证）
  {
    for (const [name, f] of Object.entries(fc)) {
      check(`${name} 端点确实调用了 caches.default（标头不够，必须显式写边缘）`,
        isFreshCache(f), `match=${f.log.match} put=${f.log.put}`);
    }
    const srcs = ["sitemap.xml.js", "feed.xml.js", "robots.txt.js"].map((f) => fs.readFileSync(path.join(ROOT, "functions", f), "utf8"));
    check("三个端点的源码里都出现 caches.default（防止有人「优化」掉它）",
      srcs.every((s) => /caches\.default/.test(s)), srcs.map((s) => /caches\.default/.test(s)).join(" / "));
  }
  // 自相矛盾的头：既 no-store 又 s-maxage
  {
    globalThis.caches = fakeCaches();
    const { value: all } = await spyErr(() => Promise.all([
      sitemap.onRequestGet({ env: { BLOG_DB: makeOkDb() }, request: REQ("/s.xml?a=1") }),
      sitemap.onRequestGet({ env: {}, request: REQ("/s.xml?a=2") }),
      feed.onRequestGet({ env: { BLOG_DB: makeOkDb() }, request: REQ("/f.xml?a=1") }),
      feed.onRequestGet({ env: { BLOG_DB: throwDb }, request: REQ("/f.xml?a=2") }),
      robots.onRequestGet({ env: {}, request: REQ("/r.txt") }),
    ]));
    check("没有「既 no-store 又 s-maxage」自相矛盾的响应",
      !all.some((r) => /no-store/.test(ccOf(r)) && /s-maxage/.test(ccOf(r))),
      all.map(ccOf).join(" | "));
  }
  delete globalThis.caches;
} finally {
  try { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
}

// ══ [5] 负向自证：造四种故障，各自必须让判据变红 ══
// 只做正向检查的守护等于摆设。这里把同一套判据（同一个脚本 + --root=<被改坏的副本>）跑一遍，
// 要求「必须非零退出」且**报红的正是预期那几条**。
if (!argRoot) {
  console.log("\n[5] 负向自证：四种故障必须各自让判据变红");
  const MUTATIONS = [
    {
      name: "删掉 security.js 里的 X-Frame-Options",
      expect: /加上 X-Frame-Options|六个头齐备|_headers 的全局块里 X-Frame-Options/,
      apply: (dir) => {
        const f = path.join(dir, "functions", "_lib", "security.js");
        const src = fs.readFileSync(f, "utf8");
        const out = src.replace(/^\s*"X-Frame-Options":\s*"DENY",\s*$/m, "");
        if (out === src) return false;
        fs.writeFileSync(f, out);
        return true;
      },
    },
    {
      name: "只改 _headers 一边的 HSTS 值（拷贝漂移）",
      expect: /_headers 的全局块里 Strict-Transport-Security/,
      apply: (dir) => {
        const f = path.join(dir, "_headers");
        const src = fs.readFileSync(f, "utf8");
        const out = src.replace("Strict-Transport-Security: max-age=31536000", "Strict-Transport-Security: max-age=600");
        if (out === src) return false;
        fs.writeFileSync(f, out);
        return true;
      },
    },
    {
      name: "把 sitemap 错误分支的 no-store 换成可缓存",
      expect: /sitemap 读库抛异常时 500 \+ no-store|sitemap 没配 D1 时 500 \+ no-store/,
      apply: (dir) => {
        const f = path.join(dir, "functions", "sitemap.xml.js");
        const src = fs.readFileSync(f, "utf8");
        const out = src.replace(
          'const ERR_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" };',
          'const ERR_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" };'
        );
        if (out === src) return false;
        fs.writeFileSync(f, out);
        return true;
      },
    },
    {
      name: "把 sitemap 的 Cache API 换成空壳（只剩标头）",
      expect: /sitemap 命中边缘缓存时\*\*完全不碰 D1\*\*|sitemap 冷启动把成功响应写进了边缘缓存/,
      apply: (dir) => {
        const f = path.join(dir, "functions", "sitemap.xml.js");
        const src = fs.readFileSync(f, "utf8");
        const out = src.replace(
          "  const cache = caches.default;",
          "  const cache = { match: async () => undefined, put: async () => {} };"
        );
        if (out === src) return false;
        fs.writeFileSync(f, out);
        return true;
      },
    },
  ];

  for (const m of MUTATIONS) {
    // ⚠️ 造故障这一步本身也会撒谎（`replace` 只替第一次出现、可能落在注释里）——
    //    所以必须验证「确实改到了」，改不到一律退出码 2，不能当成「比过了」。
    let dir = null;
    let landed = true;
    try {
      dir = makeSandboxTarget();
      landed = m.apply(dir);
    } catch (e) {
      landed = false;
      console.log("  ⚠️ 造故障时异常：" + e.message);
    }
    if (!landed) {
      console.log(`  ⚠️ 无法制造故障「${m.name}」—— 目标字符串没匹配上。`);
      console.log("RESULT: FAIL —— 造故障失败 ≠ 通过（退出码 2）");
      process.exit(2);
    }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--root=" + dir], { encoding: "utf8" });
    const outText = String(r.stdout || "") + String(r.stderr || "");
    const redCount = (outText.match(/^ {2}❌ /gm) || []).length;
    check(`负向自证「${m.name}」⇒ 判据变红且非零退出`, r.status !== 0 && redCount > 0,
      `exit=${r.status} 报红${redCount}条`);
    check(`负向自证「${m.name}」⇒ 报红的正是预期那几条`, m.expect.test(outText),
      (outText.match(/^ {2}❌ .*/gm) || []).slice(0, 4).join(" / ") || "（无报红）");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// 负向自证用的副本：从**仓库**取（不是从已经跑过的沙箱取），避免被前面的检查污染
function makeSandboxTarget() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-sechdr-neg-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  fs.cpSync(path.join(REPO, "functions"), path.join(tmp, "functions"), { recursive: true });
  for (const f of ["_headers", "index.html"]) {
    const src = path.join(REPO, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  const appJs = path.join(REPO, "assets", "app.js");
  if (fs.existsSync(appJs)) {
    fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
    fs.copyFileSync(appJs, path.join(tmp, "assets", "app.js"));
  }
  return tmp;
}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS —— 函数侧有安全头、静态侧两份拷贝一致、三个端点错误响应不可缓存");
