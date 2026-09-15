// 爬虫正文注入（dynamic rendering）回归测试
//
// 背景：本站是 SPA，文章正文完全靠前端 JS 渲染。百度/搜狗这类爬虫不执行 JS，
// 打开 /?post=<slug> 只能看到一个空的 #postDetail 容器 —— 正文一个字都抓不到，
// 所以文章根本进不了索引；顺带 share 卡片的 og:image 虽然早就修好了，
// 但「有卡片、没正文」对搜索收录毫无帮助。
//
// 线上实测（2026-09-15）确认三处缺陷，本脚本把它们逐一钉住：
//   ① #postDetail 是空的，正文为零；
//   ② <title> 仍是站点名 —— og:title 换了但 title 没换，搜索结果里每篇都显示站点名；
//   ③ 出现**两条 canonical**：站点级那条留在 OG 块之外没被替换掉，其中一条指向首页，
//      搜索引擎会据此把文章判为首页的副本。
//
// 用法：node scripts/verify-seo-render.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, articleFileName, materializeBodyImages, buildArticleHtml } from "./lib/seo-render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const INDEX_HTML = fs.readFileSync(path.join(root, "index.html"), "utf8");
const APP_SRC = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const ORIGIN = "https://blog-6p3.pages.dev";
const BOT_UA = "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)";
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 边缘环境的 caches.default：做成可读写、可在用例间清空的假实现，
// 这样才能真正覆盖「MISS 写入 → HIT 读取」这条路径（含 X-SSR-Body 透传）。
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const e = cacheStore.get(req.url);
      if (!e) return null;
      return new Response(e.text, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "X-SSR-Body": e.ssrBody },
      });
    },
    async put(req, res) {
      const text = await res.text();
      cacheStore.set(req.url, { text, ssrBody: res.headers.get("X-SSR-Body") || "0" });
    },
  },
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else {
    fail++;
    const d = detail == null ? "" : String(detail).replace(/\s+/g, " ").slice(0, 220);
    console.log("  ❌ " + name + (d ? "\n     实际: " + d : ""));
  }
}

const FRAG_PATH = "/generated/post-html/e65576f0a91714fd.html";
// 夹具由真正的构造函数生成，而不是手抄一份 HTML 字面量：
// 手抄件会悄悄和 buildArticleHtml() 漂移（标题从 h2 改成 h1 时只改了一边，断言照样全绿，
// 线上却是另一套结构）。结构类的断言交给 verify-heading-outline.mjs，这里只关心「注入了什么」。
const FRAG_HTML = buildArticleHtml({
  title: "心理学的领域",
  tag: "读书",
  date: "2026-09-13",
  author: "zfx",
  readingMinutes: 1,
  words: 60,
  views: 3,
  coverUrl: "",
  bodyHtml: renderMarkdown("心理学的领域是探索个人的所有表现涉及的意义。\n\n任何有意义的行动都必然以明确的目标导向为前提。"),
});

function basePost(over = {}) {
  return {
    title: "心理学的领域",
    date: "2026-09-13",
    tag: "读书",
    summary: "",
    cover: "",
    author_username: "zfx",
    ...over,
  };
}

// ⚠️ 每个用例必须用**不同的 slug**：index.js 内部对正文片段有 isolate 级缓存
// （真实行为，爬虫常对同一篇反复抓取），同一个 slug 复用会让后续用例命中前一个用例的缓存，
// 掩盖掉「映射表缺失 / 文件 404」这类本该发生的降级。
function makeEnv(post, opts = {}) {
  const slug = opts.slug || "psychology";
  const pages = opts.pages === undefined ? { [slug]: FRAG_PATH } : opts.pages;
  const fragments = opts.fragments === undefined ? { [FRAG_PATH]: FRAG_HTML } : opts.fragments;
  return {
    BLOG_DB: { prepare: () => ({ bind: () => ({ first: async () => post }) }) },
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.html") return new Response(INDEX_HTML, { status: 200 });
        if (p === "/generated/covers.json") return new Response("nope", { status: 404 });
        if (p === "/generated/post-html.json") {
          if (pages === null) return new Response("nope", { status: 404 });
          return new Response(JSON.stringify({ ok: true, pages }), { status: 200 });
        }
        if (p.startsWith("/generated/post-html/")) {
          if ((opts.pageMissing || []).includes(p)) return new Response("not found", { status: 404 });
          // 默认一律「文件存在」。这是被负向验证逼出来的设计：最初这里对任何非预期路径都返回 404，
          // 结果「删掉路径白名单」这个回退场景**没被拦住** —— 因为 404 本身就挡住了，
          // 断言测的是 404 而不是白名单。改成默认 200 之后，只有白名单能挡住非法路径。
          return new Response(fragments && fragments[p] != null ? fragments[p] : FRAG_HTML, { status: 200 });
        }
        return new Response("nope", { status: 404 });
      },
    },
  };
}

let caseSeq = 0;
// 每个用例都取**全新的模块实例**。原因：index.js 内部对「封面映射表」和「正文片段映射表」
// 都有 isolate 级 5 分钟缓存 —— 那是真实设计（爬虫会对同一篇反复抓取，省掉内部往返），
// 但如果在测试里复用一个实例，后面的用例就会读到前面用例的映射表，
// 把「映射表缺失 / 路径非法」这类降级路径测成**假通过**（本项目实际踩过）。
// ESM 的模块缓存按完整说明符区分，加一个递增的 query 就能拿到干净实例。
async function getOnRequestGet() {
  caseSeq += 1;
  const m = await import(`../functions/index.js?case=${caseSeq}`);
  return m.onRequestGet;
}

async function run(slug, env, ua = BOT_UA, opts = {}) {
  // 默认清空边缘缓存保证用例独立；测缓存行为本身时传 clearCache:false
  if (opts.clearCache !== false) cacheStore.clear();
  const onRequestGet = await getOnRequestGet();
  let nexted = false;
  const url = `${ORIGIN}/?post=${encodeURIComponent(slug)}`;
  const res = await onRequestGet({
    request: new Request(url, { headers: { "user-agent": ua } }),
    env,
    next: async () => { nexted = true; return new Response("STATIC-SHELL", { status: 200 }); },
  });
  const html = await res.text();
  const count = (re) => (html.match(re) || []).length;
  return {
    res, html, nexted,
    title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "",
    canonicals: [...html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((m) => m[1]),
    descriptions: count(/<meta name="description"/g),
    authors: count(/<meta name="author"/g),
    body: (html.match(/<!--SSR-BODY-START-->([\s\S]*?)<!--SSR-BODY-END-->/) || [])[1] || "",
  };
}

// ─────────────────────────────────────────────────────────────
console.log("[1] 爬虫请求：正文必须被注入");
{
  const r = await run("psychology", makeEnv(basePost()));
  check("响应 200 且未走静态壳", r.res.status === 200 && !r.nexted, `status=${r.res.status} next=${r.nexted}`);
  check("正文已进入 #postDetail 容器", r.body.includes("心理学的领域是探索个人的所有表现涉及的意义"), r.body.slice(0, 120));
  check("正文含多段（不是只截了第一行）", r.body.includes("任何有意义的行动都必然以明确的目标导向为前提"));
  check("正文被 <div class=\"post-body\"> 包裹（结构对得上），", r.body.includes('<div class="post-body">'));
  check("X-SSR-Body: 1（线上据此判断有没有注入正文）", r.res.headers.get("X-SSR-Body") === "1", r.res.headers.get("X-SSR-Body"));
}

console.log("\n[2] <title> 必须是文章标题");
{
  const r = await run("psychology", makeEnv(basePost()));
  check("title = 文章标题 · 站点名", r.title === "心理学的领域 · 昉昕的博客", r.title);
  check("不再残留站点默认标题", !r.html.includes("<title>昉昕的博客 · 记录与思考</title>"));
  check("title 只出现一次", (r.html.match(/<title>/gi) || []).length === 1);
}

console.log("\n[3] canonical 必须唯一且指向文章");
{
  const r = await run("psychology", makeEnv(basePost()));
  check("canonical 恰好一条", r.canonicals.length === 1, r.canonicals.join(" | "));
  check("canonical 指向文章地址（不是首页）",
    r.canonicals[0] === `${ORIGIN}/?post=psychology`, r.canonicals[0]);
  check("description 只有一条（否则爬虫可能取到站点描述）", r.descriptions === 1, `count=${r.descriptions}`);
  check("author 只有一条", r.authors === 1, `count=${r.authors}`);
}

console.log("\n[4] OG / Twitter / JSON-LD 保持完好");
{
  const r = await run("psychology", makeEnv(basePost()));
  check("og:title 为文章标题", r.html.includes('<meta property="og:title" content="心理学的领域"'));
  check("og:type 为 article", r.html.includes('<meta property="og:type" content="article"'));
  check("含 BlogPosting 结构化数据", r.html.includes('"@type":"BlogPosting"'));
  check("JSON-LD 里的 url 是文章地址", r.html.includes(`${ORIGIN}/?post=psychology`));
}

console.log("\n[5] 真人访问完全不受影响");
{
  const r = await run("psychology", makeEnv(basePost()), HUMAN_UA);
  check("真人 UA → 放行给静态壳（next 被调用）", r.nexted && r.html === "STATIC-SHELL", r.html.slice(0, 60));
  const r2 = await run("psychology", makeEnv(basePost()), "curl/8.4.0");
  check("非爬虫 UA（curl）同样放行", r2.nexted);
}

console.log("\n[6] 未知爬虫也要能拿到正文（名单兜底）");
{
  const r = await run("psychology", makeEnv(basePost()), "Mozilla/5.0 (compatible; YisouSpider/1.0)");
  check("YisouSpider（神马，不在固定名单里）也注入正文", r.body.includes("心理学的领域是探索"), r.body.slice(0, 80));
  const r2 = await run("psychology", makeEnv(basePost()), "SomeBrandNewAI-Crawler/2.1");
  check("含 crawler 字样的新爬虫也注入", r2.body.includes("心理学的领域是探索"));
}

console.log("\n[7] 各类降级路径都必须安全（宁可不注入，也不能 500）");
{
  const onRequestGet = await getOnRequestGet();
  const noSlug = await onRequestGet({
    request: new Request(`${ORIGIN}/`, { headers: { "user-agent": BOT_UA } }),
    env: makeEnv(basePost()),
    next: async () => { return new Response("STATIC-SHELL", { status: 200 }); },
  });
  check("无 ?post= → 放行", (await noSlug.text()) === "STATIC-SHELL");

  let nexted = false;
  const noDb = await onRequestGet({
    request: new Request(`${ORIGIN}/?post=psychology`, { headers: { "user-agent": BOT_UA } }),
    env: { ASSETS: makeEnv(basePost()).ASSETS },
    next: async () => { nexted = true; return new Response("STATIC-SHELL", { status: 200 }); },
  });
  check("未配置 BLOG_DB → 放行（不抛错）", nexted && (await noDb.text()) === "STATIC-SHELL");

  const gone = await run("psychology", makeEnv(null));
  check("文章不存在 → 放行", gone.nexted);

  const noPages = await run("no-pages", makeEnv(basePost(), { slug: "no-pages", pages: null }));
  check("映射表缺失 → 仍注入 meta，不注入正文", !noPages.nexted && noPages.title === "心理学的领域 · 昉昕的博客");
  check("映射表缺失时 X-SSR-Body: 0", noPages.res.headers.get("X-SSR-Body") === "0", noPages.res.headers.get("X-SSR-Body"));
  check("映射表缺失时 #postDetail 仍为空（前端照常渲染）", noPages.body === "");

  const missingFile = await run("missing-frag", makeEnv(basePost(), { slug: "missing-frag", pageMissing: [FRAG_PATH] }));
  check("片段文件 404 → 不崩、不注入正文", !missingFile.nexted && missingFile.body === "");

  const fresh = await run("brand-new", makeEnv(basePost(), { pages: {} }));
  check("文章是构建后才发布的（映射表没有它）→ 只注入 meta", fresh.title === "心理学的领域 · 昉昕的博客" && fresh.body === "");
}

console.log("\n[8] 映射表里的路径必须被白名单收窄");
{
  // 两个载荷都设计成「即便这个路径真能取到内容，也不该去取」：
  //   ① %2e%2e%2f 编码形式的目录穿越 —— URL 规范化管不到编码形式，
  //      若没有白名单，边缘会把请求原样打到 ASSETS 上；
  //   ② 非 .html 扩展名。
  // mock 对 /generated/post-html/ 下的任意路径都返回内容，所以白名单一旦被删，
  // 这两个断言会立刻由「空」变成「拿到正文」而失败（负向验证已覆盖）。
  const evil = "/generated/post-html/%2e%2e%2f%2e%2e%2fetc%2fpasswd";
  const r = await run("evil-path", makeEnv(basePost(), { slug: "evil-path", pages: { "evil-path": evil } }));
  check("编码式目录穿越被拒（不是靠 404，而是靠白名单）",
    r.body === "" && r.res.headers.get("X-SSR-Body") === "0", r.body.slice(0, 80));
  const r2 = await run("svg-path", makeEnv(basePost(), { slug: "svg-path", pages: { "svg-path": "/generated/post-html/x.svg" } }));
  check("非 .html 片段路径被拒", r2.body === "", r2.body.slice(0, 80));
  const r3 = await run("no-ext-path", makeEnv(basePost(), { slug: "no-ext-path", pages: { "no-ext-path": "/generated/post-html/x" } }));
  check("无扩展名的片段路径被拒", r3.body === "");
}

console.log("\n[9] 边缘缓存：命中时也要能看出有没有注入正文");
{
  const env = makeEnv(basePost(), { slug: "cache-test" });
  const first = await run("cache-test", env);
  const second = await run("cache-test", env, BOT_UA, { clearCache: false });
  check("首次 MISS、二次 HIT", first.res.headers.get("X-OG-Cache") === "MISS" && second.res.headers.get("X-OG-Cache") === "HIT",
    `${first.res.headers.get("X-OG-Cache")} / ${second.res.headers.get("X-OG-Cache")}`);
  check("HIT 时正文仍在（缓存的是注入后的完整 HTML）", second.body.includes("心理学的领域是探索"));
  check("HIT 时 X-SSR-Body 被透传", second.res.headers.get("X-SSR-Body") === "1", second.res.headers.get("X-SSR-Body"));
}

console.log("\n[10] index.html 结构守护（防止有人把站点 canonical 挪回块外）");
{
  const blockStart = INDEX_HTML.indexOf("<!--OG-DEFAULT-START-->");
  const blockEnd = INDEX_HTML.indexOf("<!--OG-DEFAULT-END-->");
  check("OG 块标记存在且顺序正确", blockStart > 0 && blockEnd > blockStart);
  const block = INDEX_HTML.slice(blockStart, blockEnd);
  // 匹配「带 href/content 的完整标签」而不是裸标签名：index.html 的注释里也出现了
  // `<link rel="canonical">` 这样的说明文字，用松断言会被自己的注释命中（踩过这个坑）。
  const CANON_RE = /<link rel="canonical" href=/;
  const DESC_RE = /<meta name="description" content=/;
  const AUTH_RE = /<meta name="author" content=/;
  check("站点 canonical 在 OG 块**内部**（否则文章页会残留第二条 canonical）", CANON_RE.test(block));
  check("站点 description 在块内部", DESC_RE.test(block));
  check("站点 author 在块内部", AUTH_RE.test(block));
  const outside = INDEX_HTML.slice(0, blockStart) + INDEX_HTML.slice(blockEnd);
  check("OG 块之外不再有第二条 canonical", !CANON_RE.test(outside));
  check("OG 块之外不再有第二条 description", !DESC_RE.test(outside));
  check("OG 块之外不再有第二条 author", !AUTH_RE.test(outside));
  check("#postDetail 带 SSR 占位标记", /<article class="post-detail" id="postDetail"><!--SSR-BODY-START--><!--SSR-BODY-END--><\/article>/.test(INDEX_HTML));
}

console.log("\n[11] 片段文件名与渲染器本身");
{
  const n = articleFileName("2026-09-13-心理学的领域-atn2");
  check("片段文件名是纯 ASCII（Pages 对非 ASCII 资源名不可靠）", /^[\x20-\x7e]+$/.test(n), n);
  check("片段文件名为 sha256 前 16 位 + .html", /^[a-f0-9]{16}\.html$/.test(n), n);
  check("同一 slug 稳定复现", articleFileName("a-b") === articleFileName("a-b"));
  check("不同 slug 不碰撞", articleFileName("a-b") !== articleFileName("a-c"));

  check("渲染器转义 <script>", !renderMarkdown("<script>alert(1)</script>").includes("<script>"));
  check("渲染器拒绝 javascript: 链接（降级为纯文本）",
    !renderMarkdown("[点我](javascript:alert(1))").includes("href="));
  check("渲染器拒绝 data:image/svg+xml（可携带脚本）",
    !renderMarkdown("![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)").includes("<img"));

  // 内嵌 base64 图落盘：扩展名必须与 MIME 对上。
  // 踩过的坑：正则捕获组拿到的已经是子类型（"jpeg"），代码里又 split("/") 一次 → undefined
  // → 静默落到 "png" 兜底，把 JPEG 存成 .png；而 Pages 按扩展名发 Content-Type，
  // 等于对外宣称了错误的类型。
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-img-"));
  const jpegUri = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
  const pngUri = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const jr = materializeBodyImages(`![a](${jpegUri})`, { outDir: imgDir, urlPrefix: "/generated/body-images" });
  check("JPEG 内嵌图落盘为 .jpg（不是一律兜底成 .png）",
    /\/generated\/body-images\/[a-f0-9]{8}\.jpg/.test(jr.markdown), jr.markdown);
  const pr = materializeBodyImages(`![b](${pngUri})`, { outDir: imgDir, urlPrefix: "/generated/body-images" });
  check("PNG 内嵌图落盘为 .png", /\/generated\/body-images\/[a-f0-9]{8}\.png/.test(pr.markdown), pr.markdown);
  const jrName = (jr.markdown.match(/body-images\/([^)]+)/) || [])[1] || "";
  check("落盘字节与 base64 原文一致",
    !!jrName && fs.readFileSync(path.join(imgDir, jrName)).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), jrName);
  check("同一张图重复出现只落一份（按内容哈希命名）",
    materializeBodyImages(`![a](${jpegUri})`, { outDir: imgDir, urlPrefix: "/generated/body-images" }).markdown === jr.markdown);
  check("文件名字符集是纯 ASCII 的 hash.ext", /^[a-f0-9]{8}\.(jpg|png)$/.test(jrName), jrName);
  const sr = materializeBodyImages("![s](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)", { outDir: imgDir, urlPrefix: "/generated/body-images" });
  check("svg 不落盘，交由渲染器走与前端相同的降级路径", sr.markdown.includes("data:image/svg+xml"), sr.markdown);
  check("没有 base64 的正文原样返回（不做无谓处理）",
    materializeBodyImages("普通正文", { outDir: imgDir, urlPrefix: "/x" }).markdown === "普通正文");
  fs.rmSync(imgDir, { recursive: true, force: true });
}

console.log("\n[12] 渲染一致性：构建期渲染器 vs 前端 mdToHtml");
{
  // 从 app.js 里整段取出 safeUrl + isArtifactCover + mdToHtml（三个相邻的顶层函数），
  // 用 Function 构造器执行 —— 不依赖花括号计数，靠「下一个顶层 function」定位终点。
  const startAt = APP_SRC.indexOf("  function safeUrl(raw, allowDataImage) {");
  const mdAt = APP_SRC.indexOf("  function mdToHtml(md) {");
  const endAt = APP_SRC.indexOf("\n  function ", mdAt + 10);
  check("能从 app.js 中截取到 mdToHtml", startAt > 0 && mdAt > startAt && endAt > mdAt);
  const { mdToHtml } = new Function(APP_SRC.slice(startAt, endAt) + "\n  return { mdToHtml };")();

  const samples = [
    "普通一段话。",
    "# 一级标题\n## 二级标题\n### 三级标题\n正文",
    "- 项目一\n- 项目二\n段落",
    "* 星号列表甲\n* 星号列表乙",
    "> 引用一\n> 引用二\n正文",
    "```js\nconst a = 1 < 2 && \"x\";\n```\n后面的段落",
    "**粗体**、*斜体*、`行内代码` 混排",
    "[正常链接](https://example.com) 和 [危险链接](javascript:alert(1))",
    "![图片](https://example.com/a.png)",
    "![内联图](data:image/png;base64,iVBORw0KGgo=)",
    "![svg图](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
    "<script>alert('xss')</script> 与 <img src=x onerror=alert(1)>",
    "含 \"双引号\" 与 '单引号' 与 & 和号",
    "段落一\n\n段落二\n\n\n段落三",
    "![图](https://x.com/b.png)紧随其后![图2](/c.png)",
    "反引号里的 `</div>` 不能闭合外层",
    "",
    "   ",
    "中文标点：，。！？——…《》",
    "混合：## 标题里的 **粗体** 与 `code`\n> 引用里的 [链接](https://a.com)\n- 列表里的 ![图](data:image/gif;base64,R0lGOD)",
  ];
  const diffs = [];
  for (const s of samples) {
    const a = mdToHtml(s), b = renderMarkdown(s);
    if (a !== b) diffs.push({ s, a, b });
  }
  check(`两边输出逐条一致（${samples.length} 组样本，含 XSS 与 data: 图片边界）`, diffs.length === 0,
    diffs.map((d) => `输入=${JSON.stringify(d.s)} 前端=${d.a} 构建=${d.b}`).join(" ／ "));

  // 防「提取失败但恰好两边都是空」的假通过
  check("一致性比对确实产生了非空输出（防假通过）",
    mdToHtml("**粗体**").includes("<strong>粗体</strong>") && renderMarkdown("**粗体**").includes("<strong>粗体</strong>"));
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
