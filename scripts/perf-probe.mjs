// 真实浏览器性能探针：用本机 Edge + CDP 量线上页面的加载分解。
// 只依赖 Node 内置模块（Node 22 自带全局 WebSocket），不装 puppeteer/playwright。
//
// 用法：node .diag/perf-probe.mjs <url> [--cold]
//   --cold 用全新 user-data-dir，保证冷缓存（首次访问的真实体验）
//
// 输出：导航各阶段、首绘/FCP、资源按域名汇总、关键元素何时真正出现、长任务。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2] || "https://blog-6p3.pages.dev/";
const PORT = 9222 + (Number(process.env.PROBE_PORT_OFFSET) || 0);

const profile = mkdtempSync(join(tmpdir(), "edge-probe-"));
const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore", detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(150);
  }
  throw new Error("DevTools 端口未就绪");
}

let idc = 0;
function makeClient(ws) {
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method && handlers.has(msg.method)) {
      handlers.get(msg.method).forEach((f) => f(msg.params));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++idc;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  return { send, on, ws };
}

const fmt = (n, d = 0) => (n == null ? "-" : n.toFixed(d));

(async () => {
  const browserWs = await waitForDevtools();
  const ws = new WebSocket(browserWs);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const br = makeClient(ws);

  // 开一个页面目标
  const { targetId } = await br.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await br.send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => br.send(m, p, sessionId);

  await S("Page.enable");
  await S("Runtime.enable");

  // 收集控制台错误与未捕获异常。这个项目的 P0 事故（TDZ 被 catch 吞掉）表现就是
  // 「功能全错、控制台安静」—— 所以每次探针都顺手把它们抓出来，别只看加载时间。
  const consoleErrors = [];
  const exceptions = [];
  br.on("Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error" && p.type !== "warning") return;
    const text = (p.args || []).map((a) => (a.value != null ? a.value : a.description || a.type)).join(" ");
    consoleErrors.push(`[${p.type}] ${text}`);
  });
  br.on("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails || {};
    exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown");
  });

  // 在文档开始执行前装探针：记录「关键元素第一次非空」的时刻
  await S("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__probe = { marks: {}, longTasks: [], lcp: null };
      if (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        try { new PerformanceObserver(function (l) {
          l.getEntries().forEach(function (e) { window.__probe.longTasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); });
        }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
      }
      // LCP：最大的首屏内容元素何时画出来 —— 判断「封面图拖慢首屏」的关键指标
      if (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
        try { new PerformanceObserver(function (l) {
          var es = l.getEntries(); var e = es[es.length - 1];
          window.__probe.lcp = { t: Math.round(e.startTime), url: e.url || '', tag: e.element ? e.element.tagName : '',
            cls: e.element && e.element.className ? String(e.element.className).slice(0, 40) : '' };
        }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
      }
      var tick = setInterval(function () {
        var p = window.__probe, now = performance.now();
        function mark(k, sel, min) {
          if (p.marks[k] != null) return;
          var el = document.querySelector(sel);
          if (!el) return;
          // ⚠️ 叶子节点（如 <h1>文字</h1>）的 Element.children.length 恒为 0，
          // 用 children 判定会永远标记不上 —— 那种「测不到」会被误读成「没出现」。
          if (min === "text") { if (el.textContent && el.textContent.trim()) p.marks[k] = Math.round(now); return; }
          if (min ? el.children.length >= min : el.children.length > 0) p.marks[k] = Math.round(now);
        }
        mark('sidebarRecent', '#recentList', 1);
        mark('tagCloud', '#tagCloud', 1);
        mark('sliderSlide', '#slides .slide', 1);
        mark('card', '.card', 1);
        mark('lunarClock', '.lunar-clock', 0);
        mark('postTitle', '.view-post h1', "text");
        mark('postBodyText', '.post-body p', 1);
        mark('postBodyHtml', '.post-body', 0);
        mark('commentList', '#commentList .comment-item', 1);
        // 注意：不要提前 clearInterval —— 文章页的卡片/侧栏会先出现（~1.8s），
        // 若此时停表就会漏掉正文（~3s）。轮询开销可忽略，交给页面卸载自然结束。
      }, 16);`,
  });

  const WARM = process.argv.includes("--warm");
  await S("Page.navigate", { url });
  if (WARM) {
    // 先访问一次把资源灌进 HTTP 缓存（模拟用户「第二次打开」），再重新导航并测量。
    // 每次新文档都会重跑 addScriptToEvaluateOnNewDocument，marks 自动归零。
    await sleep(7000);
    await S("Page.navigate", { url });
  }
  await sleep(Number(process.env.PROBE_WAIT || 12000));

  const ev = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
    return r.result ? r.result.value : null;
  };

  const nav = await ev(`(function(){
    var n = performance.getEntriesByType('navigation')[0] || {};
    var p = performance.getEntriesByType('paint') || [];
    var f = {};
    p.forEach(function (e) { f[e.name] = Math.round(e.startTime); });
    return {
      ttfb: Math.round(n.responseStart || 0),
      htmlDone: Math.round(n.responseEnd || 0),
      domInteractive: Math.round(n.domInteractive || 0),
      dcl: Math.round(n.domContentLoadedEventEnd || 0),
      load: Math.round(n.loadEventEnd || 0),
      fp: f['first-paint'] || null, fcp: f['first-contentful-paint'] || null,
      domNodes: document.getElementsByTagName('*').length,
      booted: window.__APP_BOOTED__,
      marks: (window.__probe||{}).marks || {},
      lcp: (window.__probe||{}).lcp || null,
      longTasks: (window.__probe||{}).longTasks || [],
      fontsStatus: document.fonts ? document.fonts.status : 'n/a',
      serifUsed: (function(){ try { return getComputedStyle(document.querySelector('h2')).fontFamily; } catch(e){ return null; } })(),
      recentCount: (document.querySelector('#recentList')||{children:{length:0}}).children.length,
      cardCount: document.querySelectorAll('.card').length
    };
  })()`);

  const res = await ev(`JSON.stringify(performance.getEntriesByType('resource').map(function(r){
    return { n: r.name, t: r.initiatorType, s: Math.round(r.startTime), d: Math.round(r.duration), b: r.transferSize || 0, ds: r.decodedBodySize || 0 };
  }))`);
  const resources = JSON.parse(res || "[]");

  console.log(`\n===== 页面：${url} =====`);
  console.log(`  缓存：${WARM ? "暖缓存（第二次访问）" : "冷缓存（全新 profile，首次访问）"}`);
  console.log("--- 导航阶段 (ms) ---");
  console.log(`  TTFB(HTML)          ${nav.ttfb}`);
  console.log(`  HTML 接收完成        ${nav.htmlDone}`);
  console.log(`  DOM 可交互           ${nav.domInteractive}`);
  console.log(`  DOMContentLoaded    ${nav.dcl}`);
  console.log(`  load                ${nav.load}`);
  console.log(`  首次绘制 FP          ${nav.fp}`);
  console.log(`  首次内容绘制 FCP     ${nav.fcp}`);
  console.log(`  DOM 节点数           ${nav.domNodes}`);
  console.log(`  app.js 已启动        ${nav.booted}`);
  console.log(`  字体状态             ${nav.fontsStatus}   标题字体: ${nav.serifUsed}`);

  console.log("\n--- 关键元素真正出现的时刻 (ms，相对导航开始) ---");
  const M = nav.marks || {};
  console.log(`  农历挂件            ${M.lunarClock ?? "-"}`);
  console.log(`  左侧·最近文章        ${M.sidebarRecent ?? "未出现"}`);
  console.log(`  左侧·标签云          ${M.tagCloud ?? "未出现"}`);
  console.log(`  轮播                ${M.sliderSlide ?? "未出现"}`);
  console.log(`  文章卡片            ${M.card ?? "未出现"}`);
  console.log(`  文章标题            ${M.postTitle ?? "未出现"}`);
  console.log(`  文章正文            ${M.postBodyHtml ?? "未出现"}`);
  console.log(`  评论列表            ${M.commentList ?? "未出现"}`);
  console.log(`  → 实际渲染：最近文章 ${nav.recentCount} 条 / 卡片 ${nav.cardCount} 个`);

  // ── 封面/图片专项：回答「图片会不会阻塞首绘、为什么没加载出来」 ──
  // 图片（<img> 与 CSS background-image）都不在渲染阻塞资源之列，真正值得看的是
  // 「它什么时候才开始下载」和「它的结束时间相对 FCP/LCP 在哪」。
  const imgRes = resources.filter((r) => r.t === "img" || /\.(jpe?g|png|webp|avif|gif|svg)(\?|$)/i.test(r.n));
  const coverRes = imgRes.filter((r) => /\/generated\/(covers|body-images)\//.test(r.n));
  console.log("\n--- 封面/图片资源（下载何时开始、何时结束）---");
  if (!imgRes.length) console.log("  无图片请求");
  else {
    console.log("  资源                                 开始   耗时   结束   传输  发起");
    for (const r of imgRes.slice().sort((a, b) => a.s - b.s)) {
      const name = r.n.replace(/^https?:\/\/[^/]+/, "").slice(0, 34) + (r.n.length > 46 ? "…" : "");
      console.log(`  ${name.padEnd(38)} ${String(r.s).padStart(5)} ${String(r.d).padStart(6)} ${String(r.s + r.d).padStart(6)} ${String(r.b).padStart(7)}  ${r.t}`);
    }
    const firstStart = Math.min(...imgRes.map((r) => r.s));
    const lastEnd = Math.max(...imgRes.map((r) => r.s + r.d));
    console.log(`  图片共 ${imgRes.length} 个（其中 generated/ 下 ${coverRes.length} 个）；` +
      `最早开始 +${firstStart}ms，最晚结束 +${lastEnd}ms`);
    console.log(`  → 相对 FCP(${nav.fcp ?? "-"}ms)：图片最早发起于 FCP ${firstStart < (nav.fcp || 0) ? "之前" : "之后"}，` +
      `图片全部结束于 FCP ${lastEnd > (nav.fcp || 0) ? "之后" : "之前"}`);
  }
  console.log(`\n  LCP（最大首屏内容）  ${nav.lcp ? nav.lcp.t + "ms  " + nav.lcp.tag + " " + nav.lcp.cls + " " + (nav.lcp.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 46) : "未记录"}`);

  console.log("\n--- 长任务（>50ms，阻塞交互）---");
  const lt = (nav.longTasks || []).sort((a, b) => b.d - a.d).slice(0, 8);
  if (!lt.length) console.log("  无");
  else lt.forEach((t) => console.log(`  +${t.s}ms  持续 ${t.d}ms`));
  const ltTotal = (nav.longTasks || []).reduce((a, b) => a + b.d, 0);
  console.log(`  合计 ${ltTotal}ms / ${(nav.longTasks || []).length} 个`);

  console.log("\n--- 控制台错误 / 未捕获异常 ---");
  if (!consoleErrors.length && !exceptions.length) console.log("  无");
  else {
    exceptions.slice(0, 6).forEach((t) => console.log("  💥 " + String(t).split("\n")[0].slice(0, 160)));
    consoleErrors.slice(0, 8).forEach((t) => console.log("  " + t.slice(0, 160)));
    console.log(`  合计：异常 ${exceptions.length} 个 / 控制台 error+warning ${consoleErrors.length} 条`);
  }

  console.log("\n--- 资源按域名汇总 ---");
  const byHost = new Map();
  for (const r of resources) {
    let h; try { h = new URL(r.n).host; } catch (_) { h = "(相对)"; }
    const k = h + " " + r.t;
    if (!byHost.has(k)) byHost.set(k, { c: 0, b: 0, d: 0, max: 0 });
    const o = byHost.get(k);
    o.c++; o.b += r.b; o.d += r.d; o.max = Math.max(o.max, r.d);
  }
  const rows = [...byHost.entries()].sort((a, b) => b[1].b - a[1].b);
  console.log("  域名/类型                 个数   传输(bytes)   总耗时(ms)  最慢单个");
  for (const [k, o] of rows) {
    console.log(`  ${k.padEnd(24)} ${String(o.c).padStart(4)} ${String(o.b).padStart(12)} ${String(Math.round(o.d)).padStart(11)} ${String(Math.round(o.max)).padStart(10)}`);
  }

  console.log("\n--- 最慢的 12 个按域名分组后的关键条目 ---");
  const fontRes = resources.filter((r) => /font\.im|gstatic/.test(r.n));
  const fontBytes = fontRes.reduce((a, b) => a + b.b, 0);
  console.log(`  字体相关请求 ${fontRes.length} 个，传输合计 ${(fontBytes / 1024).toFixed(1)}KB，` +
    `首个开始 +${fontRes[0] ? fontRes[0].s : "-"}ms，最晚结束 +${fontRes.length ? Math.max(...fontRes.map((r) => r.s + r.d)) : "-"}ms`);
  const slow = resources.slice().sort((a, b) => (b.s + b.d) - (a.s + a.d)).slice(0, 12);
  console.log("  资源                                     开始    耗时   结束   传输");
  for (const r of slow) {
    const name = r.n.replace(/^https?:\/\/[^/]+/, "").slice(0, 38) + (r.n.length > 50 ? "…" : "");
    console.log(`  ${name.padEnd(40)} ${String(r.s).padStart(5)} ${String(r.d).padStart(6)} ${String(r.s + r.d).padStart(6)} ${String(r.b).padStart(7)}`);
  }

  ws.close();
  try { child.kill(); } catch (_) {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("探针失败:", e.message); try { child.kill(); } catch (_) {} process.exit(1); });
