// 留言墙「便签条」在手机上的宽度实测（只读探针）。
// 用法：node scripts/audit-guestbook-width.mjs
//   默认测线上 https://blog-6p3.pages.dev；截图落在 .diag/out/gbwidth/。
//
// 为什么要真浏览器：便签宽度由一整条容器链决定 ——
//   视口 → .layout(270px 1fr 270px，≤980 收单列) → .content → .view-guestbook
//        → .guestbook-board(6px 边框 + padding) → .g-board-inner(grid) → .g-card
//   静态读 CSS 只能推出第一层，量不出来。另有两点只有浏览器能答：
//   · 卡片带 transform: rotate()（手贴感），视觉包围盒 ≠ 布局宽度
//   · (pointer: coarse) 只改热区不改宽度，但 mobile 模拟开关会让 window.innerWidth
//     与「媒体查询看到的宽度」不一致 —— 所以本探针自带校准，见下面 CALIBRATION。
//
// ⚠️ 只测量，不写库、不发写请求。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", ".diag", "out", "gbwidth");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BLOG_BASE || "https://blog-6p3.pages.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 覆盖三处断点（980 / 640 / 380）两侧 + 常见机型宽度
const WIDTHS = [1280, 1180, 1024, 1000, 981, 980, 900, 820, 768, 700, 641, 640, 639, 600, 540, 480, 430, 414, 393, 390, 381, 380, 379, 375, 360, 320];
const SHOT_AT = new Set([393, 381, 380, 360]);

// 常见机型（CSS px，横屏不给）—— 用来把数字翻译成人话
const DEVICES = [
  { name: "iPhone 16 Pro Max / 15 Pro Max", w: 430 },
  { name: "iPhone 14/13/12、Pixel 7", w: 390 },
  { name: "iPhone 15/14 Pro", w: 393 },
  { name: "iPhone SE 2/3、13 mini", w: 375 },
  { name: "多数安卓（360dp）", w: 360 },
  { name: "iPhone SE 1、老安卓", w: 320 },
];

const CDP_PORT = 9861 + Math.floor(Math.random() * 60);
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));
if (!EDGE) { console.error("找不到 Edge/Chrome"); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), "edge-gbwidth-"));
const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.subs = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) this.subs.forEach((f) => f(m));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(f) { this.subs.push(f); }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error("CDP 连不上");
}

// 一次切换视口后把整条容器链量下来
const PROBE = `(function(){
  function w(sel){ var e=document.querySelector(sel); return e?{w:e.clientWidth,h:e.clientHeight}:null; }
  var inner = document.querySelector(".g-board-inner");
  var board = document.querySelector(".guestbook-board");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".g-board-inner .g-card"));
  var cs = inner ? getComputedStyle(inner) : null;
  var tracks = cs ? cs.gridTemplateColumns : "";
  var de = document.documentElement;
  return {
    innerWidth: window.innerWidth,
    clientWidth: de.clientWidth,
    mq980: matchMedia("(max-width: 980px)").matches,
    mq640: matchMedia("(max-width: 640px)").matches,
    mq380: matchMedia("(max-width: 380px)").matches,
    // ⚠️ 模拟器口径：桌面档 scrollWidth 按 innerWidth 算、移动档按 clientWidth 算，
    //    两者差 8/15px 是**模拟器的读数口径**，不是真溢出。真溢出另用下面的决定性判据。
    scrollW: de.scrollWidth,
    // 决定性判据①：真的能不能横向滚（能滚才是真溢出）
    scrollX: (function(){ window.scrollTo(99999, 0); var x = Math.round(window.scrollX); window.scrollTo(0, 0); return x; })(),
    // 决定性判据②：关键容器的右边缘有没有越过视口
    maxRight: (function(){
      var sel = [".layout", ".content", ".view-guestbook", ".guestbook-board", ".g-board-inner", ".g-card", ".sidebar", ".rightbar"];
      var m = 0;
      sel.forEach(function(s){
        Array.prototype.forEach.call(document.querySelectorAll(s), function(e){
          var r = e.getBoundingClientRect(); if (r.width > 0 && r.right > m) m = r.right;
        });
      });
      return Math.round(m);
    })(),
    groups: document.querySelectorAll(".g-board-inner").length,
    layout: w(".layout"), content: w(".content"), view: w(".view-guestbook"),
    board: w(".guestbook-board"), inner: w(".g-board-inner"),
    rightbar: w(".rightbar"),
    tracks: tracks,
    cols: tracks ? tracks.trim().split(/\\s+/).length : 0,
    gap: cs ? cs.columnGap : null,
    nCards: cards.length,
    cardW: cards.map(function(c){ return c.offsetWidth; }),
    cardH: cards.map(function(c){ return c.offsetHeight; }),
    bboxW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : null,
    rotate: cards.length ? getComputedStyle(cards[0]).transform : null,
    contentFont: cards.length ? getComputedStyle(cards[0].querySelector(".g-content")).fontSize : null,
    titleFont: cards.length ? getComputedStyle(cards[0].querySelector(".g-meta")||cards[0]).fontSize : null
  };
})()`;

let pass = 0, fail = 0;
const rows = [];
try {
  const wsUrl = await connect();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const cdp = new CDP(ws);

  const errors = [];
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text || "?");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    }
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  const setViewport = async (w) => {
    const mobile = w <= 980;   // 手机上不会有 980px 宽的桌面布局；≤980 一律按移动/触屏模拟
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 844, deviceScaleFactor: 1, mobile });
    // ⚠️ mobile 只改视口，不让 (pointer: coarse) 命中 —— 必须单独开触摸模拟
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
    await sleep(220);
  };
  const shot = async (tag) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${tag}.png`), Buffer.from(r.data, "base64"));
  };

  // ── 开页面 → 切留言墙 → 等真便签渲染 ──
  await setViewport(390);
  await cdp.send("Page.navigate", { url: `${BASE}/?cb=${Math.random()}` });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try { if (await ev("!!window.__APP_READY__")) { ready = true; break; } } catch (_) {}
  }
  if (!ready) throw new Error("页面没起来（__APP_READY__ 未置位）");

  const okView = await ev(`(function(){
    var a = document.querySelector('.nav-link[data-view="guestbook"]');
    if (!a) return false; a.click(); return true;
  })()`);
  let got = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    got = await ev(`document.querySelectorAll(".g-board-inner .g-card").length`);
    if (got > 0) break;
  }
  const provenance = await ev(`(function(){
    var c = document.querySelector(".g-card");
    return c ? (c.querySelector(".g-content")||{}).textContent || "" : "";
  })()`);
  console.log(`\n目标 ${BASE}`);
  console.log(`切到留言墙：${okView ? "成功" : "找不到入口"}   线上真实渲染 ${got} 张便签`);
  console.log(`第一条内容（证明量的是线上真数据，不是我自己造的 DOM）：${JSON.stringify(provenance.slice(0, 18))}\n`);

  console.log("请求宽 | CSS视口 | 断点640/380/980 | 列数 | 每列宽(track)        | 卡片W | bboxW | 真横溢");
  console.log("-------|---------|-----------------|------|---------------------|-------|-------|------");
  for (const w of WIDTHS) {
    await setViewport(w);
    const m = await ev(PROBE);
    rows.push({ ...m, reqW: w });
    const uniq = [...new Set(m.cardW)];
    console.log(
      String(w).padStart(6) + " | " +
      `iw${m.innerWidth}/cw${m.clientWidth}`.padStart(15) + " | " +
      `${m.mq640 ? "Y" : "n"}/${m.mq380 ? "Y" : "n"}/${m.mq980 ? "Y" : "n"}`.padStart(15) + " | " +
      String(m.cols).padStart(4) + " | " +
      String(m.tracks).padEnd(19).slice(0, 19) + " | " +
      (uniq.length === 1 ? String(uniq[0]) : uniq.join("/")).padStart(5) + " | " +
      String(m.bboxW).padStart(5) + " | " +
      (m.scrollX > 0 ? `滚${m.scrollX}px` : "无").padStart(6)
    );
    if (SHOT_AT.has(w)) await shot(`gb-${w}`);
  }

  // ── 校准：请求宽度必须等于「CSS 看到的宽度」，否则整张表都是别的环境的数字 ──
  console.log("\n校准与判据：");
  const ck = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}\n     实际: ${detail}`); } };

  // 校准锚在**媒体查询命中**上：那才是决定布局的那个宽度。
  // （实测关系：桌面档 mobile:false → 媒体查询看 innerWidth(=请求宽)、clientWidth 少 15px 滚动条；
  //   移动档 mobile:true → 媒体查询看 clientWidth(=请求宽)、innerWidth 多 8px。两种口径都不影响本表。）
  const badCal = rows.filter((r) => {
    const expect640 = r.reqW <= 640, expect380 = r.reqW <= 380, expect980 = r.reqW <= 980;
    const mqOk = r.mq640 === expect640 && r.mq380 === expect380 && r.mq980 === expect980;
    const regimeOk = r.reqW <= 980 ? r.clientWidth === r.reqW : r.innerWidth === r.reqW;
    return !mqOk || !regimeOk;
  });
  ck("仪器校准：请求宽度 == 媒体查询看到的宽度（三处断点两侧都对得上）", badCal.length === 0,
    badCal.map((r) => `${r.reqW}→iw${r.innerWidth}/cw${r.clientWidth} mq640=${r.mq640} mq380=${r.mq380} mq980=${r.mq980}`).join("；"));

  const sameRow = (r) => new Set(r.cardW).size <= 1;
  ck("同一视口下所有便签等宽（没有哪一张被单独拉宽）", rows.every(sameRow),
    rows.filter((r) => !sameRow(r)).map((r) => `${r.reqW}px: ${r.cardW.join("/")}`).join("；"));

  // ⚠️ 不用 scrollWidth-clientWidth 判溢出：模拟器两种口径差 8/15px，会得出 21 个假红。
  //    用「真的能不能横向滚」+「关键容器右边缘是否越过视口」两条决定性判据。
  const scrolled = rows.filter((r) => r.scrollX > 0);
  const overRight = rows.filter((r) => r.maxRight > r.clientWidth + 1);
  ck("任何宽度下页面都滚不动横向（决定性判据：scrollTo 到极右后 scrollX 仍为 0）", scrolled.length === 0,
    scrolled.map((r) => `${r.reqW}px 可滚 ${r.scrollX}px`).join("；"));
  ck("任何宽度下关键容器右边缘都不越过视口", overRight.length === 0,
    overRight.map((r) => `${r.reqW}px maxRight=${r.maxRight} > clientW=${r.clientWidth}`).join("；"));

  const g = (w) => rows.find((r) => r.reqW === w);
  ck("380/381 之间确实发生单列回落：>380 两列、≤380 一列",
    g(381).cols === 2 && g(380).cols === 1 && g(360).cols === 1,
    `381→${g(381).cols} 列，380→${g(380).cols} 列，360→${g(360).cols} 列`);

  const card = (w) => g(w).cardW[0];
  // 单调性：在两个档位内部各自逐级收窄（别有的宽度卡住不动 —— 那说明有别的规则在插队）
  const asc = (a, b) => a.reqW - b.reqW;
  const two = rows.filter((r) => r.reqW > 380 && r.reqW <= 640).sort(asc);
  const one = rows.filter((r) => r.reqW <= 380).sort(asc);
  const mono = (arr) => arr.every((r, i) => i === 0 || arr[i - 1].cardW[0] <= r.cardW[0]);
  ck("两列档（381–640）内便签宽随视口单调收窄", mono(two) && two[two.length - 1].cardW[0] > two[0].cardW[0],
    two.map((r) => `${r.reqW}:${r.cardW[0]}`).join(" "));
  ck("单列档（≤380）内便签宽随视口单调收窄", mono(one) && one[one.length - 1].cardW[0] > one[0].cardW[0],
    one.map((r) => `${r.reqW}:${r.cardW[0]}`).join(" "));

  ck("主流手机（390/393/414/430）的便签比桌面列更窄 —— 手机上是变窄，不是变宽",
    card(390) < card(1280) && card(430) < card(1280), `390→${card(390)}，430→${card(430)}，桌面 1280→${card(1280)}`);
  ck("但最窄档（≤380 单列）的便签比桌面列还宽 —— 全站最宽的便签出现在最窄的手机上",
    card(375) > card(1280) && card(320) > 0, `375→${card(375)}，320→${card(320)}，桌面 1280→${card(1280)}`);

  console.log("\n机型对照（便签实际宽 × 在同一行能放几张）：");
  for (const d of DEVICES) {
    const r = g(d.w);
    if (r) console.log(`  ${d.name.padEnd(30)} ${String(d.w).padStart(4)}px 视口 → 便签 ${String(r.cardW[0]).padStart(3)}px 宽，一屏 ${r.cols} 列`);
  }

  const a = g(381).cardW[0], b = g(380).cardW[0];
  console.log(`\n  ⚠️ 380↔381 的宽度悬崖：视口只差 1px，便签从 ${a}px 跳到 ${b}px（×${(b / a).toFixed(2)}）—— 单列回落规则在这里生效`);
  const rot = g(1280);
  console.log(`  ℹ️ 卡片带 rotate()（手贴感）：1280px 下布局宽 ${rot.cardW[0]}，视觉包围盒 ${rot.bboxW}（多 ${rot.bboxW - rot.cardW[0]}px）`);
  console.log(`  ℹ️ 容器链 @390：layout=${g(390).layout.w} content=${g(390).content.w} view=${g(390).view.w} board=${g(390).board.w} inner=${g(390).inner.w}（board 的 6px 边框×2 + padding 14×2 都在这里被吃掉）`);
  console.log(`  ℹ️ 容器链 @1280：layout=${g(1280).layout.w} content=${g(1280).content.w} 右栏=${g(1280).rightbar.w} —— 桌面三栏把正文列压到 ${g(1280).content.w}px，比很多手机都窄`);
  console.log(`  ℹ️ 页面异常：${errors.length ? errors.slice(0, 3).join(" | ") : "无"}`);

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  console.log(`截图：.diag/out/gbwidth/`);
} catch (e) {
  console.error("探针异常：", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
process.exit(process.exitCode || (fail ? 1 : 0));
