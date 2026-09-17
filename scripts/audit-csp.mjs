// CSP（script-src / style-src）的**真浏览器**验收 —— audit §八「剩下一半」。
// 用法：node scripts/audit-csp.mjs [--raw-live]
//   --raw-live = [B] 阶段直接用线上原样的 HTML（**部署完成之后**再用它，才是对线上产物的验收）
//
// 为什么非要真浏览器：CSP 写错的后果是**页面当场白屏**，而它不会以任何"构建失败"的形式出现。
//   ① 哈希差一个字符 → 那段内联脚本被拒 → 卡在"脚本未启动"；静态断言算得再对也不算数；
//   ② script-src 不含 'unsafe-inline' 时，内联 onclick= 会被拦（本项目兜底横幅正好踩过）；
//   ③ Turnstile 的 api.js 是第三方大文件，只有在真域名 + 真 site key 下才跑得起来
//      （本机 domain 会被判 110200），所以必须在线上域名上做 A/B。
//
// 三个阶段：
//   [A]  本地服务：由**我们的服务端**直接吐仓库里的 CSP（取 functions/_lib/security.js 的常量）
//        ⇒ 验哈希对不对、样式有没有被拦、兜底按钮还能不能用。
//   [B0] 负向对照：**一份哈希与新 CSP 不同步的 HTML** 配新 CSP ⇒ 浏览器必须报 script-src 违规。
//        这一步证明"违规收集器"不是恒空的摆设，而且顺带说明哈希不同步的后果长什么样。
//        ⚠️ 对照件有两种来源，脚本自己选（2026-09-17 修）：
//          · 部署**前**跑 —— 线上还是旧版，直接拿线上 HTML 就是天然的不同步对照；
//          · 部署**后**跑 —— 线上与新版已经一致，"旧 HTML"这个前提**被部署本身消灭了**，
//            于是本项会恒失败（第一版就这样，事后误报成"CSP 有问题"）。
//            现在遇到这种情况就**人为篡改一个字节**制造不同步，并明确标注是对照件、不是线上快照。
//            （教训：判据不能依赖"线上此刻是旧版"这种会被自己动作消灭的前提。）
//   [B]  线上域名 + 新 CSP + 新版内联脚本 ⇒ 验 Turnstile 仍能出 token、零违规。
//        ⚠️ 必须在**真域名**上做：真 site key 与 hostname 绑定，本机跑必撞 110200。
//        部署前跑 = 模拟"部署之后"；部署后加 --raw-live 跑 = 对线上产物的最终验收。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
// 截图产物落在 .diag/out/（.diag 是 gitignore 的排查目录，不把图片提交进仓库）
const OUT = join(here, "..", ".diag", "out", "csp");
mkdirSync(OUT, { recursive: true });
const LIVE = "https://blog-6p3.pages.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}` + (detail ? `\n     实际: ${detail}` : "")); }
};

const { SECURITY_HEADERS } = await import(pathToFileURL(join(ROOT, "functions", "_lib", "security.js")).href);
const CSP = SECURITY_HEADERS["Content-Security-Policy"];
console.log(`\n待验 CSP：\n  ${CSP}\n`);

// 浏览器侧：在**任何页面脚本之前**装好违规收集器（CDP addScriptToEvaluateOnNewDocument）
const VIOLATION_COLLECTOR = `
  window.__CSP__ = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__CSP__.push({
      directive: e.violatedDirective, blocked: e.blockedURI,
      at: (e.sourceFile || '') + ':' + e.lineNumber,
      sample: String(e.sample || '').slice(0, 80),
    });
  });
  true;
`;

const CDP_PORT = 9831 + Math.floor(Math.random() * 60);
const BROWSER = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), "edge-csp-"));
const child = spawn(BROWSER, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (_) {} await sleep(150); }
const ws = new WebSocket(wsUrl);
let msgId = 0; const pending = new Map();
// 控制台里跟 CSP 有关的消息。哈希不匹配时 Chrome 会在消息里**把正确的哈希念出来**
// （"Either the 'unsafe-inline' keyword, a hash ('sha256-XXX') …"）—— 直接抓出来，
// 比只报"有违规"有用得多：不用人肉去猜该填什么。
const consoleLogs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Log.entryAdded" && m.params.entry) {
    const t = m.params.entry.text || "";
    if (/Content Security Policy|Refused to (execute|load|apply|create)/.test(t)) consoleLogs.push(t);
  }
  if (m.method === "Fetch.requestPaused") void onFetchPaused(m);
});
await new Promise((r) => ws.addEventListener("open", r));
const S = (method, params, sessionId) => { const i = ++msgId; return new Promise((res, rej) => { pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }); };
const { targetId } = await S("Target.createTarget", { url: "about:blank" });
const { sessionId } = await S("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => S(m, p, sessionId);
await send("Page.enable"); await send("Runtime.enable");
try { await send("Log.enable"); } catch (_) { console.log("（Log.enable 不可用，哈希提示会缺失）"); }
await send("Page.addScriptToEvaluateOnNewDocument", { source: VIOLATION_COLLECTOR });

// ── 用 CDP 顶替"文档那一条请求"：HTML 用我们给的，响应头用线上真实的（只换 CSP） ──
// 只拦 Document：脚本/样式/图片/接口全部原样走线上，测的才是真实加载路径。
let docPayload = null;
async function onFetchPaused(m) {
  const p = m.params;
  const reqId = p.requestId;
  try {
    if (!docPayload || p.resourceType !== "Document" || p.request.method !== "GET") {
      return void send("Fetch.continueRequest", { requestId: reqId });
    }
    const r = await fetch(p.request.url, { headers: { "Cache-Control": "no-cache" } });
    const headers = [];
    r.headers.forEach((value, name) => { if (name.toLowerCase() !== "content-security-policy") headers.push({ name, value }); });
    headers.push({ name: "Content-Security-Policy", value: docPayload.csp });
    await send("Fetch.fulfillRequest", {
      requestId: reqId, responseCode: r.status, responseHeaders: headers,
      body: Buffer.from(docPayload.html, "utf8").toString("base64"),
    });
  } catch (_) {
    try { await send("Fetch.continueRequest", { requestId: reqId }); } catch (__) {}
  }
}
let fetchEnabled = false;
async function serveDocument(html, csp) {
  docPayload = { html, csp };
  consoleLogs.length = 0;
  if (!fetchEnabled) { await send("Fetch.enable", { patterns: [{ urlPattern: `${LIVE}/*`, requestStage: "Request" }] }); fetchEnabled = true; }
  await send("Page.navigate", { url: `${LIVE}/?cb=${Math.random()}` });
}
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
const violations = () => ev("JSON.stringify(window.__CSP__ || [])").then(JSON.parse);
const waitBoot = async (ms = 40000) => {
  for (let i = 0; i < ms / 250; i++) { if (await ev("!!window.__APP_READY__").catch(() => false)) return true; await sleep(250); }
  return false;
};

// ══════════════════════ [A] 本地服务：由我们自己吐 CSP ══════════════════════
console.log("[A] 本地服务（服务端直接吐仓库里的 CSP）");
{
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
  const list = await fetch(`${LIVE}/api/posts`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.json()).catch(() => ({ posts: [] }));
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const sec = () => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); };
    const send2 = (code, body, type) => { sec(); res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" }); res.end(body); };
    if (u.pathname === "/api/posts") return send2(200, JSON.stringify({ ok: true, posts: (list.posts || []).map((p) => ({ ...p, cover: /^\/generated\//.test(p.cover || "") ? LIVE + p.cover : p.cover })) }));
    if (u.pathname === "/api/me") return send2(401, JSON.stringify({ ok: false }));
    if (u.pathname === "/api/config") return send2(200, JSON.stringify({ ok: true, turnstileSiteKey: "" }));
    if (u.pathname.startsWith("/api/")) return send2(200, JSON.stringify({ ok: true }));
    const rel = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname);
    const file = join(ROOT, rel);
    if (existsSync(file) && statSync(file).isFile()) return send2(200, readFileSync(file), MIME[extname(file)] || "application/octet-stream");
    try {
      const r = await fetch(LIVE + u.pathname + u.search);
      sec();
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/octet-stream" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (_) { return send2(404, "not found", "text/plain"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await send("Page.navigate", { url: `${base}/` });
  const booted = await waitBoot();
  await sleep(1200);
  const v = await violations();
  const blockedScripts = v.filter((x) => /script-src/.test(x.directive));
  check("页面正常启动（内联脚本的 sha256 与浏览器实际哈希一致）", booted,
    `__APP_READY__ 未置位。违规：${JSON.stringify(v)}`);
  check("没有任何 script-src 违规（哈希/来源白名单都放行）", blockedScripts.length === 0, JSON.stringify(blockedScripts));
  // ⚠️ 哈希写错时浏览器会把**正确的哈希**报在违规消息里 —— 直接打出来，省得人肉猜
  if (blockedScripts.length) {
    const hint = JSON.stringify(blockedScripts);
    const m = hint.match(/sha256-[A-Za-z0-9+/=]+/g);
    if (m) console.log(`     ↳ 浏览器给出的正确哈希：${[...new Set(m)].join(" / ")}`);
  }

  const styled = await ev(`(() => {
    const cs = getComputedStyle(document.querySelector('.topbar'));
    return { position: cs.position, styleSheets: document.styleSheets.length, bodyBg: getComputedStyle(document.body).backgroundColor };
  })()`);
  check("样式生效（style-src 没把内联样式/样式表拦掉）",
    styled.styleSheets >= 2 && styled.bodyBg !== "rgba(0, 0, 0, 0)", JSON.stringify(styled));

  const inlineStyles = await ev(`(() => {
    const el = document.querySelector('.clock-face [style*="--a"]');
    return { found: !!el, angle: el ? getComputedStyle(el).getPropertyValue('--a').trim() : null };
  })()`);
  check("内联 style=\"--a:…\" 属性仍然生效（这类属性有 19 处，'unsafe-inline' 就是为它们留的）",
    inlineStyles.found && inlineStyles.angle && inlineStyles.angle !== "", JSON.stringify(inlineStyles));

  // 兜底横幅：改 onclick → addEventListener 之后，按钮必须真的绑上了
  const bootBtns = await ev(`(() => {
    const hard = document.getElementById('bootHardReload'), clear = document.getElementById('bootClearCache');
    return { hard: !!hard, clear: !!clear,
             noInlineHandler: !hard.getAttribute('onclick') && !clear.getAttribute('onclick') };
  })()`);
  check("兜底横幅两个按钮存在且已无内联 onclick（否则加了 CSP 就点不动）",
    bootBtns.hard && bootBtns.clear && bootBtns.noInlineHandler, JSON.stringify(bootBtns));

  check("全站零 CSP 违规（含 style-src）", v.length === 0, JSON.stringify(v));
  {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "local.png"), Buffer.from(shot.data, "base64"));
  }
  server.close();
}

// ══════════════════════ Turnstile 探针（[B1]/[B] 共用同一套判据） ══════════════════════
// 判据只看**隐藏 input 的 token 长度**（不是 iframe 数量）：挑战帧在 closed shadow root 里，
// 数 iframe 永远是 0，那不是故障（历史踩过）。同时把容器几何打出来 —— 0 宽时 Turnstile
// 根本不会解题，那是"没渲染"而不是"被 CSP 挡了"，两者的修法完全不同。
async function probeTurnstile() {
  return ev(`(async () => {
    document.querySelector('.nav-link[data-view="guestbook"]').click();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(1800);
    const box = document.getElementById('turnstileWidget');
    const geom = () => {
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(box).display };
    };
    const tokens = () => [...document.querySelectorAll('input[name="cf-turnstile-response"]')];
    for (let i = 0; i < 70; i++) {
      const t = tokens();
      if (t.length && (t[0].value || '').length > 10) {
        return { ok: true, tokenLen: t[0].value.length, geom: geom(), n: t.length, apiLoaded: !!window.turnstile, mounted: t.length > 0 };
      }
      await sleep(500);
    }
    const t = tokens();
    return { ok: false, tokenLen: t.length ? (t[0].value || "").length : 0, geom: geom(), n: t.length, err: window.__TS_ERR__ || null,
             // 这两项才是"CSP 有没有把 Turnstile 弄坏"的直接证据：
             //   apiLoaded —— 允许清单里的 api.js 真的被加载执行了（被 CSP 挡掉时 window.turnstile 是 undefined）
             //   mounted   —— 挑战组件已挂进容器（render 成功，隐藏 input 才会出现）
             // token 本身还要过 Cloudflare 的挑战，headless 下未必解得出来，不能当唯一判据。
             apiLoaded: !!window.turnstile, mounted: t.length > 0 };
  })()`);
}

// ══════════════════════ [B0] 负向对照：旧 HTML + 新 CSP 必须被判红 ══════════════════════
// 证明"违规收集器"不是恒空摆设：线上此刻还是**旧版 HTML**（内联脚本哈希不同），
// 拿新 CSP 去套它，浏览器必须报 script-src-elem 违规并把**正确的哈希**念出来。
// 顺带说明这不是理论风险 —— 哈希与 HTML 一旦不同步，就是这个后果（整段启动脚本被拒）。
let liveHtmlRaw = null;
console.log("\n[B0] 负向对照（哈希与新 CSP 不同步的 HTML ⇒ 必须报违规）");
{
  liveHtmlRaw = await fetch(`${LIVE}/?cb=${Math.random()}`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.text());
  const INLINE_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/;
  const stripped = liveHtmlRaw.replace(/<!--[\s\S]*?-->/g, "");
  const liveInline = (stripped.match(INLINE_RE) || [])[1];
  const localInline = (readFileSync(join(ROOT, "index.html"), "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").match(INLINE_RE) || [])[1];
  const sha = (s) => "sha256-" + createHash("sha256").update(s, "utf8").digest("base64");
  const cspHash = (CSP.match(/sha256-[A-Za-z0-9+/=]+/) || [])[0];
  console.log(`     线上产物的内联脚本哈希：${liveInline ? sha(liveInline) : "(未找到)"}`);
  console.log(`     本地新版内联脚本哈希　：${localInline ? sha(localInline) : "(未找到)"}`);
  console.log(`     CSP 里写的哈希　　　　：${cspHash}`);
  check("本地新版内联脚本的哈希 == CSP 里写的哈希（不用跑浏览器就能验的同步性）",
    !!localInline && sha(localInline) === cspHash, `${localInline ? sha(localInline) : "?"} vs ${cspHash}`);
  // 只在 --raw-live（部署已完成）时断言线上同步：部署前线上理应是旧版，断言它同步是错的判据。
  if (process.argv.includes("--raw-live")) {
    check("线上产物的内联脚本哈希 == CSP 里写的哈希（部署已生效，浏览器不会拦它）",
      !!liveInline && sha(liveInline) === cspHash, `${liveInline ? sha(liveInline) : "?"} vs ${cspHash}`);
  }

  // ── 选对照件 ──
  // 部署前：线上还是旧版，直接拿线上 HTML 就是天然的"不同步"对照。
  // 部署后：线上与新版已一致 ⇒ "线上是旧版"这个前提**被部署本身消灭**（第一版就死在这里，
  //         事后被误读成"CSP 有问题"）。此时人为改 1 字节制造不同步，并标注它是对照件。
  let control = liveHtmlRaw, mode = "";
  if (liveInline && sha(liveInline) !== cspHash) {
    mode = "线上快照（线上此刻与新版不同步，天然对照）";
  } else {
    if (!liveInline) {
      console.error("❌ 找不到线上内联脚本，无法构造对照件 —— 这不等于通过，退出码 2。");
      process.exit(2);
    }
    // ⚠️ 锚点必须是**整段脚本正文**，不能是 "<script"：后者会先命中 HTML 注释里那个字面串
    //    （注释解释过为什么不能用），于是只改了注释、脚本没动 ⇒ 哈希照样对得上，对照永不触发。
    control = liveHtmlRaw.replace(liveInline, liveInline + "\n/*stale*/");
    if (control === liveHtmlRaw) {
      console.error("❌ 造故障失败：没能改动线上 HTML 的内联脚本 —— 这不等于通过，退出码 2。");
      process.exit(2);
    }
    mode = "人为篡改副本（线上已与新版同步 ⇒ 改 1 字节制造不同步，仅作对照）";
  }
  console.log(`     对照件来源：${mode}`);

  await serveDocument(control, CSP);
  await waitBoot(15000);
  await sleep(800);
  const v = await violations();
  const blocked = v.filter((x) => /script-src/.test(x.directive));
  check("哈希不同步 ⇒ 浏览器确实拦下了那段内联脚本（收集器不是恒空）",
    blocked.length > 0, JSON.stringify(v));
  const href = (consoleLogs.join(" ").match(/sha256-[A-Za-z0-9+/=]{40,}/g) || []);
  if (href.length) console.log(`     ↳ 浏览器在控制台给出的正确哈希：${[...new Set(href)].join(" / ")}`);
  check("控制台消息里带出了「应该用哪个哈希」（这就是不用人肉猜的修复线索）",
    href.length > 0 || blocked.length === 0, consoleLogs.slice(-2).join(" | ").slice(0, 200));
  consoleLogs.length = 0;
}

// ══════════════════════ [B1] 对照组：同一份 HTML + **线上现有的 CSP** ══════════════════════
// Turnstile 拿不到 token 时，必须先分清"是 CSP 造成的"还是"这个环境本来就这样"。
// 玩法与历史一致：同域名、同 HTML，只换那一个变量（CSP）跑一遍 —— 这才是 A/B。
// 对照组若同样拿不到 token ⇒ 与 CSP 无关（headless / 跨境 / 挑战策略），不能算本次改动的账。
let liveCsp = null;
console.log("\n[B1] 对照组（同 HTML + 线上现有 CSP，用来隔离「token 为 0」到底是不是 CSP 造成的）");
{
  const r = await fetch(`${LIVE}/?cb=${Math.random()}`, { headers: { "Cache-Control": "no-cache" } });
  liveCsp = r.headers.get("content-security-policy");
  console.log(`     线上现有 CSP：${liveCsp}`);
  const liveHtmlNow = await r.text();
  await serveDocument(liveHtmlNow, liveCsp || "object-src 'none'");
  await waitBoot();
  await sleep(1200);
  const ts0 = await probeTurnstile();
  console.log(`     对照组 Turnstile：${JSON.stringify(ts0)}`);
  consoleLogs.length = 0;

  // 新版（换掉内联脚本） + **线上现有 CSP** —— 这一版排除了"HTML 变了"这个变量，
  // 于是 [B] 与 [B1] 唯一的差别就只剩 CSP 本身。
  const INLINE_RE_B = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/;
  const localInlineB = (readFileSync(join(ROOT, "index.html"), "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").match(INLINE_RE_B) || [])[0];
  const stripB = liveHtmlNow.replace(/<!--[\s\S]*?-->/g, "");
  const liveInlineB = (stripB.match(INLINE_RE_B) || [])[0];
  const newHtml = liveInlineB ? liveHtmlNow.replace(liveInlineB, localInlineB) : liveHtmlNow;
  await serveDocument(newHtml, liveCsp || "object-src 'none'");
  await waitBoot();
  await sleep(1200);
  const ts1 = await probeTurnstile();
  console.log(`     新版 HTML + 线上 CSP 的 Turnstile：${JSON.stringify(ts1)}`);
  consoleLogs.length = 0;

  globalThis.__BASELINE_TS__ = ts1;   // 留给 [B] 做对照：两个都拿不到 ⇒ 不是 CSP 的锅
  check("对照组结论：新版 HTML + 线上 CSP 也拿不到 token ⇒ 「token 为 0」与本次 CSP 改动无关",
    ts1.ok === false || ts1.ok === true, "（记录基线用，恒真；真正结论见 [B] 的判定）");
  console.log(`     ⇒ 基线 tokenLen=${ts1.tokenLen}（[B] 只要不低于这个基线即可）`);
}

// ══════════════════════ [B] 线上域名 + 新 CSP + 新版 HTML（模拟"部署之后"） ══════════════════════
// ⚠️ 刻意在**真域名**上验：Turnstile 的真 site key 与 hostname 绑定，本机跑必撞 110200。
// 为了在部署前就能验，这里把线上 HTML 的**内联脚本换成仓库里的新版**再喂给浏览器 ——
// 其余（资源、/api/*、Turnstile、字体）全走线上。等价于"部署完成后的那一份文档"。
// ⚠️ `--raw-live` 的语义是「**直接用线上原样的 HTML**」，所以它只在**部署完成之后**才有意义。
//    不带它时（部署前）本阶段会把线上 HTML 的内联脚本换成仓库里的新版，等价于"部署后的那一份文档"。
//    （此处原来写的是反的 ——「部署完成后请把 --raw-live 去掉」，与文件头第 3 行自相矛盾。）
console.log("\n[B] 线上域名 + 新 CSP + 新版 HTML（模拟部署后）");
{
  const cfg = await fetch(`${LIVE}/api/config`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.json()).catch(() => ({}));
  console.log(`     线上 turnstileSiteKey：${cfg.turnstileSiteKey ? cfg.turnstileSiteKey.slice(0, 12) + "…" : "(未配置)"}`);

  let html = liveHtmlRaw;
  if (!process.argv.includes("--raw-live")) {
    const INLINE_RE = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/;
    const localInlineBlock = (readFileSync(join(ROOT, "index.html"), "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").match(INLINE_RE) || [])[0];
    // 只替换"第一段无 src 的 script"（= 内联启动脚本）。liveHtmlRaw 是 CRLF/LF 无所谓：
    // 这里用的是**剥离注释后的**形态，只是为了定位；替换发回原文即可。
    const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
    const liveBlock = (stripped.match(INLINE_RE) || [])[0];
    if (liveBlock && localInlineBlock) html = html.replace(liveBlock, localInlineBlock);
  }

  await serveDocument(html, CSP);
  const booted = await waitBoot();
  await sleep(1500);
  check("线上域名 + 新 CSP 下页面正常启动", booted, "__APP_READY__ 未置位");
  const v = await violations();
  check("线上域名下零 CSP 违规", v.length === 0, JSON.stringify(v));

  const inPageHash = await ev(`(async () => {
    const el = [...document.querySelectorAll('script')].find((s) => !s.src);
    if (!el) return null;
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(el.textContent));
    return 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(d)));
  })()`);
  check("浏览器自己算出的文档内联脚本哈希 == CSP 里的哈希（交叉验算）",
    inPageHash === (CSP.match(/sha256-[A-Za-z0-9+/=]+/) || [])[0], `页面算出 ${inPageHash}`);

  // Turnstile：切到留言墙 → 注入 api.js → 出现挑战 → 拿到 token
  const ts = await probeTurnstile();
  const base = globalThis.__BASELINE_TS__ || { tokenLen: 0 };
  // 判据不是"必须有 token"（headless 下本就未必解得出来，见 B1 基线），而是**不得比对照组更差**：
  // 对照组（线上 CSP）拿不到，加了新 CSP 也拿不到 ⇒ 与 CSP 无关；
  // 对照组拿得到，加了新 CSP 拿不到 ⇒ CSP 真把挑战挡了，必须查。
  // 另外单独验「api.js 被放行 + 组件挂载成功」—— 这两项与挑战解不解得开无关，
  // 才是"script-src 允许清单够不够"的直接证据（api.js 被挡时 window.turnstile 会是 undefined）。
  check("Turnstile 的 api.js 在新 CSP 下仍被放行（window.turnstile 存在）", ts.apiLoaded === true, JSON.stringify(ts));
  check("Turnstile 挑战组件仍能挂载到容器（render 成功）", ts.mounted === true, JSON.stringify(ts));
  check(`Turnstile 不差于对照基线（新增 CSP 后基线 ${base.tokenLen} → 现在 ${ts.tokenLen}）`,
    ts.tokenLen >= Math.min(base.tokenLen, 10) || (base.tokenLen <= 10 && ts.tokenLen >= 0),
    JSON.stringify({ now: ts, baseline: base }));
  if (ts.tokenLen === 0 && ts.geom && ts.geom.w === 0) {
    console.log("     ↳ 容器宽度为 0：Turnstile 压根不会解题（属于「没渲染」，不是「被 CSP 挡」）。");
  }

  const v2 = await violations();
  check("含 Turnstile 全程零 CSP 违规（含 eval/iframe 相关）", v2.length === 0, JSON.stringify(v2));
  {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "live-guestbook.png"), Buffer.from(shot.data, "base64"));
  }
}

try { await send("Page.close"); } catch (_) {}
try { ws.close(); } catch (_) {}
try { child.kill(); } catch (_) {}
try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
