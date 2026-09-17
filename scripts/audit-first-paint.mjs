// 真浏览器实测「首绘被阻塞样式表拖了多久」—— docs/optimization-audit-2026-09-16.md §三 的判据。
//
// 为什么要这个探针：§三 报的是「首页 TTFB→首绘增量 658ms，而 /404.html（纯内联）只要 55ms」，
// 那是**线上单点观测**，不是可控实验 —— 网络抖动、TTFB 波动都会混进来，而且改完无法在部署前预判。
//
// 本探针把三个变量钉死，只让「样式表是外链还是内联」变：
//   ① 同一份 assets/style.css（内联模式由真跑 build.mjs 产生，不是手写副本）
//   ② 同一台机器、同一个浏览器、同一个全新 profile
//   ③ 同一套网络条件（CDP emulateNetworkConditions 模拟跨境链路）
//
// 判据（⚠️ 别只看 FCP 绝对值 —— TTFB 波动大，用「HTML 到齐 → 首绘」的增量）：
//   · 增量：内联模式必须显著低于外链模式（目标：接近 /404.html 那种量级）
//   · **CLS 不得变差**（样式注入晚了会体现为布局跳变）—— 这是本项目回滚过 media=print 之后
//     必须自证的第一件事
//   · **几何指纹必须一致**（关键元素的位置/尺寸/计算样式逐项相等）—— 证明「渲染结果没变」，
//     而不只是「看起来差不多」
//   · 外链模式应当真的发出 style.css 请求；内联模式必须 0 次（否则说明内联没生效，
//     测出来的差异就是假的）
//
// 用法：
//   node scripts/audit-first-paint.mjs --link                 # 仓库原样（外部阻塞样式表）
//   node scripts/audit-first-paint.mjs --inline               # 真跑 build.mjs 后的产物（样式表内联）
//   node scripts/audit-first-paint.mjs --both                 # 两个都跑并给对照表
//   node scripts/audit-first-paint.mjs --both --mobile        # 窄视口（窄屏分支规则更多）
//   node scripts/audit-first-paint.mjs --both --rtt=150 --kbps=200
//   node scripts/audit-first-paint.mjs --link --raw           # 不限速（看本机真实渲染差异）
//   node scripts/audit-first-paint.mjs --live                 # 线上 A/B：真域名，新形态 vs 顶替回旧形态，ABBA 四轮
//   node scripts/audit-first-paint.mjs --live --oldform       # 只跑一轮旧形态（调试「拦截到底生效没有」）
//   node scripts/audit-first-paint.mjs --live --mobile        # 线上移动视口
//
// ⚠️ 本机不限速时 style.css 几乎瞬时到齐，两种模式测不出差别 —— 那不代表没收益，
//    只代表本机到本机的带宽不是瓶颈。要评估收益**必须**带节流。
// ⚠️ --live 默认**不叠加**限速（跨境链路本身就是被测对象），理由见下面 RAW 的定义处。
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const LIVE_URL = "https://blog-6p3.pages.dev"; // 线上 A/B 用；⚠️ 别换成别的域名（资源与域名绑定）
const args = process.argv.slice(2);
const argVal = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };

const WANT_LINK = args.includes("--link") || args.includes("--both");
const WANT_INLINE = args.includes("--inline") || args.includes("--both");
// 线上对照（--live）：直接打真域名，用 CDP Fetch 拦截把**旧形态**（外链样式表）顶回去当对照组。
// 为什么不「改代码再部署一次」：真实链路条件（跨境延迟、当天网络、边缘节点）不可复现，
// 换域名更不行（Turnstile/资源与域名绑定）。同域名、同一次会话、冷缓存各跑一遍，才是干净的 A/B。
// 顺序取 ABBA（新·旧·旧·新）：单调漂移（网络越来越差/越来越好）在两组里被等量抵消，
// ABAB 则会把漂移误算成改动收益 —— 这正是「负向验证」里最容易被自己骗到的地方。
const WANT_LIVE = args.includes("--live");
const OLDFORM = args.includes("--oldform");
if (!WANT_LINK && !WANT_INLINE && !WANT_LIVE) { console.error("要 --link / --inline / --both / --live 之一"); process.exit(1); }

const MOBILE = args.includes("--mobile");
const NEG = args.includes("--neg");
// 本机默认限速刻意贴近「本机 → Cloudflare 中国节点」的实测手感：
// 线上 style.css 32.6KB 实测总耗时 534ms，其中含一次 RTT ⇒ RTT 约 150ms 量级、可用带宽约 200KB/s。
// ⚠️ 但 --live 默认**不再叠加限速**：跨境链路本身就是被测对象，再叠 RTT=150ms 会把
//    style.css 那一个往返的成本翻倍（150 → 300ms），凭空夸大收益。
//    想强行做可控对照仍可显式传 --rtt= / --kbps=。
const RTT_SET = args.some((a) => a.startsWith("--rtt="));
const KBPS_SET = args.some((a) => a.startsWith("--kbps="));
const RAW = args.includes("--raw") || (WANT_LIVE && !RTT_SET && !KBPS_SET);
const RTT = argVal("rtt", 150);
const KBPS = argVal("kbps", 200);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 线上 A/B 用的跨调用状态 ──
// ⚠️ 必须**在这里**用 let 声明，不能拖到 ws 回调之后：CDP 的事件（attachedToTarget /
//    executionContextCreated …）可能早于 Target.attachToTarget 的返回就到，回调一进到
//    未初始化的 let 就是 ReferenceError，整个 message 回调当场炸掉 ——
//    表现是「脚本静默不工作」（请求一条都不记、CLS 恒为 0），正是本项目最忌讳的静默终态。
let liveOldFormHtml = null; // 旧形态 HTML（仅 --oldform / ABBA 的 old 轮）
let fetchSession = null;    // 带 Fetch 域的 CDP session —— fulfillRequest 必须显式带上
let liveServedHtml = null;  // 线上新形态的真实 HTML（断言「线上确实内联了」用）

// ⚠️ 本地静态服务必须**压缩**，否则实验结论是假的：线上 Cloudflare 是 br 传输
// （index.html 42KB → 15KB、style.css 112KB → 32.6KB、posts.json 466KB → 远小于此），
// 不压缩会让「外链模式」多传 80KB style.css，把对照组凭空夸大近 400ms。
// 档位取 4：实测线上首页 HTML br=14972 B，本机 q4 压同一份得 14967 B —— 基本就是 CF 的档位。
const CF_BROTLI_Q = 4;
function sendBody(req, res, buf, type) {
  const compressible = /^(text\/|application\/(json|javascript|xml))/.test(type);
  const ae = String(req.headers["accept-encoding"] || "");
  if (compressible && buf.length > 512 && /\bbr\b/.test(ae)) {
    const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: CF_BROTLI_Q } });
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-encoding": "br" });
    return res.end(br);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  return res.end(buf);
}

// ── 内联模式：在临时目录里真跑一遍仓库的 build.mjs（与 verify-asset-versioning.mjs 同法）──
function makeBuiltDir() {
  const tmp = mkdtempSync(join(tmpdir(), "blog-fp-build-"));
  cpSync(join(ROOT, "build.mjs"), join(tmp, "build.mjs"));
  cpSync(join(ROOT, "index.html"), join(tmp, "index.html"));
  cpSync(join(ROOT, "assets"), join(tmp, "assets"), { recursive: true, filter: (s) => !s.includes("uploads") });
  if (existsSync(join(ROOT, "scripts", "lib"))) cpSync(join(ROOT, "scripts", "lib"), join(tmp, "scripts", "lib"), { recursive: true });
  if (existsSync(join(ROOT, "generated"))) cpSync(join(ROOT, "generated"), join(tmp, "generated"), { recursive: true });
  // --neg：在**临时副本**里把内联那一步拆掉（磁盘不动）。
  // 目的：证明「内联更快的」结论不是假的 —— 若拆掉内联后收益消失、且「已无外链」断言变红，
  // 说明第一次跑的收益确实来自内联，而不是「第二次跑浏览器更快」这类顺序假象。
  if (NEG) {
    const bp = join(tmp, "build.mjs");
    const src = readFileSync(bp, "utf8");
    const patched = src.replace("const inlined = inlineStyleSheet(html, cssText);", "const inlined = { html, replaced: 'none' };");
    if (patched === src) {
      console.error("❌ 造故障失败：没找到内联那一行，临时 build.mjs 未改动 —— 这不等于通过，退出码 2。");
      process.exit(2);
    }
    writeFileSync(bp, patched);
    console.log("⚠️ 已注入故障（仅临时副本）：build.mjs 跳过样式表内联\n");
  }
  const env = { ...process.env };
  delete env.CF_ACCOUNT_ID; delete env.CF_DATABASE_ID; delete env.CF_API_TOKEN;
  const out = spawn(process.execPath, ["build.mjs"], { cwd: tmp, env, stdio: "pipe" });
  let log = "";
  out.stdout.on("data", (d) => { log += d; });
  out.stderr.on("data", (d) => { log += d; });
  return new Promise((res) => out.on("close", () => res({ tmp, log })));
}

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));
if (!EDGE) { console.error("找不到 Edge/Chrome"); process.exit(1); }

// 在页面任何脚本之前装好观察器：CLS / LCP 都必须从第 0 帧开始看，晚了就漏。
const OBSERVER = `(function(){
  window.__cls = [];
  // 滚动快照：每 100ms 记一次全页布局。位移发生时拿它和当前状态求差 ——
  // Attribution 只告诉你「谁动了」，不告诉你「谁缩了」（真正的元凶常常是上面某个元素）。
  window.__prev = null;
  window.__snapAll = function(){
    var out = [], all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      out.push(i + ':' + el.tagName + '.' + String(el.className || '').split(' ')[0] + '@' + (el.offsetTop || 0) + 'h' + (el.offsetHeight || 0));
    }
    return out;
  };
  setInterval(function(){ window.__prev = window.__snapAll(); }, 100);
  try {
    new PerformanceObserver(function(l){
      l.getEntries().forEach(function(e){
        if (e.hadRecentInput) return;
        var now = window.__snapAll(), prev = window.__prev || [], d = [];
        for (var i = 0; i < Math.max(now.length, prev.length); i++) {
          if (!now[i] || !prev[i] || now[i] === prev[i]) continue;
          if (now[i].split('@')[0] !== prev[i].split('@')[0]) continue;
          d.push(prev[i].split('@')[0] + ': ' + prev[i].split('@')[1] + ' → ' + now[i].split('@')[1]);
        }
        window.__cls.push({ v: e.value, t: e.startTime,
          ready: !!window.__APP_READY__,
          cards: document.querySelectorAll('.card').length,
          // 位移前 100ms 内「谁的位置/高度变了」（这才是元凶链）
          whoChanged: d.slice(0, 6),
          s: (e.sources||[]).map(function(s){
            var n = s.node, pr = s.previousRect, cr = s.currentRect;
            var name = n ? (n.nodeName + (n.className ? '.' + String(n.className).split(' ')[0] : '')) : 'rect';
            var box = function(r){ return r ? (Math.round(r.x)+','+Math.round(r.y)+' '+Math.round(r.width)+'x'+Math.round(r.height)) : '?'; };
            return name + ' ' + box(pr) + ' → ' + box(cr);
          }) });
      });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  window.__lcp = null;
  try {
    new PerformanceObserver(function(l){
      var es = l.getEntries(); var e = es[es.length-1];
      window.__lcp = { t: e.startTime, tag: e.element ? e.element.tagName : '?',
        cls: e.element ? String(e.element.className||'').split(' ')[0] : '', url: (e.url||'').slice(-40), size: e.size };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  // 外链样式表**是否曾经阻塞过**首绘：用一份永远不回应的 style.css 去探会太侵入，
  // 改为记录「样式表开始/结束」时刻，由 node 侧和 FCP 比先后。
})();`;

// 页面快照：时序 + CLS + 几何指纹（几何指纹是「渲染结果未变」的硬证据）
const SNAP = `(function(){
  var nav = performance.getEntriesByType('navigation')[0] || {};
  var paint = performance.getEntriesByType('paint') || [];
  var fcp = null;
  paint.forEach(function(p){ if (p.name === 'first-contentful-paint') fcp = p.startTime; });
  var cls = (window.__cls||[]).reduce(function(a,b){ return a + b.v; }, 0);
  var sheets = [];
  Array.prototype.forEach.call(document.styleSheets, function(s){
    if (s.href) sheets.push(s.href.replace(location.origin,''));
  });
  var geo = {};
  function g(sel, key){
    var el = document.querySelector(sel);
    if (!el) { geo[key] = null; return; }
    var b = el.getBoundingClientRect();
    geo[key] = [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  }
  g('.layout','layout'); g('.topbar','topbar'); g('.content','content');
  g('.card-grid','cardGrid'); g('.card','card1'); g('.avatar','avatar'); g('.hero-avatar','heroAvatar');
  g('.rightbar','rightbar'); g('.leftbar','leftbar'); g('.brand','brand');
  var card = document.querySelector('.card');
  var ccs = card ? getComputedStyle(card) : null;
  var bcs = getComputedStyle(document.body);
  // 样式表规则数：用**模式间相等**当不变量，而不是拍一个魔数门槛
  // （内联后同一份 CSS 应解析出同样多的规则；跨域字体表读不到 cssRules，两侧都算 0）
  var totalRules = 0;
  Array.prototype.forEach.call(document.styleSheets, function(s){
    try { totalRules += s.cssRules ? s.cssRules.length : 0; } catch (e) {}
  });
  // 全页**布局**几何指纹：把每个元素的 [tag.class, 布局位置, 布局尺寸] 拼起来做 djb2 哈希。
  // ⚠️ 用 offsetLeft/Top/Width/Height 而不是 getBoundingClientRect：
  //    后者包含 CSS transform，于是「模拟时钟的秒针转动」「卡片入场动画的位移」
  //    「轮播的位移」都会让哈希每次都不一样 —— 实测两次跑出来的指纹就不同，
  //    那是动画相位差，不是渲染差异。offset* 不受 transform 影响，只反映布局盒。
  //    布局只要有 1px 挪动、或某个元素少画了，指纹仍会变，这正是我们要盯的。
  var parts = [], all = document.querySelectorAll('*');
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    // 承载样式表的那个元素按构造就不同（外链是 <link>、内联是 <style>），它不参与渲染布局，
    // 归一成同一个名字，免得制造一条永远为真的假差异。
    var tag = (el.tagName === 'LINK' || el.tagName === 'STYLE') ? 'STYLESHEET-SLOT' : el.tagName;
    parts.push(tag + '.' + String(el.className || '').split(' ')[0] + ':' +
      (el.offsetLeft || 0) + ',' + (el.offsetTop || 0) + ',' + (el.offsetWidth || 0) + ',' + (el.offsetHeight || 0));
  }
  var joined = parts.join('|'), layoutHash = 5381;
  for (var j = 0; j < joined.length; j++) layoutHash = ((layoutHash * 33) ^ joined.charCodeAt(j)) >>> 0;

  return {
    ttfb: nav.responseStart, respEnd: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
    fcp: fcp, lcp: window.__lcp, cls: +cls.toFixed(6),
    clsShifts: (window.__cls||[]).filter(function(x){ return x.v > 0.0005; }).slice(0,4),
    sheets: sheets,
    totalRules: totalRules,
    layoutHash: layoutHash,
    layoutParts: parts,
    elementCount: all.length,
    externalSheetCount: sheets.length,
    cardCount: document.querySelectorAll('.card').length,
    geo: geo,
    style: { bodyBg: bcs.backgroundColor, bodyFont: bcs.fontFamily,
             cardBg: ccs ? ccs.backgroundColor : null, cardRadius: ccs ? ccs.borderRadius : null,
             cardBorder: ccs ? ccs.borderColor : null },
    docH: document.documentElement.scrollHeight
  };
})();`;

async function runMode(mode) {
  const LIVE_MODE = mode === "live" || mode === "live-old";
  const built = mode === "inline" ? await makeBuiltDir() : null;
  const SERVE_ROOT = built ? built.tmp : ROOT;

  // 线上模式：先取回真的线上 HTML。带随机 ?cb= 改掉边缘缓存键，确保拿到的是当次产物
  // （本项目判据：不带 cb 的 200 不算数 —— 那可能是边缘 stale）。
  liveOldFormHtml = null;
  liveServedHtml = null;
  if (LIVE_MODE) {
    // ⚠️ undici 的 fetch 会**忽略** { cache: "no-store" }，必须自己发 Cache-Control；
    //    ?cb= 与 Cache-Control 两件事都要做才拿得到回源结果。
    const live = await (await fetch(`${LIVE_URL}/?cb=${Math.random()}`, {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    })).text();
    if (mode === "live") {
      liveServedHtml = live;
      if (!/<style[^>]*data-inlined=/.test(live)) {
        console.error("❌ 线上 HTML 里没有内联样式块 —— 要么还没部署完，要么拿到的仍是旧产物。");
        console.error("   不能把「还没生效」当成「比过了」，退出码 2。");
        process.exit(2);
      }
    } else {
      // 旧形态 = 改动前的产物构造：内联块换回 `?v=<sha256[:10]>` 的外链（正是 hashAssets 当年写的那一行）
      const { createHash } = await import("node:crypto");
      const cssVer = createHash("sha256").update(readFileSync(join(ROOT, "assets", "style.css"))).digest("hex").slice(0, 10);
      const swapped = live.replace(
        /[ \t]*<style data-inlined="style\.css">\n[\s\S]*?\n<\/style>[ \t]*\r?\n?/,
        () => `<link rel="stylesheet" href="assets/style.css?v=${cssVer}" />\n`,
      );
      if (swapped === live) {
        console.error("❌ 构造旧形态失败：线上 HTML 里没找到内联块。不能把「没换成」当成「比过了」，退出码 2。");
        process.exit(2);
      }
      liveOldFormHtml = swapped;
      console.log(`⚠️ A/B：把**旧形态**（外链 assets/style.css?v=${cssVer}）顶回去 —— 域名不变、只换样式表投递方式\n`);
    }
  }

  let server = null, ORIGIN = LIVE_URL;
  if (!LIVE_MODE) {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split("?")[0]);
      if (url.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return res.end(JSON.stringify({ ok: true, posts: [], notes: [], total: 0, count: 0, user: null, hasMore: false, nextCursor: null }));
      }
      const f = join(SERVE_ROOT, url === "/" ? "index.html" : url.replace(/^\//, ""));
      if (!f.startsWith(SERVE_ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end("nf"); }
      sendBody(req, res, readFileSync(f), MIME[extname(f)] || "application/octet-stream");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    ORIGIN = `http://127.0.0.1:${server.address().port}`;
  }

  const profile = mkdtempSync(join(tmpdir(), "edge-fp-"));
  const port = 9900 + Math.floor(Math.random() * 90);
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 140; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (_) {}
    await sleep(150);
  }

  let net = new Map();
  const errors = [];
  let fulfilled = 0; // 顶替了几次主文档 —— 断言「拦截真的生效」，避免静默不工作
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    // 线上旧形态 A/B：只顶替**主文档**，其它请求原样放行（样式表仍从线上真取）。
    // ⚠️ 拦截范围必须钉死成 resourceType=Document：若用 urlPattern="*" 全拦，
    //    旧形态那一轮会给**每个**请求都加一次 CDP 往返，凭空把它拖慢 —— 那就是
    //    「测试台自己制造收益」。这也是为什么这里能只顶替文档、却不影响 css 的真实耗时。
    if (m.method === "Fetch.requestPaused") {
      const p = m.params;
      if (liveOldFormHtml && p.resourceType === "Document") {
        fulfilled++;
        // ⚠️ 顶替的响应只能发**明文**。试过带 Content-Encoding: br + br 压过的 body，
        //    Chrome 不认（实测页面只剩 14 个元素、0 张样式表 —— 等于把页面搞坏了）。
        //    后果：live-old 那轮的「主文档传输字节」是未压缩值（~43KB），**不能**和线上的
        //    br 值（~15KB）并列比。字节对照改用下面 AB 段里「按 br q4 折算」的口径，
        //    那里用的是真数字（新形态的 br 由本地复算、旧形态的 style.css 用线上真实 br 字节）。
        S("Fetch.fulfillRequest", {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Cache-Control", value: "no-store" },
          ],
          body: Buffer.from(liveOldFormHtml, "utf8").toString("base64"),
        }, fetchSession).catch((e) => errors.push("fulfill 失败: " + e.message));
      } else {
        S("Fetch.continueRequest", { requestId: p.requestId }, fetchSession).catch(() => {});
      }
      return;
    }
    if (m.method === "Network.requestWillBeSent") {
      const p = m.params.request;
      // 重定向会复用 requestId，按 url 归并才数得准
      const prev = net.get(m.params.requestId);
      net.set(m.params.requestId, { url: p.url, urls: prev ? [...prev.urls, p.url] : [p.url], t: m.params.timestamp, bytes: 0, status: null });
    }
    if (m.method === "Network.responseReceived") { const r = net.get(m.params.requestId); if (r) r.status = m.params.response.status; }
    if (m.method === "Network.loadingFinished") { const r = net.get(m.params.requestId); if (r) r.bytes = m.params.encodedDataLength; }
    // 本项目约定：每个探针都要顺手看一眼控制台 —— P0 事故（TDZ 被 catch 吞掉）就是
    // 「功能全错、控制台安静」，不看这一眼会把静默失败当成正常。
    if (m.method === "Runtime.exceptionThrown") {
      errors.push("未捕获: " + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 220));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("console.error: " + (m.params.args || []).map((a) => a.value || a.description).join(" ").slice(0, 220));
    }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const S = (method, params, sessionId) => { const i = ++msgId;
    return new Promise((res, rej) => { pending.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result));
      ws.send(JSON.stringify({ id: i, method, params, sessionId })); }); };

  let send = null, curSession = null;
  const { targetId } = await S("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await S("Target.attachToTarget", { targetId, flatten: true });
  curSession = sessionId;
  fetchSession = sessionId; // 供 ws 回调里的 Fetch.fulfillRequest 用
  send = (m, p) => S(m, p, sessionId);
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  // 只在「旧形态」轮开 Fetch 拦截，且只拦主文档（理由见 ws 回调里的注释）
  if (mode === "live-old") {
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  }
  await send("Emulation.setDeviceMetricsOverride", MOBILE
    ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (!RAW) {
    await send("Network.emulateNetworkConditions", {
      offline: false, latency: RTT,
      downloadThroughput: Math.round(KBPS * 1024), uploadThroughput: Math.round(KBPS * 1024 / 4),
    });
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
  // 屏蔽 webfont（跨站、首绘后才由 app.js 注入）：它到没到、什么时候到，会让文本宽度
  // 差 1px（实测 .slide-title 414 vs 415），那是**字体替换时序**的噪声，不是样式表投递方式的差异。
  // 本改动只动 assets/style.css 的投递，字体表不在范围内 —— 屏蔽掉才比得干净。
  await send("Network.setBlockedURLs", { urls: ["*fonts.font.im*", "*fonts.gstatic.com*"] });

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __throw: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200) };
    return r.result?.value;
  };

  net = new Map();
  await send("Network.clearBrowserCache");
  // ⚠️ 两侧都带 ?cb=：确保两次都拿到**回源**的当次 HTML。若一轮边缘 MISS、另一轮 HIT，
  //    差异会混进 TTFB（虽然我们用增量口径抵消了一部分，但没必要留这个口子）。
  const navUrl = ORIGIN + "/?cb=" + Math.random().toString(36).slice(2);
  await send("Page.navigate", { url: navUrl });
  // 等 load
  for (let i = 0; i < 200; i++) {
    const st = await ev("document.readyState");
    if (st === "complete") break;
    await sleep(100);
  }
  // ⚠️ 必须等**两侧到达同一内容状态**再比：/generated/posts.json 是 466KB（含 base64 封面），
  //    节流下到达时机不稳 —— 实测踩过「外链模式渲染 0 张卡片、内联 8 张」，
  //    那不是改动的影响，是测试台不等价（内容不同 ⇒ 几何指纹当然不同）。
  let cardsAt = null;
  const waitStart = Date.now();
  for (let i = 0; i < 80; i++) {
    const n = await ev("document.querySelectorAll('.card').length");
    if (typeof n === "number" && n > 0) { cardsAt = Date.now() - waitStart; break; }
    await sleep(100);
  }
  // 再留 2s：让首绘后注入的字体表走完、卡片入场动画结束，CLS 才是完整的
  await sleep(2000);
  const snap = await ev(SNAP);

  const reqs = [...net.values()];
  const mainDoc = reqs.find((r) => r.url === ORIGIN + "/" || r.url.startsWith(ORIGIN + "/?")) || null;
  const cssReqs = reqs.filter((r) => r.url.includes("assets/style.css"));
  const fontReqs = reqs.filter((r) => /fonts\.font\.im/.test(r.url));
  // ⚠️ 必须在清理临时目录**之前**读：内联模式的服务根是临时构建产物，晚了就 ENOENT。
  //    线上模式没有临时目录，servedHtml 取自真取回来/顶替回去的那份 HTML。
  const servedHtml = LIVE_MODE
    ? (mode === "live-old" ? liveOldFormHtml : liveServedHtml)
    : readFileSync(join(SERVE_ROOT, "index.html"), "utf8");

  child.kill();
  if (server) server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  if (built) { try { rmSync(built.tmp, { recursive: true, force: true }); } catch (_) {} }

  return {
    mode, snap, mainDocs: mainDoc || null, css: cssReqs, fonts: fontReqs,
    builtLog: built ? built.log : null,
    reqCount: reqs.length,
    cardsAt,
    errors,
    fulfilled,
    dataReqs: reqs.filter((r) => /\/generated\/|\/api\//.test(r.url)),
    origin: ORIGIN,
    // 直接看**被服务的那份 HTML**：内联是否真的写进去了、还有没有残留外链
    servedHtml,
  };
}

const fmt = (v) => (v === null || v === undefined ? "—" : Math.round(v) + "ms");// 判据口径与审计 §三 保持一致：**TTFB → 首绘**的增量（把上游/网络抖动剔除）。
// ⚠️ 不能用 responseEnd 当基线：响应是**流式**的，首绘可以早于 body 收完，
//    那样算出来的增量会是负数（实测 -72ms），看着像「负延迟」这种不可能的东西。
function increment(r) {
  if (!r.snap || r.snap.fcp == null || !r.snap.ttfb) return null;
  return r.snap.fcp - r.snap.ttfb;
}

const LABEL = { link: "外链阻塞", inline: "内联", live: "线上·新形态", "live-old": "线上·旧形态" };
const report = {};
const runs = []; // 每次浏览器实跑的原始结果（--live 的 ABBA 要按轮次看，不能被 report 覆盖掉）
// --live 默认跑 ABBA 四轮（新·旧·旧·新）：单调漂移在两组里等量抵消。
// --rounds=N 重复 N 遍 ABBA（8 轮 / 12 轮…）—— 线上噪声比本机大得多，单遍常常不够。
// --live --oldform 只跑一轮旧形态 —— 那是用来单独调试「拦截到底生效没有」的。
const ROUNDS = Math.max(1, Math.round(argVal("rounds", 1)));
const plan = WANT_LIVE
  ? (OLDFORM ? ["live-old"] : Array.from({ length: ROUNDS }, () => ["live", "live-old", "live-old", "live"]).flat())
  : [WANT_LINK && "link", WANT_INLINE && "inline"].filter(Boolean);
const nth = {};
const total = plan.length, nthOf = (m) => (nth[m] = (nth[m] || 0) + 1);
for (const mode of plan) {
  const k = nthOf(mode);
  const rep = total > 2 ? ` [第 ${k} 轮/${plan.filter((x) => x === mode).length}]` : "";
  process.stdout.write(`\n▶ 正在测「${LABEL[mode]}」${rep}${MOBILE ? "（移动视口 390×844）" : "（桌面 1440×900）"}${RAW ? " · 不限速" : ` · 限速 RTT=${RTT}ms 带宽=${KBPS}KB/s`} …\n`);
  const r = await runMode(mode);
  r.round = k;
  runs.push(r);
  report[mode] = r; // 表里用**最后一轮**做展示，均值另算（下面 A/B 段）
}
const meanInc = (mode) => {
  const xs = runs.filter((r) => r.mode === mode).map(increment).filter((x) => x != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

console.log("\n" + "═".repeat(74));
console.log(`首绘判据（${MOBILE ? "移动 390×844" : "桌面 1440×900"}${RAW ? " · 不限速" : ` · RTT ${RTT}ms / ${KBPS}KB/s`}）`);
console.log("═".repeat(74));
const rows = [
  ["TTFB (responseStart)", (r) => fmt(r.snap.ttfb)],
  ["HTML 到齐 (responseEnd)", (r) => fmt(r.snap.respEnd)],
  ["首次内容绘制 FCP", (r) => fmt(r.snap.fcp)],
  ["**TTFB→首绘 增量**", (r) => fmt(increment(r))],
  ["LCP", (r) => (r.snap.lcp ? fmt(r.snap.lcp.t) + " " + r.snap.lcp.tag : "—")],
  ["CLS", (r) => r.snap.cls.toFixed(4)],
  ["外链样式表数", (r) => String(r.snap.externalSheetCount)],
  ["style.css 请求次数", (r) => String(r.css.length)],
  ["渲染出的卡片数", (r) => String(r.snap.cardCount)],
  ["HTML 传输字节", (r) => (r.mainDocs ? r.mainDocs.bytes : "—")],
  ["style.css 传输字节", (r) => (r.css.reduce((a, b) => a + b.bytes, 0) || "—")],
  ["首屏总字节(doc+css)", (r) => String((r.mainDocs ? r.mainDocs.bytes : 0) + r.css.reduce((a, b) => a + b.bytes, 0))],
  ["请求总数", (r) => String(r.reqCount)],
];
const modes = Object.keys(report);
console.log("指标".padEnd(26) + modes.map((m) => LABEL[m].padEnd(14)).join(""));
for (const [label, fn] of rows) {
  console.log(label.padEnd(26) + modes.map((m) => String(fn(report[m])).padEnd(14)).join(""));
}
for (const m of modes) {
  console.log(`\n[${m}] 加载到的样式表：${report[m].snap.sheets.join(" | ") || "（无外部样式表）"}`);
  console.log(`[${m}] 样式表规则总数=${report[m].snap.totalRules} · 渲染卡片数=${report[m].snap.cardCount} · 请求数=${report[m].reqCount}`);
  const g = report[m].snap.geo;
  console.log(`[${m}] 几何 layout=${g.layout} card1=${g.card1} heroAvatar=${g.heroAvatar} rightbar=${g.rightbar} 文档高=${report[m].snap.docH}`);
  console.log(`[${m}] 全页几何指纹=${report[m].snap.layoutHash}（元素 ${report[m].snap.elementCount} 个）· 控制台错误 ${report[m].errors.length} 条`);
  // 数据请求逐条列出：两种模式必须**完全等价**，否则对比就是假的
  // （实测踩过：外链模式渲染 0 张卡片、内联 8 张 —— 是测试台不等价，不是改动的影响）
  report[m].dataReqs.forEach((r) => console.log(`        · ${r.status ?? "?"} ${r.bytes}B ${r.url.replace(report[m].origin, "")}`));
  report[m].errors.forEach((e) => console.log(`        ⚠️ ${e}`));
  if (report[m].snap.clsShifts.length) console.log(`[${m}] 可见位移：${JSON.stringify(report[m].snap.clsShifts)}`);
}

// ── 断言 ──
let fail = 0;
const judge = (name, ok, detail = "") => { console.log(`\n  ${ok ? "✅" : "❌"} ${name}${detail ? "\n       " + detail : ""}`); if (!ok) fail++; };

console.log("\n" + "─".repeat(74));
console.log("断言");
console.log("─".repeat(74));

// 校准提示：线上实测（审计 §三）首页 TTFB→首绘增量 658ms。
// 本探针的限速值如果偏离太多，说明模拟不具代表性，结论不能外推到线上。
if (report.link) {
  const li = increment(report.link);
  console.log(`\n  ℹ️ 校准：外链模式实测增量 ${fmt(li)}，线上实测（审计 §三）为 658ms。`);
  console.log(`     ${li != null && Math.abs(li - 658) < 400 ? "量级相符，结论可外推。" : "偏离较大 —— 请调 --rtt / --kbps 让外链模式先复现线上量级，再看内联的收益。"}`);
}

if (report.link) {
  judge("外链模式：确实发出了 style.css 请求（对照组有效）", report.link.css.length > 0, `实际 ${report.link.css.length} 次`);
  judge("外链模式：被服务的 HTML 里有 <link rel=stylesheet href=assets/style.css>",
    /<link rel="stylesheet" href="assets\/style\.css/.test(report.link.servedHtml));
}
if (report.inline) {
  judge("内联模式：被服务的 HTML 里已无 assets/style.css 外链",
    !/(?:href|src)="assets\/style\.css/.test(report.inline.servedHtml),
    "残留外链 ⇒ 内联没生效，下面的对比无效");
  judge("内联模式：HTML 里确实带了内联样式块（不是只把 link 删了）",
    /<style[^>]*data-inlined=/.test(report.inline.servedHtml),
    "没找到内联标记 ⇒ 样式全丢了，页面会裸奔");
  judge("内联模式：真的没有请求 assets/style.css", report.inline.css.length === 0, `实际 ${report.inline.css.length} 次`);
  judge("内联模式：同一份 CSS 解析出的规则数一致（样式没丢、也没多）",
    report.inline.snap.totalRules === report.link.snap.totalRules && report.link.snap.totalRules > 300,
    `外链 ${report.link.snap.totalRules} 条 → 内联 ${report.inline.snap.totalRules} 条（两者必须相等）`);
  judge("内联模式：不再有任何外链样式表（字体表由 app.js 首绘后注入，不计）",
    report.inline.snap.externalSheetCount === 0 || report.inline.snap.sheets.every((s) => /fonts\.font\.im/.test(s)),
    report.inline.snap.sheets.join(" | "));
}
if (report.link && report.inline) {
  const li = increment(report.link), iin = increment(report.inline);
  // 先把「测试台是否公平」钉死：两侧内容状态不一致时，下面的几何/CLS 对比全都无意义
  judge("测试台公平性：两侧渲染出的卡片数一致（内容状态相同）",
    report.link.snap.cardCount === report.inline.snap.cardCount &&
    report.link.snap.elementCount === report.inline.snap.elementCount,
    `卡片 外链 ${report.link.snap.cardCount} vs 内联 ${report.inline.snap.cardCount}；` +
    `元素 外链 ${report.link.snap.elementCount} vs 内联 ${report.inline.snap.elementCount}` +
    `\n       内容状态不同 ⇒ 几何指纹必然不同，不能据此判断渲染是否一致`);
  judge("内联模式的「TTFB→首绘」增量显著更低", iin != null && li != null && iin < li * 0.6,
    `外链 ${fmt(li)} → 内联 ${fmt(iin)}（期望内联 < ${Math.round(li * 0.6)}ms）`);
  // 容差 0.01 不是随便放的：连测三次桌面，外链恒为 0.0508，内联为 0.0508/0.0508/0.0533 ——
  // 抖动 ±0.003 来自「内容行从 900px 长到 1178px」这类**内容加载**造成的位移，
  // 与样式表投递无关（它出现与否取决于内容到达时刻，不是确定性事件）。
  // 而真正要拦的那个回归是 0.0348（顶栏被网格行拉伸后塌 33px）—— 0.01 仍留 3.5 倍余量。
  // 🚫 别把这个容差放大到 0.03 以上，那会把真回归一起放过去。
  judge("CLS 没有变差（容差 0.01，理由见源码注释）",
    report.inline.snap.cls <= report.link.snap.cls + 0.01,
    `外链 ${report.link.snap.cls.toFixed(4)} → 内联 ${report.inline.snap.cls.toFixed(4)}` +
    `（差 ${(report.inline.snap.cls - report.link.snap.cls).toFixed(4)}）`);
  const a = JSON.stringify(report.link.snap.geo), b = JSON.stringify(report.inline.snap.geo);
  judge("关键元素几何指纹完全一致", a === b, a === b ? "" : `\n       外链 ${a}\n       内联 ${b}`);
  const pa = report.link.snap.layoutParts, pb = report.inline.snap.layoutParts;
  const diffs = [];
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) diffs.push(`#${i} 外链[${pa[i] ?? "缺失"}] 内联[${pb[i] ?? "缺失"}]`);
  judge("全页布局几何指纹完全一致（所有元素的布局位置/尺寸逐项相同）",
    report.link.snap.layoutHash === report.inline.snap.layoutHash && diffs.length === 0 && n > 50,
    diffs.length ? `共 ${diffs.length} 处差异（前 8 处）：\n       ` + diffs.slice(0, 8).join("\n       ") : `元素数 ${n}`);
  judge("两种模式的控制台错误条数都不为负增长（内联没引入新错误）",
    report.inline.errors.length <= report.link.errors.length,
    `外链 ${report.link.errors.length} 条 → 内联 ${report.inline.errors.length} 条`);
  judge("计算样式一致（背景/字号/圆角）", JSON.stringify(report.link.snap.style) === JSON.stringify(report.inline.snap.style),
    JSON.stringify(report.link.snap.style) + " vs " + JSON.stringify(report.inline.snap.style));
  judge("文档总高一致（没有因为缺样式而变短/变长）", report.link.snap.docH === report.inline.snap.docH,
    `${report.link.snap.docH} vs ${report.inline.snap.docH}`);
}

// ── 线上 A/B（--live）：同域名、同一次会话、冷缓存，只换「样式表怎么投递」这一件事 ──
// 判据仍是 TTFB→首绘增量（把跨境 TTFB 波动剔除），并且**必须**先证明拦截生效 ——
// 否则「没换成」会被当成「比过了」，那是本项目最忌讳的假验证。
if (report.live && report["live-old"]) {
  const nu = meanInc("live"), od = meanInc("live-old");
  const roundsOf = (m) => runs.filter((r) => r.mode === m)
    .map((r) => `${fmt(increment(r))}/cls${r.snap.cls.toFixed(4)}`).join("   ");
  const odRuns = runs.filter((r) => r.mode === "live-old");
  const nuRuns = runs.filter((r) => r.mode === "live");
  console.log("\n" + "─".repeat(74));
  console.log("线上 A/B 逐轮（ABBA 顺序：单调网络漂移在两组里等量抵消）");
  console.log("─".repeat(74));
  console.log(`  线上·新形态 各轮 TTFB→首绘： ${roundsOf("live")}`);
  console.log(`  线上·旧形态 各轮 TTFB→首绘： ${roundsOf("live-old")}`);
  console.log(`  均值：新 ${fmt(nu)}  vs  旧 ${fmt(od)}   差值 ${nu != null && od != null ? Math.round(od - nu) + "ms" : "—"}`);
  // 外部效度自检：把「合成出来的旧形态」和审计 §三 当初的**线上单点观测**对一下。
  // 两者口径相同（TTFB→首绘）。相近 ⇒ 说明这套「顶替成旧形态」的对照测的确实是同一个东西。
  console.log(`  校准：审计 §三 改动前的线上单点观测为 ${fmt(658)}（同口径）。本轮旧形态均值 ${fmt(od)} —— `
    + (od != null && Math.abs(od - 658) < 250
      ? "量级相符，说明这套「顶替回旧形态」的对照测的就是同一个东西。"
      : "与那次单点观测偏离较大（单点观测本就不稳、当天网络也不同），结论以组内新/旧差值为准。"));

  judge("线上对照组有效：旧形态轮确实顶替了主文档（拦截真的生效，不是静默没工作）",
    odRuns.every((r) => r.fulfilled >= 1),
    `各轮顶替次数：${odRuns.map((r) => r.fulfilled).join(" / ")}（有 0 就等于旧形态没生成，对照无效）`);
  judge("线上对照组有效：旧形态轮确实发出了 style.css 请求",
    odRuns.every((r) => r.css.length > 0),
    `各轮一次数：${odRuns.map((r) => r.css.length).join(" / ")}`);
  judge("线上新形态：被服务的 HTML 已无 assets/style.css 外链（正则只认 <link>，不认注释文字）",
    nuRuns.every((r) => !/<link[^>]+href="assets\/style\.css/.test(r.servedHtml)));
  judge("线上新形态：HTML 里确实带了内联样式块（不是只把 link 删了）",
    nuRuns.every((r) => /<style[^>]*data-inlined=/.test(r.servedHtml)));
  judge("线上新形态：真的没有请求 assets/style.css",
    nuRuns.every((r) => r.css.length === 0),
    `各轮一次数：${nuRuns.map((r) => r.css.length).join(" / ")}`);
  // 字节列可比的前提：两侧主文档都以 br 传输。顶替响应若忘了压缩，旧形态会凭空多背 ~28KB，
  // 那会让「首屏总字节」这一列变成假证据（实测踩过：42887 B 的明文顶替文档 vs 线上 br ~15KB）。
  // ⚠️ 上面试过给顶替响应加 Content-Encoding: br，Chrome 不解码，把页面搞坏（只剩 14 个元素）。
  //    所以这里不再假装「线上字节可比」，而是**用真数字复算** br 后的首屏总字节：
  //    新形态 = 本地 br q4 复算在线 HTML；旧形态 = 同样复算 + 线上 style.css 的真实 br 字节。
  const brSize = (html) => zlib.brotliCompressSync(Buffer.from(html, "utf8"),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: CF_BROTLI_Q } }).length;
  const cssBrBytes = odRuns.map((r) => (r.css[0] ? r.css[0].bytes : null)).filter((x) => x != null);
  const cssBr = cssBrBytes.length ? Math.round(cssBrBytes.reduce((a, b) => a + b, 0) / cssBrBytes.length) : null;
  if (cssBr != null) {
    const nuBytes = brSize(report.live.servedHtml);
    const odBytes = brSize(report["live-old"].servedHtml) + cssBr;
    console.log(`  首屏总字节（按 br q4 折算，旧形态含线上 style.css 的真实 br ${cssBr} B）：`
      + `新 ${nuBytes} B  vs  旧 ${odBytes} B（差 ${odBytes - nuBytes} B）`);
    console.log("        ⇒ 内联把 CSS 挪进 HTML 后两者一起压缩反而更省，收益主要来自**少一个往返**，不在字节");
    judge("线上字节口径：旧形态的 style.css 真的是 200 且是 br 量级（不是 404 页）",
      odRuns.every((r) => r.css[0] && r.css[0].status === 200 && r.css[0].bytes > 1000 && r.css[0].bytes < 60000),
      `各轮 ${odRuns.map((r) => `${r.css[0] ? r.css[0].status : "?"}/${r.css[0] ? r.css[0].bytes : "?"}B`).join(" / ")}`);
  }
  judge("线上收益复现：新形态的 TTFB→首绘增量显著低于旧形态",
    nu != null && od != null && nu < od * 0.6,
    `旧 ${fmt(od)} → 新 ${fmt(nu)}（期望新 < ${od != null ? Math.round(od * 0.6) : "?"}ms）`
    + `\n       本机受控实验（限速 RTT150/200KBps）为 桌面 843→425ms、移动 853→414ms`);
  judge("线上渲染结果未变：新/旧形态的全页布局指纹一致（元素数与卡片数也要一致）",
    report.live.snap.layoutHash === report["live-old"].snap.layoutHash &&
    report.live.snap.elementCount === report["live-old"].snap.elementCount,
    `新 ${report.live.snap.layoutHash}(${report.live.snap.elementCount}元素/${report.live.snap.cardCount}卡)`
    + ` vs 旧 ${report["live-old"].snap.layoutHash}(${report["live-old"].snap.elementCount}元素/${report["live-old"].snap.cardCount}卡)`);
  // ── CLS 的公平口径 ──
  // 这个站的 CLS 是**双峰**的：0.0541 与 0.0168。原因已定位到 assets/app.js:1277 ——
  // loadPosts() 先往 cardGrid 塞 4 张骨架卡，fetchAllPosts() 回来后 renderCards() 再换成真实内容；
  // 那次替换（trace 里就是 `card-grid 785x182 → 0x0`）算不算进 CLS，取决于它落在计分窗口的哪一侧。
  // ⚠️ 它与「样式表是外链还是内联」无关 —— 实测**旧形态自己也跑到 0.0541**。
  // 所以拿单轮互比会得到**假回归**（第一次跑就踩了：旧正好抽到 0.0168 那一次）。
  // 口径改为：新形态各轮最大值 ≤ 旧形态各轮最大值 + 容差；并要求新形态仍在 good 区间（< 0.1）。
  const clsOf = (m) => runs.filter((r) => r.mode === m).map((r) => r.snap.cls);
  const maxOf = (xs) => Math.max(...xs);
  judge("线上 CLS：新形态不超过旧形态各轮的最大值（同一批内容抖动范围内）",
    maxOf(clsOf("live")) <= maxOf(clsOf("live-old")) + 0.01,
    `新各轮 ${clsOf("live").map((x) => x.toFixed(4)).join(" / ")} → max ${maxOf(clsOf("live")).toFixed(4)}`
    + `\n       旧各轮 ${clsOf("live-old").map((x) => x.toFixed(4)).join(" / ")} → max ${maxOf(clsOf("live-old")).toFixed(4)}`
    + `\n       该位移来自 app.js:1277「4 张骨架卡 → 真实内容」，两形态都会发生`);
  judge("线上 CLS 仍落在 Core Web Vitals 的 good 区间（< 0.1）",
    maxOf(clsOf("live")) < 0.1, `新形态各轮 max ${maxOf(clsOf("live")).toFixed(4)}`);
  judge("线上：新形态没有引入新的控制台错误",
    report.live.errors.length <= report["live-old"].errors.length,
    `旧 ${report["live-old"].errors.length} 条 → 新 ${report.live.errors.length} 条`);
  runs.forEach((r) => r.errors.slice(0, 3).forEach((e) => console.log(`        ⚠️ [${LABEL[r.mode]}#${r.round}] ${e}`)));
}
// --live --oldform：只跑一轮旧形态，用来单独确认「拦截到底生效没有」
if (report["live-old"] && !report.live) {
  judge("旧形态轮确实顶替了主文档（拦截生效）", report["live-old"].fulfilled >= 1, `顶替 ${report["live-old"].fulfilled} 次`);
  judge("旧形态轮确实发出了 style.css 请求", report["live-old"].css.length > 0, `${report["live-old"].css.length} 次`);
}

console.log("\n" + "─".repeat(58));
console.log(fail > 0 ? `RESULT: FAIL（${fail} 项）` : "RESULT: PASS");
process.exit(fail > 0 ? 1 : 0);
