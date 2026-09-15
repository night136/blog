// 封面投递回归：封面会不会拖慢首屏、为什么会不加载
//
// 背景（2026-09-15，用户反馈「封面图会阻塞吗，为啥会不加载」）。用真实浏览器（Edge + CDP，
// 见 scripts/perf-probe.mjs）量出来的事实：
//   ① 图片从来不是渲染阻塞资源 —— FCP 1040ms 时三张封面还在下载（1133–2072ms）。
//      但它们是 LCP：详情页 LCP = 2456ms，就是那张 <img class="post-cover">。
//   ② 更要命的是「白下」：分享链接（?post=slug）打开文章时，首页整块 300ms 后就被切走，
//      可卡片封面的 loading="lazy" 已经在「首页可见」的那个窗口里判定进入视口并开始下载，
//      而切换视图**不会取消已发出的请求**。文章页冷启动因此白下 5 张首页封面（实测 643KB，
//      单张 93–183KB），和文章自己的封面/正文图抢同一条跨境连接。
//   ③ 「不加载」有两个真实原因，都不是玄学：
//      · D1 里存着历史构建的产物路径（含中文 slug 的旧命名），线上 404，
//        构建按设计丢弃 → 封面永久空白。而原图其实还在正文里（同一张图，内容哈希一致）。
//      · 列表接口丢弃 data: 内联封面（防响应膨胀到几百 KB）后直接留空，于是
//        「静态快照有封面、API 降级路径没封面」，快照一失败封面就集体消失。
//
// 本脚本验证四件事：前端不再白下封面、封面自愈真的生效、列表封面取值规则、以及这些都是**行为**验证
// （在 DOM 沙箱里真跑 app.js / 在临时目录里真跑 build.mjs），不是「源码里有没有这行字」。
// 用法：node scripts/verify-cover-delivery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listCover } from "../functions/_lib/cover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}
const section = (t) => console.log("\n" + t);

const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const buildSrc = fs.readFileSync(path.join(root, "build.mjs"), "utf8");
// 断言前剥掉注释：改动说明里**必须**提到旧实现（"loading=lazy 会白下封面"之类），
// 拿原文全文匹配会把那些解释当成违规实现 —— 这个坑在本仓库出现过两次。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const appCode = stripComments(appSrc);
const buildCode = stripComments(buildSrc);
// 取一个 IIFE 内顶层函数的函数体：从 `function name(` 切到下一个 `\n  function `。
// ⚠️ 不要写 `[\s\S]{0,N}` 这种定长窗口 —— 长了短了都会静默截错，
// 而截错的表现是「断言查不到」而不是「报错」，很容易被当成真失败去改实现。
function fnBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const rest = src.slice(i + header.length);
  const end = rest.search(/\n  (?:async )?function /);
  return header + (end >= 0 ? rest.slice(0, end) : rest.slice(0, 4000));
}

// ═══════════════════════════════════════════════════════════════════════════
section("[1] 深链打开文章：首页封面不许下载");
{
  // deferHomeCovers 必须在 loadPosts() **之前**赋值：loadPosts 是异步的，但它同步走到
  // await 之前就会调用渲染吗？不会 —— 不过「先赋值再调用」是唯一不依赖时序的写法。
  const bootIdx = appCode.indexOf("bindInputStates();");
  const deferIdx = appCode.indexOf("deferHomeCovers = !!startSlug;");
  const loadIdx = appCode.indexOf("loadPosts();", bootIdx >= 0 ? bootIdx : 0);
  check("deferHomeCovers 由 ?post= 决定", deferIdx >= 0, "未找到 deferHomeCovers = !!startSlug");
  check("deferHomeCovers 在 loadPosts() 之前赋值",
    deferIdx >= 0 && loadIdx > deferIdx, `defer@${deferIdx} loadPosts@${loadIdx}`);

  const cardHtmlFn = fnBody(appCode, "function cardHtml(p, i) {");
  check("卡片封面走 homeCoversReady() 决定写 src 还是 data-cover",
    /homeCoversReady\(\)/.test(cardHtmlFn) && /data-cover=/.test(cardHtmlFn), cardHtmlFn.slice(0, 160));

  const sliderFn = fnBody(appCode, "function renderSlider() {");
  check("轮播非当前张只登记 data-bg（不设背景图）",
    /homeCoversReady/.test(sliderFn) && /data-bg=/.test(sliderFn), sliderFn.slice(0, 160));

  const showViewFn = fnBody(appCode, "function showView(name) {");
  check("回到首页时补上被推迟的封面（showView → activateHomeCovers）",
    /activateHomeCovers\(\)/.test(showViewFn), showViewFn.slice(0, 200));

  const actFn = fnBody(appCode, "function activateHomeCovers() {");
  check("activateHomeCovers 会把 data-cover 落成 src",
    /img\[data-cover\]/.test(actFn) && /dataset\.cover/.test(actFn), actFn.slice(0, 160));
  check("activateHomeCovers 会把 data-bg 落成 backgroundImage",
    /\.slide\[data-bg\]/.test(actFn) && /backgroundImage/.test(actFn), actFn.slice(0, 160));
  check("activateHomeCovers 会解除推迟标记（否则回首页后仍不再下载）",
    /deferHomeCovers = false/.test(actFn), actFn.slice(0, 160));
}

// ═══════════════════════════════════════════════════════════════════════════
section("[2] 详情页封面按 LCP 处理");
{
  check("post-cover 带 fetchpriority=high（它就是这个页面的 LCP 元素）",
    /class="post-cover"[^>]*fetchpriority="high"/.test(appCode),
    "hero 未标记 fetchpriority");
  check("post-cover 带 decoding=async（竖版大图同步解码会顶掉一帧）",
    /class="post-cover"[^>]*decoding="async"/.test(appCode),
    "hero 未标记 decoding");
}

// ═══════════════════════════════════════════════════════════════════════════
section("[3] 行为验证：DOM 沙箱里真跑 app.js，看它到底下了什么");
// 前两节只能证明「代码是这么写的」。封面白下恰恰是**时序**问题（渲染那一刻首页还可见），
// 所以必须真跑一遍：给沙箱注入真实的 posts 数据，看渲染出来的 HTML 里有没有 src / background-image。
const TINY_PNG_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
// 第二张图：必须与 TINY_PNG_1 **内容不同**（否则内容哈希一样，就测不出「认的是哪一张」）。
// 两者都是合法 PNG（3×2 与 1×1），hash8 分别是 6d28ca23 / a4bcd7b8。
const TINY_PNG_2 = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4EaABQQxwFgBO1AeBToSARAAAAABJRU5ErkJggg==";
const b64hash8 = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 8);
const FAKE_POSTS = [
  { id: 1, slug: "has-cover", title: "有封面的文章", date: "2026-09-14", tag: "测试", summary: "摘要",
    cover: "/generated/covers/aaaaaaa111-11111111.jpg", author: "昉昕", readingMinutes: 1, words: 10, views: 3 },
  { id: 2, slug: "no-cover", title: "无封面的文章", date: "2026-09-13", tag: "测试", summary: "摘要",
    cover: "", author: "昉昕", readingMinutes: 1, words: 10, views: 1 },
];

function runApp({ search = "" } = {}) {
  const mk = (id) => ({
    id, tagName: "DIV", className: "", innerHTML: "", textContent: "", title: "", value: "",
    dataset: {}, style: {}, children: [], hidden: false, checked: false, maxLength: 0,
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollHeight: 0, offsetTop: 0, offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _sub: {},
    querySelector(sel) { const k = "q:" + sel; if (!this._sub[k]) this._sub[k] = mk(id + sel); return this._sub[k]; },
    querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false,
    addEventListener() {}, removeEventListener() {}, appendChild: (c) => c, append() {}, prepend() {},
    remove() {}, removeChild() {}, replaceChildren() {}, insertBefore: (c) => c, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    focus() {}, blur() {}, click() {}, submit() {}, reset() {}, setSelectionRange() {},
    scrollIntoView() {}, scrollTo() {}, animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    dispatchEvent: () => true, cloneNode() { return mk(id); },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 }),
  });
  // 所有 id 都返回**稳定**节点（按 id 记忆），否则读不到渲染结果 —— renderCards 写的是
  // cardGrid.innerHTML，每次新建节点就等于把结果丢了。
  const els = new Map();
  const elById = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetchMock = async (url) => {
    const u = String(url);
    if (u.includes("/generated/posts.json")) {
      return jsonRes({ ok: true, count: FAKE_POSTS.length, latest: FAKE_POSTS[0].slug, generatedAt: "2026-09-15T00:00:00Z", posts: FAKE_POSTS });
    }
    if (u.includes("/api/me")) return jsonRes({ user: null });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const doc = {
    documentElement: mk("html"), body: mk("body"), head: mk("head"),
    getElementById: elById, querySelector: (sel) => mk(sel), querySelectorAll: () => [],
    createElement: (t) => mk(t), createTextNode: (t) => ({ text: t }), createDocumentFragment: () => mk("frag"),
    addEventListener() {}, removeEventListener() {}, readyState: "complete", title: "", cookie: "", referrer: "",
  };
  const sandbox = {
    document: doc, window: null, self: null, globalThis: null,
    navigator: { userAgent: "node", language: "zh-CN", maxTouchPoints: 0, clipboard: { writeText: async () => {} } },
    location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search, hash: "", href: "https://blog-6p3.pages.dev/" + search, reload() {}, assign() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch: fetchMock,
    setTimeout: () => 0, clearTimeout() {}, setImmediate: () => 0,
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    history: { pushState() {}, replaceState() {}, back() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    alert() {}, confirm: () => true, prompt: () => null,
    addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollBy() {}, open: () => null,
    console: { log() {}, error() {}, warn() {} },
    Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, WeakMap, Promise,
    RegExp, Error, TypeError, Symbol, Function, Proxy, Reflect, Intl, URL, URLSearchParams,
    AbortController, TextEncoder, TextDecoder, performance: { now: () => 0 },
    crypto: { randomUUID: () => "uuid", getRandomValues: (a) => a },
    caches: { default: { match: async () => null, put: async () => {} } },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: "app.js" });
  return { cards: () => elById("cardGrid").innerHTML, slides: () => elById("slides").innerHTML };
}

const drain = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

{
  const deep = runApp({ search: "?post=has-cover" });
  await drain();
  const deepCards = deep.cards();
  const deepSlides = deep.slides();
  check("深链：卡片渲染出来了（前置条件，否则下面的断言没意义）",
    deepCards.includes("has-cover"), "cardGrid 为空：" + deepCards.slice(0, 120));
  check("深链：卡片封面写的是 data-cover，不是 src",
    deepCards.includes('data-cover="/generated/covers/aaaaaaa111-11111111.jpg"'),
    deepCards.slice(0, 300));
  check("深链：卡片封面没有 src（这一条就是「不白下 643KB」的保证）",
    !/class="card-cover-img"[^>]*\ssrc=/.test(deepCards),
    (deepCards.match(/<img[^>]*card-cover-img[^>]*>/) || [""])[0]);
  check("深链：轮播把封面记在 data-bg，没设 background-image",
    deepSlides.includes("data-bg=") && !/class="slide[^"]*"[^>]*background-image/.test(deepSlides),
    deepSlides.slice(0, 260));
  check("深链：无封面的文章仍走渐变兜底（没被推迟逻辑弄丢）",
    /no-cover/.test(deepSlides), deepSlides.slice(0, 200));
}

{
  const normal = runApp({ search: "" });
  await drain();
  const nCards = normal.cards();
  const nSlides = normal.slides();
  check("普通访问：卡片封面照常有 src（推迟逻辑没有伤到首页）",
    nCards.includes('src="/generated/covers/aaaaaaa111-11111111.jpg"'), nCards.slice(0, 300));
  check("普通访问：卡片封面不再写 data-cover",
    !nCards.includes('data-cover="/generated/covers/'), nCards.slice(0, 300));
  check("普通访问：轮播照常设了 background-image",
    /class="slide[^"]*"[^>]*background-image/.test(nSlides), nSlides.slice(0, 260));
}

// ═══════════════════════════════════════════════════════════════════════════
section("[4] build 封面自愈：临时目录 + mock D1 真跑 build.mjs");
// build.mjs 从 D1 REST API 取数，本地没有凭据。用 --import 把 globalThis.fetch 换成 mock，
// 这样跑的是**真实的 build.mjs**（真实排版、真实落盘、真实封面色登记），只有数据来自夹具。
const MOCK_ROWS = [
  { id: 1, slug: "dead-cover-has-body-img", title: "失效封面+正文有图", date: "2026-09-10", tag: "测试", summary: "",
    cover: "/generated/covers/2026-09-10-%E4%B8%AD%E6%96%87-slug-ab12cd34.jpg", // 历史命名（含中文 slug），线上 404
    author_username: "昉昕", views: 1, words: 10, body: "正文开头\n\n![图](data:image/png;base64," + TINY_PNG_1 + ")\n\n结尾" },
  { id: 2, slug: "dead-cover-no-body-img", title: "失效封面+正文无图", date: "2026-09-09", tag: "测试", summary: "",
    cover: "/generated/covers/deadbeef00-00000000.jpg", author_username: "昉昕", views: 1, words: 10, body: "纯文字，没有图" },
  { id: 3, slug: "inline-cover", title: "base64 内联封面", date: "2026-09-08", tag: "测试", summary: "",
    cover: "data:image/png;base64," + TINY_PNG_1, author_username: "昉昕", views: 1, words: 10, body: "无图" },
  { id: 4, slug: "external-cover", title: "外链封面", date: "2026-09-07", tag: "测试", summary: "",
    cover: "https://cdn.example.com/a.jpg", author_username: "昉昕", views: 1, words: 10, body: "无图" },
  // 封面就是正文首图（同一份字节）：不该在 /generated/covers/ 再存一份 —— 两个 URL 会被下两遍
  { id: 6, slug: "cover-is-body-img", title: "封面即正文首图", date: "2026-09-05", tag: "测试", summary: "",
    cover: "data:image/png;base64," + TINY_PNG_1, author_username: "昉昕", views: 1, words: 10,
    body: "![首图](data:image/png;base64," + TINY_PNG_1 + ")\n\n正文" },
  // 封面是正文的**第二张**图：复用要认内容哈希，不能只认首图（认错了就会指向另一张图）
  { id: 7, slug: "cover-is-2nd-body-img", title: "封面即正文第二张图", date: "2026-09-04", tag: "测试", summary: "",
    cover: "data:image/png;base64," + TINY_PNG_2, author_username: "昉昕", views: 1, words: 10,
    body: "![一](data:image/png;base64," + TINY_PNG_1 + ")\n\n![二](data:image/png;base64," + TINY_PNG_2 + ")\n\n正文" },
];

function setupTmp(mutate = (s) => s) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-cover-verify-"));
  fs.mkdirSync(path.join(tmp, "assets", "vendor"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "build.mjs"), mutate(buildSrc));
  fs.copyFileSync(path.join(root, "index.html"), path.join(tmp, "index.html"));
  const srcAssets = path.join(root, "assets");
  for (const f of fs.readdirSync(srcAssets)) {
    const s = path.join(srcAssets, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmp, "assets", f));
  }
  for (const f of fs.readdirSync(path.join(srcAssets, "vendor"))) {
    fs.copyFileSync(path.join(srcAssets, "vendor", f), path.join(tmp, "assets", "vendor", f));
  }
  const srcLib = path.join(root, "scripts", "lib");
  fs.mkdirSync(path.join(tmp, "scripts", "lib"), { recursive: true });
  for (const f of fs.readdirSync(srcLib)) fs.copyFileSync(path.join(srcLib, f), path.join(tmp, "scripts", "lib", f));

  // 「已存在的产物路径要保留」的正样本：先手工放一个文件，再把某篇的 cover 指向它
  const keepName = "keep000001-abcdef01.png";
  fs.mkdirSync(path.join(tmp, "generated", "covers"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "generated", "covers", keepName), Buffer.from(TINY_PNG_1, "base64"));
  const rows = JSON.parse(JSON.stringify(MOCK_ROWS));
  rows.push({ id: 5, slug: "alive-cover", title: "仍然有效的封面路径", date: "2026-09-06", tag: "测试", summary: "",
    cover: "/generated/covers/" + keepName, author_username: "昉昕", views: 1, words: 10, body: "无图" });

  fs.writeFileSync(path.join(tmp, "mock-rows.json"), JSON.stringify(rows));
  fs.writeFileSync(path.join(tmp, "mock-fetch.mjs"), `
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync(new URL("./mock-rows.json", import.meta.url), "utf8"));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (!url.includes("api.cloudflare.com")) return realFetch(input, init);
  if (String(init && init.body).includes("ORDER BY date DESC")) {
    return new Response(JSON.stringify({ success: true, result: [{ results: rows }] }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: true, result: [{}] }), { headers: { "Content-Type": "application/json" } });
};
`);
  return { tmp, keepName };
}

function runBuild(tmp) {
  const env = { ...process.env, CF_ACCOUNT_ID: "mock", CF_DATABASE_ID: "mock", CF_API_TOKEN: "mock" };
  // ⚠️ Windows 上 --import 必须给 file:// URL：直接给绝对路径会被当成协议名（Received protocol 'c:'）
  const mockUrl = pathToFileURL(path.join(tmp, "mock-fetch.mjs")).href;
  const out = execFileSync(process.execPath, ["--import", mockUrl, "build.mjs"],
    { cwd: tmp, env, encoding: "utf8", stdio: "pipe" });
  return out;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

let tmpInfo = null;
try {
  tmpInfo = setupTmp();
  const { tmp, keepName } = tmpInfo;
  const out = runBuild(tmp);
  const list = readJson(path.join(tmp, "generated", "posts.json"));
  const covers = readJson(path.join(tmp, "generated", "covers.json")).covers;
  const byslug = Object.fromEntries(list.posts.map((p) => [p.slug, p.cover]));

  check("build 真的跑了（拿到 7 篇列表）", list.posts.length === 7, "篇数=" + list.posts.length + "\n" + out.slice(-500));

  const detail1 = readJson(path.join(tmp, "generated", "posts", "dead-cover-has-body-img.json")).post;
  const bodyImgPath = (detail1.body.match(/\/generated\/body-images\/[0-9a-f]{8}\.png/) || [])[0] || "";
  check("失效封面 + 正文有图 → 回退到正文首图（不再是空白）",
    /^\/generated\/body-images\/[0-9a-f]{8}\.png$/.test(byslug["dead-cover-has-body-img"]),
    JSON.stringify(byslug["dead-cover-has-body-img"]));
  check("回退用的就是正文里那一张（同一 URL ⇒ 浏览器只下一次，不会多花字节）",
    bodyImgPath && byslug["dead-cover-has-body-img"] === bodyImgPath,
    `cover=${byslug["dead-cover-has-body-img"]} body=${bodyImgPath}`);
  check("回退的图片文件真的落盘了",
    bodyImgPath && fs.existsSync(path.join(tmp, bodyImgPath.replace(/^\//, ""))), bodyImgPath);
  check("详情快照与列表快照的封面一致（否则详情页有图、列表没图）",
    detail1.cover === byslug["dead-cover-has-body-img"], detail1.cover);
  check("封面映射表也登记了（爬虫 og:image 走它）",
    covers["dead-cover-has-body-img"] === byslug["dead-cover-has-body-img"], JSON.stringify(covers["dead-cover-has-body-img"] || null));

  check("失效封面 + 正文无图 → 才允许丢成空（不能瞎猜一张图出来）",
    byslug["dead-cover-no-body-img"] === "", JSON.stringify(byslug["dead-cover-no-body-img"]));
  check("丢空的那篇不进映射表", !covers["dead-cover-no-body-img"], JSON.stringify(covers["dead-cover-no-body-img"] || null));

  check("base64 内联封面照常抽离成静态文件",
    /^\/generated\/covers\/[0-9a-f]{10}-[0-9a-f]{8}\.png$/.test(byslug["inline-cover"]), JSON.stringify(byslug["inline-cover"]));
  check("抽离出的封面文件真的存在",
    fs.existsSync(path.join(tmp, byslug["inline-cover"].replace(/^\//, ""))), byslug["inline-cover"]);

  check("外链封面原样保留", byslug["external-cover"] === "https://cdn.example.com/a.jpg", byslug["external-cover"]);
  check("仍然有效的站内产物路径按原样保留（自愈不该误伤）",
    byslug["alive-cover"] === "/generated/covers/" + keepName, JSON.stringify(byslug["alive-cover"]));

  // 封面 == 正文首图时不要存两份：两个 URL 会被浏览器下两遍（缓存不跨 URL 共享）
  const detail6 = readJson(path.join(tmp, "generated", "posts", "cover-is-body-img.json")).post;
  const coverPath6 = detail6.cover || "";
  check("封面与正文首图是同一张时，封面直接复用正文产物（不重复落盘）",
    /^\/generated\/body-images\/[0-9a-f]{8}\.png$/.test(coverPath6), JSON.stringify(coverPath6));
  check("复用的确实是正文里那一张（URL 完全相同才会命中同一份缓存）",
    coverPath6 && detail6.body.includes("](" + coverPath6 + ")"),
    `cover=${coverPath6} body=${(detail6.body.match(/\]\(([^)]+)\)/) || [])[1]}`);
  // ⚠️ 断言必须按 **slug 哈希前缀** 认人，不能按「有没有同内容哈希的文件」——
  // 同内容哈希完全可能出现在**另一篇**的封面里（本夹具里 inline-cover 用的就是同一张 PNG，
  // 而它正文无图、理应老老实实落一份封面）。按内容匹配会把那一篇的合法文件当成自己的重复。
  const coversDir = () => fs.readdirSync(path.join(tmp, "generated", "covers"));
  const slugHash = (slug) => createHash("sha256").update(slug).digest("hex").slice(0, 10);
  check("没有为它另存一份 /generated/covers/ 文件（省下的就是这份重复字节）",
    !coversDir().some((f) => f.startsWith(slugHash("cover-is-body-img"))),
    coversDir().join(","));

  // 封面是正文第二张图：复用要认内容哈希，认成首图就会指向另一张图
  const detail7 = readJson(path.join(tmp, "generated", "posts", "cover-is-2nd-body-img.json")).post;
  const imgA = `/generated/body-images/${b64hash8(TINY_PNG_1)}.png`;
  const imgB = `/generated/body-images/${b64hash8(TINY_PNG_2)}.png`;
  check("封面是正文第二张图时，也复用正文产物",
    /^\/generated\/body-images\/[0-9a-f]{8}\.png$/.test(detail7.cover || ""), JSON.stringify(detail7.cover));
  check("复用的是**第二张**（不是首图）：同一 URL 才只下一次",
    detail7.cover === imgB, `cover=${detail7.cover} 期望=${imgB}（首图是 ${imgA}）`);
  check("第二张图确实躺在正文里（否则复用的 URL 会 404）",
    detail7.body.includes("](" + imgB + ")"), detail7.body.slice(0, 120));
  check("两篇「封面即正文图」都没进 /generated/covers/",
    !coversDir().some((f) => f.startsWith(slugHash("cover-is-2nd-body-img")) || f.startsWith(slugHash("cover-is-body-img"))),
    coversDir().join(","));

  // 负向变异①：把自愈分支掐掉，上面两条断言必须变红 —— 证明这个分支是「承重」的。
  // ⚠️ 变异锚点必须与 build.mjs 里的实际写法逐字一致：锚点写错时 replace 静默不生效，
  // 于是「负向」用例反而会失败（这次就是这样拦住了我把变量改名后忘了同步）。
  const MUT_SELFHEAL = "if (firstBodyImg) {";
  if (!buildSrc.includes(MUT_SELFHEAL)) throw new Error("负向变异锚点失效，build.mjs 里找不到：" + MUT_SELFHEAL);
  const tmp2 = setupTmp((s) => s.replace(MUT_SELFHEAL, "if (false) {"));
  runBuild(tmp2.tmp);
  const list2 = readJson(path.join(tmp2.tmp, "generated", "posts.json"));
  const byslug2 = Object.fromEntries(list2.posts.map((p) => [p.slug, p.cover]));
  check("负向变异：掐掉自愈分支后，失效封面确实又变回空白",
    byslug2["dead-cover-has-body-img"] === "", JSON.stringify(byslug2["dead-cover-has-body-img"]));

  // 负向变异②：掐掉「复用正文图」分支，封面就该退回自己落一份 /generated/covers/
  const MUT_REUSE = "if (same) return record(same.url);";
  if (!buildSrc.includes(MUT_REUSE)) throw new Error("负向变异锚点失效，build.mjs 里找不到：" + MUT_REUSE);
  const tmp3 = setupTmp((s) => s.replace(MUT_REUSE, "if (false) return record(same.url);"));
  runBuild(tmp3.tmp);
  const list3 = readJson(path.join(tmp3.tmp, "generated", "posts.json"));
  const byslug3 = Object.fromEntries(list3.posts.map((p) => [p.slug, p.cover]));
  check("负向变异：掐掉复用分支后，封面又变回自己那份 /generated/covers/ 文件（证明复用是承重的）",
    /^\/generated\/covers\/[0-9a-f]{10}-[0-9a-f]{8}\.png$/.test(byslug3["cover-is-body-img"] || ""),
    JSON.stringify(byslug3["cover-is-body-img"]));
} catch (e) {
  fail++;
  console.log("  ❌ build 自愈验证抛错：" + e.message);
  if (e.stdout) console.log(String(e.stdout).slice(-800));
  if (e.stderr) console.log(String(e.stderr).slice(-800));
}

// ═══════════════════════════════════════════════════════════════════════════
section("[5] 列表封面取值规则（真调用 listCover）");
{
  const MANIFEST = { s: "/generated/covers/aaaaaaa111-11111111.jpg" };
  check("D1 存 data: → 用构建产物路径补上（否则 API 降级路径封面集体消失）",
    listCover("data:image/png;base64,AAAA", "s", MANIFEST) === MANIFEST.s, listCover("data:image/png;base64,AAAA", "s", MANIFEST));
  check("data: 但映射表里没有 → 空（不知道路径就不猜）",
    listCover("data:image/png;base64,AAAA", "s", {}) === "", listCover("data:image/png;base64,AAAA", "s", {}));
  check("D1 存产物路径 → 以本轮构建写出的路径为准（旧路径可能已 404）",
    listCover("/generated/covers/2026-09-10-%E4%B8%AD%E6%96%87-x.jpg", "s", MANIFEST) === MANIFEST.s,
    listCover("/generated/covers/old.jpg", "s", MANIFEST));
  check("D1 存产物路径、映射表也没有 → 保留原值（前端还有破图自愈兜底）",
    listCover("/generated/covers/old.jpg", "s", {}) === "/generated/covers/old.jpg", listCover("/generated/covers/old.jpg", "s", {}));
  check("⚠️ D1 本来就是空 → 必须保持空（不能用旧映射表把「已删掉的封面」复活）",
    listCover("", "s", MANIFEST) === "", JSON.stringify(listCover("", "s", MANIFEST)));
  check("外链封面优先用 D1 的最新值（映射表是构建时的、可能是旧的）",
    listCover("https://cdn.example.com/new.jpg", "s", MANIFEST) === "https://cdn.example.com/new.jpg",
    listCover("https://cdn.example.com/new.jpg", "s", MANIFEST));
  check("映射表读不到（null）不炸，退回原值",
    listCover("https://cdn.example.com/a.jpg", "s", null) === "https://cdn.example.com/a.jpg");
}

// ═══════════════════════════════════════════════════════════════════════════
section("[6] 接口层的接线（这类 bug 多半死在这儿）");
{
  const postsApi = stripComments(fs.readFileSync(path.join(root, "functions", "api", "posts.js"), "utf8"));
  check("列表接口真的去读映射表并 await",
    /const covMap = await loadCoverMap\(env, request\.url\)/.test(postsApi), "未看到 loadCoverMap 调用");
  check("⚠️ 必须用 (row) => publicPost(row, covMap) 包一层：直接 map(publicPost) 会把数组下标当 covMap",
    /results\.map\(\(row\) => publicPost\(row, covMap\)\)/.test(postsApi) && !/results\.map\(publicPost\)/.test(postsApi),
    (postsApi.match(/results\.map\([^)]*\)/) || [""])[0]);
  check("publicPost 用 listCover 而不是裸 safeCover", /listCover\(row\.cover, row\.slug, covMap\)/.test(postsApi),
    (postsApi.match(/cover: [^,]+/) || [""])[0]);
  check("封面不含 data: 内联图（列表体积防线还在）",
    !/cover: safeCover\(row\.cover\)/.test(postsApi), "列表封面仍可能带 base64");

  const searchApi = stripComments(fs.readFileSync(path.join(root, "functions", "api", "posts", "search.js"), "utf8"));
  check("搜索接口与列表接口用同一套封面取值（首页有封面、搜索里没有会很怪）",
    /listCover\(row\.cover, row\.slug, covMap\)/.test(searchApi), (searchApi.match(/cover: [^,]+/) || [""])[0]);

  const coverLib = stripComments(fs.readFileSync(path.join(root, "functions", "_lib", "cover.js"), "utf8"));
  check("loadCoverMap 有模块级缓存（列表接口不该每次都读 ASSETS）",
    /coverMapCache/.test(coverLib) && /300000/.test(coverLib), "未看到缓存");
  check("loadCoverMap 读不到时返回 null 而不是抛错（接口不能因映射表缺失而 500）",
    /catch \(_\) \{ return null; \}/.test(coverLib), "未看到 try/catch 兜底");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
