// a11y / 键盘体验的**真浏览器**实测（audit §七 #15 #16 #19 #20）。
// 用法：node scripts/audit-a11y.mjs [width] [height] [slug] [local]
//   local = 测**未部署的**本地仓库版本（静态服务 + /api/* 打桩 + 其余代理回线上）；默认测线上。
// 输出：Tab 落点 / aria-current / 灯箱焦点回路 / 返回列表的滚动位置 / 滚动监听的每事件成本。
//
// 为什么必须真浏览器：这四条全都是"点了才知道"的东西 —— 焦点会不会跑出灯箱、锚点跳转有没有
// 真的移焦点、还原滚动位置有没有被后面那句 scrollTo 覆盖，静态断言一个都答不了。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
// 截图产物落在 .diag/out/（.diag 是 gitignore 的排查目录，不把图片提交进仓库）
const OUT = join(here, "..", ".diag", "out", "a11y");
mkdirSync(OUT, { recursive: true });

const LIVE = "https://blog-6p3.pages.dev";
const W = Number(process.argv[2] || 1200);
const H = Number(process.argv[3] || 900);
const LOCAL = process.argv.includes("local");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}` + (detail ? `\n     实际: ${detail}` : "")); }
};

const list = await fetch(`${LIVE}/api/posts`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.json());
const posts = list.posts || [];

// ── 本地模式：把仓库里的 index.html/app.js/style.css 端出来，/api/* 打桩，其余代理回线上 ──
let BASE = LIVE, localServer = null;
if (LOCAL) {
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
  const patched = posts.map((p) => ({ ...p, cover: /^\/generated\//.test(p.cover || "") ? LIVE + p.cover : p.cover }));
  localServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (code, body, type) => { res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" }); res.end(body); };
    if (u.pathname === "/api/posts") return send(200, JSON.stringify({ ok: true, posts: patched }));
    if (u.pathname === "/api/posts/meta") return send(200, JSON.stringify({ ok: true, count: patched.length, updated: new Date().toISOString() }));
    if (u.pathname === "/api/me") return send(401, JSON.stringify({ ok: false }));
    if (u.pathname === "/api/config") return send(200, JSON.stringify({ ok: true, turnstileSiteKey: "" }));
    if (u.pathname.startsWith("/api/")) return send(200, JSON.stringify({ ok: true }));
    const rel = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname);
    const file = join(ROOT, rel);
    if (existsSync(file) && statSync(file).isFile()) return send(200, readFileSync(file), MIME[extname(file)] || "application/octet-stream");
    try {
      const r = await fetch(LIVE + u.pathname + u.search);
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/octet-stream" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (_) { return send(404, "not found", "text/plain"); }
  });
  await new Promise((r) => localServer.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${localServer.address().port}`;
}

// 挑一篇**正文里真有带 alt 的图片**的文章 —— 没图就验不了灯箱
let slug = process.argv[4] || "";
if (!slug) {
  for (const p of posts) {
    const d = await fetch(`${LIVE}/generated/posts/${encodeURIComponent(p.slug)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const body = d && d.post ? d.post.body || "" : "";
    if (/!\[[^\]]+\]\([^)]+\)/.test(body)) { slug = p.slug; break; }
  }
}

const CDP_PORT = 9771 + Math.floor(Math.random() * 60);
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), "edge-a11y-"));
const child = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (_) {} await sleep(150); }
const ws = new WebSocket(wsUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const S = (method, params, sessionId) => { const i = ++msgId; return new Promise((res, rej) => { pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }); };
const { targetId } = await S("Target.createTarget", { url: "about:blank" });
const { sessionId } = await S("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => S(m, p, sessionId);
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
const KEYS = { Tab: 9, Escape: 27, Enter: 13, " ": 32, ArrowDown: 40 };
async function key(k, mods = 0) {
  const base = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k], modifiers: mods };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "char", text: k === " " ? " " : "", ...base }).catch(() => {});
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
// 让页面拿到"用户手势"，否则焦点行为与真实点击不同
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const active = () => ev(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id || "", cls: a.className || "", text: (a.textContent || "").trim().slice(0, 24) } : null; })()`);

console.log(`\n===== a11y 实测 ${W}×${H} ${LOCAL ? "/ 本地未部署版本" : "/ 线上"} 文章 ${slug || "(无)"} =====`);

await send("Page.navigate", { url: `${BASE}/` });
for (let i = 0; i < 160; i++) { if (await ev("!!window.__APP_READY__").catch(() => false)) break; await sleep(250); }
await sleep(600);

// ───────────────────────────── #16 skip link ─────────────────────────────
console.log("\n[1] #16 跳过导航链接");
{
  const firstFocusable = await ev(`(() => {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const list = [...document.body.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
    const f = list[0];
    return f ? { cls: f.className, text: (f.textContent || "").trim().slice(0, 20), href: f.getAttribute("href") } : null;
  })()`);
  check("文档里第一个可聚焦元素就是 skip link", !!firstFocusable && /skip-link/.test(firstFocusable.cls), JSON.stringify(firstFocusable));

  // 真按一次 Tab（而非只看 DOM 顺序）
  await ev("document.body.focus()");
  await ev("window.scrollTo({ top: 0, behavior: 'instant' })");
  await key("Tab");
  const a1 = await active();
  check("按一次 Tab 后焦点落在 skip link 上", /skip-link/.test(a1.cls), JSON.stringify(a1));
  // ⚠️ 必须等过渡结束再量：.skip-link 的"滑回视口"是 transform 过渡（.18s），
  //    按完 Tab 立刻量会拿到 top:-94 —— 那是**动画起点**，不是"它没出现"（第一版就误红在这里）。
  await sleep(320);
  const visible = await ev(`(() => {
    const el = document.querySelector('.skip-link'); const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
             inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.width > 0 && r.height > 0 };
  })()`);
  check("聚焦后 skip link 真的出现在视口内（不是藏着的装饰）", visible.inViewport, JSON.stringify(visible));

  await key("Enter");
  await sleep(200);
  const afterEnter = await active();
  check("按回车后焦点移到正文落点（#main-content）", afterEnter.id === "main-content", JSON.stringify(afterEnter));

  // 再按一次 Tab：必须从正文里继续，而不是回到顶栏
  await key("Tab");
  const a2 = await active();
  const inMain = await ev(`(() => { const a = document.activeElement; return !!(a && document.getElementById('main-content').contains(a)); })()`);
  check("跳过之后的下一个 Tab 仍在正文内（没回到被跳过的顶栏）", inMain, JSON.stringify(a2));
}

// ───────────────────────────── #16 aria-current ─────────────────────────────
console.log("\n[2] #16 aria-current 与视觉 .active 同步");
{
  const initial = await ev(`(() => {
    const on = [...document.querySelectorAll('.nav-link')].filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.dataset.view);
    const vis = [...document.querySelectorAll('.nav-link.active')].map((l) => l.dataset.view);
    return { aria: on, visual: vis };
  })()`);
  check("首屏 aria-current 覆盖的视图与 .active 完全一致（且非空）",
    initial.aria.length > 0 && JSON.stringify([...new Set(initial.aria)].sort()) === JSON.stringify([...new Set(initial.visual)].sort()),
    JSON.stringify(initial));

  const moved = await ev(`(() => {
    document.querySelector('.nav-link[data-view="archive"]').click();
    const on = [...document.querySelectorAll('.nav-link')].filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.dataset.view);
    const vis = [...document.querySelectorAll('.nav-link.active')].map((l) => l.dataset.view);
    return { aria: [...new Set(on)], visual: [...new Set(vis)], homeStill: [...document.querySelectorAll('.nav-link')].some((l) => l.dataset.view === 'home' && l.hasAttribute('aria-current')) };
  })()`);
  check("切到归档后 aria-current 跟着走（且首页的不再残留）",
    moved.aria.length === 1 && moved.aria[0] === "archive" && moved.visual.length === 1 && moved.visual[0] === "archive" && !moved.homeStill,
    JSON.stringify(moved));
  await ev(`document.querySelector('.nav-link[data-view="home"]').click()`);
  await sleep(300);
}

// ───────────────────────────── #19 滚动监听节流 ─────────────────────────────
console.log("\n[3] #19 顶栏滚动监听：一次事件风暴的真实代价");
{
  // 直接量最贵的那一步：每次事件读 window.scrollY（会强制同步布局）。
  // 判据：**同一任务内 0 次读取** —— rAF 回调只在下一帧跑，永远不会在派发的手势里同步跑；
  //   未节流的写法会是 10 次（每个事件里读一次）。
  // ⚠️ 第一版这里写的是"期望 1 次"，把 rAF 当成了"首个事件同步执行" —— 那是错的（实测 0）。
  //   所以下面同时跑一个**未节流的对照组**，证明这个量法真的能区分 0 和 10，而不是恒等于 0。
  const reads = await ev(`(async () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const original = desc.get;
    let n = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, get() { n++; return original.call(window); } });
    const before = n;
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('scroll'));
    const throttled = n - before;                       // 节流版：同一任务内应为 0
    // 对照组：临时挂一个和"改之前"一样的未节流监听
    const naive = () => { void window.scrollY; };
    window.addEventListener('scroll', naive, { passive: true });
    const before2 = n;
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('scroll'));
    const unthrottled = n - before2;                    // 未节流应为 10
    window.removeEventListener('scroll', naive);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterFrame = n;
    // ⚠️ 还原必须把**原描述符原样写回**，不能 delete window.scrollY ——
    //    scrollY 在这个浏览器里是 window 自己的访问器属性，delete 掉就没有兜底了，
    //    后面任何读 scrollY 的代码都拿到 undefined（顶栏的 scrolled/show 直接永远不生效）。
    //    第一版就是 delete，结果 [3] 最后那条状态断言和 [4][5] 全被自己搞坏。
    Object.defineProperty(window, 'scrollY', desc);
    return { throttled, unthrottled, afterFrame, restored: typeof window.scrollY === 'number' };
  })()`);
  check(`节流版：10 次同步 scroll 事件在同一任务内 0 次读 scrollY（实测 ${reads.throttled}）`,
    reads.throttled === 0, JSON.stringify(reads));
  check(`对照组证明这个量法不是恒 0：未节流写法同一任务内读了 ${reads.unthrottled} 次（期望 10）`,
    reads.unthrottled === 10, JSON.stringify(reads));
  check("排队的那一帧里确实跑了一次状态计算（节流没有把功能一起节流掉）",
    reads.afterFrame >= 1, JSON.stringify(reads));
  check("探针自己收干净了（window.scrollY 还原成数字，否则后面的断言会被自己弄坏）",
    reads.restored === true, JSON.stringify(reads));

  const netReads = await ev(`(() => {
    // 真实派发 8 次、跨 8 帧：读取次数应 ≈ 帧数（一帧一次），而不是事件数
    return new Promise((resolve) => {
      const desc = Object.getOwnPropertyDescriptor(window, 'scrollY');
      let n = 0; let frames = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get() { n++; return innerHeight; } });
      const tick = () => { frames++; if (frames < 8) requestAnimationFrame(tick); else { Object.defineProperty(window, 'scrollY', desc); resolve({ frames, reads: n }); } };
      for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(tick);
    });
  })()`);
  check(`跨 8 帧共读 ${netReads.reads} 次（上限：帧数 + 1）`,
    netReads.reads <= netReads.frames + 1, JSON.stringify(netReads));

  // 状态仍然正确（节流不能把功能节流没了）
  const state = await ev(`(async () => {
    window.scrollTo({ top: 900, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const at900 = { topbar: document.getElementById('topbar').classList.contains('scrolled'), backTop: document.getElementById('backTop').classList.contains('show') };
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { at900, at0: { topbar: document.getElementById('topbar').classList.contains('scrolled'), backTop: document.getElementById('backTop').classList.contains('show') } };
  })()`);
  check("节流后状态仍正确（900px：scrolled+show；回顶：都撤掉）",
    state.at900.topbar && state.at900.backTop && !state.at0.topbar && !state.at0.backTop, JSON.stringify(state));
}

// ───────────────────────────── #15 灯箱焦点回路 ─────────────────────────────
console.log("\n[4] #15 灯箱（role=dialog + 焦点移入 / Tab 回卷 / 关闭归位）");
{
  const sem = await ev(`(() => {
    const lb = document.getElementById('lightbox');
    return { role: lb.getAttribute('role'), modal: lb.getAttribute('aria-modal'), label: lb.getAttribute('aria-label'),
             closeLabel: document.getElementById('lightboxClose').getAttribute('aria-label') };
  })()`);
  check("灯箱是 role=dialog + aria-modal + 有可访问名",
    sem.role === "dialog" && sem.modal === "true" && !!sem.label, JSON.stringify(sem));

  // 走真实路径进入文章（点卡片），而不是直接调内部函数
  await ev(`document.querySelector('.nav-link[data-view="home"]').click()`);
  await sleep(300);
  await ev(`document.querySelector('.card').click()`);
  for (let i = 0; i < 80; i++) { if (await ev(`location.search.includes("post=") && !!document.querySelector('.post-body')`).catch(() => false)) break; await sleep(250); }
  await sleep(800);
  // 上面点的是"第一张卡片"，未必是有图那篇 —— 直接按 slug 深链一次，保证正文里有图
  await send("Page.navigate", { url: `${BASE}/?post=${encodeURIComponent(slug)}` });
  for (let i = 0; i < 160; i++) { if (await ev("!!window.__APP_READY__").catch(() => false)) break; await sleep(250); }
  for (let i = 0; i < 80; i++) { if (await ev(`document.querySelectorAll('.post-body img').length > 0`).catch(() => false)) break; await sleep(250); }
  await sleep(600);

  const imgs = await ev(`(() => {
    const all = [...document.querySelectorAll('.post-body img')];
    return { total: all.length, focusable: all.filter((i) => i.tabIndex >= 0).length,
             withAlt: all.filter((i) => (i.alt || '').trim()).length,
             sample: all[0] ? { alt: all[0].alt, tabindex: all[0].getAttribute('tabindex'), haspopup: all[0].getAttribute('aria-haspopup') } : null };
  })()`);
  check(`正文图带 alt 的都进了 Tab 顺序（${imgs.focusable}/${imgs.withAlt} 张，共 ${imgs.total} 张）`,
    imgs.withAlt > 0 && imgs.focusable === imgs.withAlt, JSON.stringify(imgs));

  // 用键盘（不是 click）打开灯箱 —— 这才是"键盘用户也能用"的完整证明
  await ev(`(() => { const i = [...document.querySelectorAll('.post-body img')].find((x) => x.tabIndex >= 0); i.scrollIntoView({ block: 'center' }); i.focus(); return document.activeElement.tagName; })()`);
  await key("Enter");
  await sleep(400);
  const opened = await ev(`(() => {
    const lb = document.getElementById('lightbox');
    const a = document.activeElement;
    return { hidden: lb.hidden, active: a.id || a.tagName, imgSrc: (document.getElementById('lightboxImg').src || '').slice(-32) };
  })()`);
  check("焦点在图上按回车能打开灯箱（键盘可达）", opened.hidden === false, JSON.stringify(opened));
  check("打开后焦点已经移进灯箱", ["lightboxClose", "lightbox"].includes(opened.active), JSON.stringify(opened));

  // Tab 回卷：连按 8 次不能跑出灯箱
  const esc = [];
  for (let i = 0; i < 8; i++) {
    await key("Tab");
    esc.push(await ev(`(() => { const a = document.activeElement; return document.getElementById('lightbox').contains(a) ? 1 : 0; })()`));
  }
  check(`连按 8 次 Tab 焦点全部留在灯箱内（逃逸 ${esc.filter((x) => x === 0).length} 次）`, esc.every((x) => x === 1), esc.join(""));
  const back = [];
  for (let i = 0; i < 3; i++) {
    await key("Tab", 8); // 8 = Shift
    back.push(await ev(`(() => { const a = document.activeElement; return document.getElementById('lightbox').contains(a) ? 1 : 0; })()`));
  }
  check(`Shift+Tab 也不逃逸（逃逸 ${back.filter((x) => x === 0).length} 次）`, back.every((x) => x === 1), back.join(""));

  // Escape 关闭 → 焦点必须回到刚才那张图
  await key("Escape");
  await sleep(300);
  const closed = await ev(`(() => { const a = document.activeElement; return { hidden: document.getElementById('lightbox').hidden, tag: a.tagName, isBodyImg: !!(a.closest && a.closest('.post-body') && a.tagName === 'IMG') }; })()`);
  check("Escape 关闭灯箱", closed.hidden === true, JSON.stringify(closed));
  check("关闭后焦点回到刚才那张正文图（不再掉到 body）", closed.isBodyImg, JSON.stringify(closed));

  // 点遮罩关闭也要归位（另一条关闭路径）
  await ev(`(() => { const i = [...document.querySelectorAll('.post-body img')].find((x) => x.tabIndex >= 0); i.focus(); i.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  await sleep(300);
  await ev(`(() => { const lb = document.getElementById('lightbox'); lb.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  await sleep(300);
  const maskClosed = await ev(`(() => { const a = document.activeElement; return { hidden: document.getElementById('lightbox').hidden, isBodyImg: !!(a.closest && a.closest('.post-body') && a.tagName === 'IMG') }; })()`);
  check("点遮罩关闭后焦点同样归位", maskClosed.hidden && maskClosed.isBodyImg, JSON.stringify(maskClosed));
}

// ───────────────────────────── #20 返回列表恢复滚动位置 ─────────────────────────────
console.log("\n[5] #20 从文章返回列表：滚动位置");
{
  await send("Page.navigate", { url: `${BASE}/` });
  for (let i = 0; i < 160; i++) { if (await ev("!!window.__APP_READY__").catch(() => false)) break; await sleep(250); }
  for (let i = 0; i < 80; i++) { if (await ev(`document.querySelectorAll('.card').length > 2`).catch(() => false)) break; await sleep(250); }
  await sleep(500);

  const before = await ev(`(async () => {
    // ⚠️ 站点在 style.css:82 给 html 设了 scroll-behavior:smooth ——
    //    裸写 window.scrollTo(0,1400) 会开始一段动画，隔两帧只走到个位数（第一版就误红在这里）。
    //    测量前的"摆位"一律用 behavior:'instant'。
    window.scrollTo({ top: 1400, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { y: Math.round(scrollY), docH: document.documentElement.scrollHeight };
  })()`);
  check(`可以在列表里滚到 1400px（文档高 ${before.docH}）`, before.y > 1000, JSON.stringify(before));

  const openedAt = await ev(`(() => { document.querySelector('.card').click(); return location.search; })()`);
  await sleep(1200);
  const inPost = await ev(`({ y: Math.round(scrollY), isPost: !!document.querySelector('.view-post.active') })`);
  check("打开文章后从顶部开始读（scrollY≈0）", inPost.isPost && inPost.y < 40, JSON.stringify({ ...inPost, search: openedAt }));

  await ev(`document.getElementById('backBtn').click()`);
  // 还原必须是**瞬时**的：等 1 帧就该到位。若这里要等几百毫秒才对，说明用了 behavior:"auto"
  // （= 听 CSS 的 smooth），用户会看到列表从顶部飞过去。
  await sleep(120);
  const backList = await ev(`({ y: Math.round(scrollY), isHome: !!document.querySelector('.view-home.active') })`);
  check(`点「← 返回」后**瞬时**回到离开列表时的位置（目标 1400，实测 ${backList.y}）`,
    backList.isHome && Math.abs(backList.y - 1400) < 60, JSON.stringify(backList));

  // 侧边栏/顶栏导航点回首页也应还原
  await ev(`document.querySelector('.nav-link[data-view="archive"]').click()`);
  await sleep(400);
  const archY = await ev(`Math.round(scrollY)`);
  await ev(`document.querySelector('.nav-link[data-view="home"]').click()`);
  await sleep(150);
  const homeY = await ev(`Math.round(scrollY)`);
  check(`切到归档再切回首页：位置被还原（归档处 ${archY} → 首页 ${homeY}，目标 1400）`,
    Math.abs(homeY - 1400) < 60, `归档 ${archY} / 首页 ${homeY}`);

  // 反向：文章视图不该被还原成"上一篇看到一半的位置"
  await ev(`document.querySelector('.nav-link[data-view="home"]').click()`);
  await sleep(150);
  await ev(`document.querySelector('.card').click()`);
  await sleep(1200);
  await ev(`window.scrollTo({ top: 2000, behavior: 'instant' })`);
  await sleep(150);
  await ev(`document.getElementById('backBtn').click()`);
  await sleep(150);
  await ev(`document.querySelector('.card').click()`);
  await sleep(1200);
  const secondPost = await ev(`Math.round(scrollY)`);
  check(`第二篇文章仍从顶部读起（不是上一篇的 2000px；实测 ${secondPost}）`, secondPost < 40, String(secondPost));
}

{
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `a11y-${W}x${H}${LOCAL ? "-local" : ""}.png`), Buffer.from(shot.data, "base64"));
}

try { await send("Page.close"); } catch (_) {}
try { ws.close(); } catch (_) {}
try { child.kill(); } catch (_) {}
try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
if (localServer) localServer.close();

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
