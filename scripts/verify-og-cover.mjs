// og:image 封面解析回归测试
//
// 背景：分享到微信/微博的卡片封面永远是默认图。根因是 functions/index.js 只认
// ^https?:// 开头的 cover，而 D1 里后台上传的封面存的是 data: base64、构建期抽离后
// 又是站内相对路径 —— 两种都命中不了。
//
// 修复后：构建期输出 generated/covers.json（slug → 可对外引用的封面路径），
// 边缘函数查表换成绝对 URL；查不到则按「外链 → 相对路径 → 默认图」逐级兜底。
//
// 用法：node scripts/verify-og-cover.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const INDEX_HTML = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ORIGIN = "https://blog-6p3.pages.dev";
const DEFAULT_IMG = `${ORIGIN}/assets/og-default.png`;
const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const DATA_COVER = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");

// 边缘环境没有 caches.default，补一个空实现（否则 onRequestGet 会在取缓存那步抛错）
globalThis.caches = { default: { match: async () => null, put: async () => {} } };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

function makeEnv(post, manifest, options = {}) {
  const missing = new Set(options.missing || []);
  const errors = new Set(options.errors || []);
  return {
    BLOG_DB: { prepare: () => ({ bind: () => ({ first: async () => post }) }) },
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.html") return new Response(INDEX_HTML, { status: 200 });
        if (p === "/generated/covers.json") {
          if (!manifest) return new Response("nope", { status: 404 }); // 模拟构建期未产出映射表
          return new Response(JSON.stringify({ ok: true, covers: manifest }), { status: 200 });
        }
        // 封面文件：默认「存在」；errors → 500（瞬态故障），missing → 404（真缺失）
        if (errors.has(p)) return new Response("boom", { status: 500 });
        if (missing.has(p)) return new Response("not found", { status: 404 });
        if (
          p.startsWith("/generated/covers/") ||
          p.startsWith("/generated/body-images/") || // 封面复用正文图后就落在这里
          p.startsWith("/uploads/")
        )
          return new Response("img", { status: 200 });
        return new Response("nope", { status: 404 });
      },
    },
  };
}

function basePost(over = {}) {
  return {
    title: "测试标题",
    date: "2026-09-01",
    tag: "随笔",
    summary: "一段摘要。",
    cover: "",
    author_username: "昉昕",
    ...over,
  };
}

// 注意：manifest 只在同一 isolate 内缓存一次，且「取不到」不会被缓存。
// 所以先跑「映射表不可用」那组，再跑「映射表可用」那组。
const mod = await import("../functions/index.js");

async function run(label, post, manifest, ua = BOT_UA, options = {}) {
  const url = `${ORIGIN}/?post=${encodeURIComponent(post.slug)}`;
  const req = new Request(url, { headers: { "User-Agent": ua } });
  let fellBack = false;
  const res = await mod.onRequestGet({
    request: req,
    env: makeEnv(post, manifest, options),
    next: () => { fellBack = true; return new Response("fallback", { status: 200 }); },
  });
  const html = await res.text();
  const img = (html.match(/<meta property="og:image" content="([^"]*)"/) || [])[1];
  const tw = (html.match(/<meta name="twitter:image" content="([^"]*)"/) || [])[1];
  return { label, img, tw, html, fellBack };
}

console.log("\n[1] 映射表不可用（构建未产出 / ASSETS 404）时的兜底");
{
  const dataCase = await run("data 封面", basePost({ slug: "p-data", cover: DATA_COVER }), undefined);
  check("data: base64 → 退回默认图", dataCase.img === DEFAULT_IMG, dataCase.img);
  check("未回退到静态响应（og 注入仍然发生）", !dataCase.fellBack);

  const httpCase = await run("外链封面", basePost({ slug: "p-http", cover: "https://cdn.example.com/a.jpg" }), undefined);
  check("https 外链 → 原样使用", httpCase.img === "https://cdn.example.com/a.jpg", httpCase.img);

  const relCase = await run("相对路径封面", basePost({ slug: "p-rel", cover: "/uploads/old.jpg" }), undefined);
  check("站内相对路径 → 补成绝对 URL", relCase.img === `${ORIGIN}/uploads/old.jpg`, relCase.img);
}

console.log("\n[2] 映射表可用时以其为准");
{
  const manifest = {
    "p-data": "/generated/covers/p-data-abc12345.jpg",
    "p-http": "https://cdn.example.com/manifest-cover.jpg",
    "p-wins": "/generated/covers/p-wins-newhash.png",
    "p-gone": "/generated/covers/p-gone-missing.jpg",
    "p-err": "/generated/covers/p-err-abc12345.jpg",
    // 封面与正文图是同一张时，build 让它复用 /generated/body-images/ 那一个 URL（不再另存一份）。
    // 线上 7 篇有封面文章的封面现在全都在这个目录下，所以 og:image 必须照样认得它。
    "p-reuse": "/generated/body-images/5cfe2fcc.jpg",
    "p-reuse-gone": "/generated/body-images/deadbeef.jpg",
  };

  const a = await run("data 命中映射表", basePost({ slug: "p-data", cover: DATA_COVER }), manifest);
  check("data: 封面 → 换成抽离后的静态文件绝对 URL",
    a.img === `${ORIGIN}/generated/covers/p-data-abc12345.jpg`, a.img);
  check("twitter:image 同步为同一地址", a.tw === a.img, a.tw);

  const b = await run("外链命中映射表", basePost({ slug: "p-http", cover: "https://cdn.example.com/a.jpg" }), manifest);
  check("映射表优先于 D1 原值", b.img === "https://cdn.example.com/manifest-cover.jpg", b.img);

  const c = await run("映射表与 D1 原值冲突", basePost({ slug: "p-wins", cover: "/uploads/old.jpg" }), manifest);
  check("映射表给出的新哈希路径胜出（不会发旧封面）",
    c.img === `${ORIGIN}/generated/covers/p-wins-newhash.png`, c.img);

  const d = await run("slug 不在映射表", basePost({ slug: "p-new", cover: "/uploads/new.jpg" }), manifest);
  check("映射表未命中 → 相对路径兜底可用", d.img === `${ORIGIN}/uploads/new.jpg`, d.img);

  const e = await run("新文章 data 封面但未重新构建", basePost({ slug: "p-fresh", cover: DATA_COVER }), manifest);
  check("映射表未命中 + data: 封面 → 默认图", e.img === DEFAULT_IMG, e.img);

  // 线上事故回归（2026-09-11）：covers.json 里登记了某封面，该文件在部署里却 404。
  // 此时绝不能把 404 地址写进 og:image（卡片会是坏图，且被 caches.default 缓存 10 分钟）。
  const gone = await run("映射表命中但文件缺失", basePost({ slug: "p-gone", cover: DATA_COVER }), manifest,
    BOT_UA, { missing: ["/generated/covers/p-gone-missing.jpg"] });
  check("映射表指向已缺失的文件 → 退回默认图", gone.img === DEFAULT_IMG, gone.img);
  check("退回默认图时补上宽高", gone.html.includes('property="og:image:width" content="1200"'));

  const err = await run("复核封面时 ASSETS 抛 5xx", basePost({ slug: "p-err", cover: DATA_COVER }), manifest,
    BOT_UA, { errors: ["/generated/covers/p-err-abc12345.jpg"] });
  check("复核遇瞬态 5xx → 不降级，仍用映射表地址",
    err.img === `${ORIGIN}/generated/covers/p-err-abc12345.jpg`, err.img);

  // 封面复用正文图（/generated/body-images/…）后的爬虫路径：分享卡片必须照样有图
  const reuse = await run("封面复用正文图", basePost({ slug: "p-reuse", cover: DATA_COVER }), manifest);
  check("封面指向 /generated/body-images/… 时仍能当 og:image（不是只有 covers/ 才认）",
    reuse.img === `${ORIGIN}/generated/body-images/5cfe2fcc.jpg`, reuse.img);
  check("复用正文图时 twitter:image 同步", reuse.tw === reuse.img, reuse.tw);
  const reuseGone = await run("复用的正文图缺失", basePost({ slug: "p-reuse-gone", cover: DATA_COVER }), manifest,
    BOT_UA, { missing: ["/generated/body-images/deadbeef.jpg"] });
  check("复用的正文图缺失 → 同样退回默认图（存在性复核对这个目录也生效）",
    reuseGone.img === DEFAULT_IMG, reuseGone.img);
}

console.log("\n[2b] 站内相对路径兜底也必须复核存在性");
{
  // 线上事故回归（2026-09-12）：映射表登记的是失效路径，而 D1 的 cover 被后台「回存」
  // 成了同一条失效路径（历史构建的文件名含非 ASCII，Cloudflare 上取不到）。
  // 旧逻辑复核失败后立刻把这条路径原样返回 → og:image 依旧 404，分享卡片是坏图。
  const LEGACY = "/generated/covers/%E4%B8%AD%E6%96%87-abc12345.jpg";
  const stale = await run(
    "映射表与 D1 原值是同一条失效路径",
    basePost({ slug: "p-stale", cover: LEGACY }),
    { "p-stale": LEGACY },
    BOT_UA,
    { missing: [LEGACY] }
  );
  check("映射表+D1 同一条失效相对路径 → 退回默认图（不再原样返回 404）", stale.img === DEFAULT_IMG, stale.img);
  check("此时 twitter:image 也同步为默认图", stale.tw === DEFAULT_IMG, stale.tw);

  const staleNoMap = await run(
    "映射表未命中且相对路径文件缺失",
    basePost({ slug: "p-stale2", cover: "/generated/covers/gone-legacy.jpg" }),
    {},
    BOT_UA,
    { missing: ["/generated/covers/gone-legacy.jpg"] }
  );
  check("映射表未命中 + 相对路径文件缺失 → 默认图", staleNoMap.img === DEFAULT_IMG, staleNoMap.img);

  const okRel = await run(
    "相对路径文件确实存在",
    basePost({ slug: "p-okrel", cover: "/generated/covers/exists.jpg" }),
    {}
  );
  check("相对路径文件存在 → 照常使用", okRel.img === `${ORIGIN}/generated/covers/exists.jpg`, okRel.img);

  const jsUrl = await run("cover 为 javascript: 伪协议", basePost({ slug: "p-js", cover: "javascript:alert(1)" }), {});
  check("非 http(s) 协议 → 退回默认图，不写进 og:image", jsUrl.img === DEFAULT_IMG, jsUrl.img);

  const extRel = await run("外链相对协议 //evil", basePost({ slug: "p-proto", cover: "//evil.example.com/x.jpg" }), {});
  check("协议相对外链 → 仍作为外链放行（不误判为本站文件）",
    extRel.img === "https://evil.example.com/x.jpg", extRel.img);
}

console.log("\n[3] 无封面 / 结构正确性");
{
  const manifest = { "p-data": "/generated/covers/p-data-abc12345.jpg" };
  const none = await run("无封面", basePost({ slug: "p-none", cover: "" }), manifest);
  check("无封面 → 默认图", none.img === DEFAULT_IMG, none.img);
  check("默认图补上 og:image:width", none.html.includes('property="og:image:width" content="1200"'));
  check("默认图补上 og:image:height", none.html.includes('property="og:image:height" content="630"'));

  const real = await run("有真实封面", basePost({ slug: "p-data", cover: DATA_COVER }), manifest);
  check("真实封面不写死宽高（尺寸交给爬虫抓取）", !real.html.includes('property="og:image:width"'));

  check("只注入一处 og:image（替换而非追加）",
    (none.html.match(/property="og:image"/g) || []).length === 1,
    String((none.html.match(/property="og:image"/g) || []).length));
  check("首页默认 OG 块已被整块替换（meta 里无残留默认标题）",
    !none.html.includes('content="昉昕的博客 · 记录与思考"'));
  check("注入了文章自己的 og:title", none.html.includes('property="og:title" content="测试标题"'));
  check("</head> 结构完好", none.html.includes("</head>"));
}

console.log("\n[4] 不该处理的情况仍然放行");
{
  const manifest = {};
  const human = await run("真人 UA", basePost({ slug: "p-data", cover: DATA_COVER }), manifest,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
  // 真人 UA 时 next() 被调用 → 返回 fallback 文案
  check("非爬虫 UA → 直接 next()", human.fellBack, "fellBack=" + human.fellBack);
  check("非爬虫 UA → 不注入 OG（原样放行）", human.html === "fallback", human.html.slice(0, 60));

  const req = new Request(`${ORIGIN}/?post=p-missing`, { headers: { "User-Agent": BOT_UA } });
  let fell = false;
  await mod.onRequestGet({
    request: req,
    env: makeEnv(null, manifest), // 文章不存在
    next: () => { fell = true; return new Response("fallback", { status: 200 }); },
  });
  check("文章不存在 → 直接 next()", fell, "fellBack=" + fell);

  const noSlug = new Request(`${ORIGIN}/`, { headers: { "User-Agent": BOT_UA } });
  let fell2 = false;
  const res2 = await mod.onRequestGet({
    request: noSlug,
    env: makeEnv(basePost({ slug: "x" }), manifest),
    next: () => { fell2 = true; return new Response("fallback", { status: 200 }); },
  });
  check("无 ?post= → 直接 next()", fell2 && (await res2.text()) === "fallback");
}

console.log("\n[5] 元信息转义 / 完整性");
{
  const manifest = {};
  const tricky = await run("含引号的标题", basePost({
    slug: "p-esc",
    title: '带 "引号" 与 <script> 的标题',
    summary: "摘要 & 符号",
    cover: "",
  }), manifest);
  check("标题中的引号被转义（不破坏 meta 属性）", !tricky.html.includes('content="带 "引号"'));
  check("标题中的 < > 被转义", !tricky.html.includes("<script> 的标题"));
  check("输出含 JSON-LD 结构化数据", tricky.html.includes('application/ld+json'));
  check("canonical 指向文章地址", tricky.html.includes(`${ORIGIN}/?post=p-esc`));
}

console.log("\n[6] 封面文件名必须纯 ASCII");
{
  // 起因：Cloudflare Pages 对「含非 ASCII 字符的静态资源文件名」不可靠 —— 实测线上出现过
  // covers.json 登记了某封面、部署里该文件却 404（同批其它中文名文件正常）。
  // 上游同类报告：https://github.com/solidjs/solid-start/issues/1607
  // 因此封面文件名改为「slug 的 sha256 前 10 位 + 内容哈希」，不再含 slug 原文。
  const buildSrc = fs.readFileSync(path.join(root, "build.mjs"), "utf8");
  check("build.mjs 用 slug 哈希做文件名前缀（不含 slug 原文）",
    /\$\{slugKey\}-\$\{hash8\}/.test(buildSrc) && !/\$\{safe\}/.test(buildSrc),
    "未找到 `${slugKey}-${hash8}` 模板或仍在使用 `${safe}`");
  check("build.mjs 含构建期自检（映射表 ↔ 文件存在性）",
    /coverIssues/.test(buildSrc), "未找到封面映射表自检逻辑");
  // 按「语义组合」断言，不锁死变量名（原先写死 COVER_PREFIX/COVER_DIR，
  // 把复核范围放宽到整个 /generated/ 之后就误报失败 —— 断言该拦的是「防御还在不在」，
  // 不是「变量是不是还叫这个名字」）。四要素：产物前缀判断 → 解码 URL → 拦 ".." 越权 → 查文件是否存在。
  check("build.mjs 丢弃「指向不存在文件」的历史站内封面路径（不污染映射表）",
    /startsWith\([A-Z_]*PREFIX\)/.test(buildSrc) &&
      /existsSync\(join\((OUT_DIR|COVER_DIR),\s*rel\)\)/.test(buildSrc) &&
      /includes\("\.\."\)/.test(buildSrc),
    "未找到站内相对路径的存在性校验（前缀判断 / decodeURIComponent / .. 拦截 / existsSync）");
  // 复核范围必须是整个构建产物根目录：封面现在可能复用 /generated/body-images/ 里的正文图
  // （见 materializeCover），只盯着 /generated/covers/ 会漏掉这一类。
  check("存在性复核覆盖整个 /generated/（而非只管 covers 子目录）",
    /ARTIFACT_PREFIX\s*=\s*"\/generated\/"/.test(buildSrc),
    "ARTIFACT_PREFIX 未定义或不再是 /generated/");

  const idxSrc = fs.readFileSync(path.join(root, "functions", "index.js"), "utf8");
  check("边缘函数复核封面文件是否存在", /assetExists/.test(idxSrc), "未找到 assetExists");
  check("边缘函数的相对路径兜底同样复核存在性（不原样返回已判定 404 的地址）",
    /if \(c\.startsWith\("\/"\)\) return await accept\(c\)/.test(idxSrc),
    "兜底分支未走 accept()：会把已复核为 404 的相对路径原样写进 og:image");
}

console.log("\n" + (fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`));
process.exitCode = fail === 0 ? 0 : 1;
