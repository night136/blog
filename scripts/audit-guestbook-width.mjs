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

// 覆盖断点两侧 + 常见机型宽度。
// ⚠️ **不硬编码「单列回落」的阈值**：阈值本身是被测对象（会随设计调整），
//    写死它会让探针在每次改阈值时假红 —— 那是「盯实现形态」。改为自动探测
//    列数发生变化的那一处边界（见下面的 `drop`），探针因此长期有效。
// 细档（320–400、384/383、340/321）是为了「阈值一旦下调、这段落回两列」时有实测点可依 ——
// 单列时量到的 cardW 就等于容器内宽，两列宽 =(内宽 − 12)/2 由 ≤640 块的规则直接给出。
const WIDTHS = [1280, 1180, 1024, 1000, 981, 980, 900, 820, 768, 700, 641, 640, 639, 600, 540, 480, 430, 414, 410, 404, 401, 400, 399, 393, 390, 384, 383, 381, 380, 379, 375, 360, 340, 321, 320, 300, 280];
const SHOT_AT = new Set([430, 400, 360]);

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
    // 校准只用两个**本次不动**的断点（980 收单列 / 640 便签两列）。
    // 不拿「单列回落阈值」来校准 —— 它正是被测对象，写进校准会一改阈值就假红。
    mq980: matchMedia("(max-width: 980px)").matches,
    mq640: matchMedia("(max-width: 640px)").matches,
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

  console.log("请求宽 | CSS视口 | 断点980/640 | 列数 | 每列宽(track)        | 卡片W | bboxW | 真横溢");
  console.log("-------|---------|-------------|------|---------------------|-------|-------|------");
  for (const w of WIDTHS) {
    await setViewport(w);
    const m = await ev(PROBE);
    rows.push({ ...m, reqW: w });
    const uniq = [...new Set(m.cardW)];
    console.log(
      String(w).padStart(6) + " | " +
      `iw${m.innerWidth}/cw${m.clientWidth}`.padStart(15) + " | " +
      `${m.mq980 ? "Y" : "n"}/${m.mq640 ? "Y" : "n"}`.padStart(11) + " | " +
      String(m.cols).padStart(4) + " | " +
      String(m.tracks).padEnd(19).slice(0, 19) + " | " +
      (uniq.length === 1 ? String(uniq[0]) : uniq.join("/")).padStart(5) + " | " +
      String(m.bboxW).padStart(5) + " | " +
      (m.scrollX > 0 ? `滚${m.scrollX}px` : "无").padStart(6)
    );
    if (SHOT_AT.has(w)) await shot(`gb-${w}`);
  }

  // ── 补测「边界上沿」────────────────────────────────────────────────────────
  // 🔴 2026-09-19 的教训：**最窄的便签出现在边界上方 1px 处**（视口越窄越窄），
  //    而粗扫网格未必压在那一点上 —— 阈值 330 时网格里是 321(单列)/340(两列)，
  //    只量网格点就会把「最窄」量成 128px（真值 123.5px @331px），
  //    让下限断言**虚高通过**。所以定出边界位置后再补测一次 `边界上沿`。
  //    这正是上一轮出过的错：断言名写「任何视口」，而采样网格恰好漏掉了真正最窄的那段。
  {
    const sub = () => rows.filter((r) => r.reqW >= 280 && r.reqW <= 640).sort((a, b) => a.reqW - b.reqW);
    const edgesOf = (list) => {
      const e = [];
      for (let i = 1; i < list.length; i++) if (list[i].cols !== list[i - 1].cols) e.push([list[i - 1], list[i]]);
      return e;
    };
    const d = edgesOf(sub()).find(([lo, hi]) => lo.cols < hi.cols);
    if (d && d[1].reqW - d[0].reqW > 1) {
      const w = d[0].reqW + 1;
      await setViewport(w);
      rows.push({ ...(await ev(PROBE)), reqW: w });
      console.log(`\n  （补测 ${w}px：粗扫网格没压在 ${d[1].reqW}↔${d[0].reqW} 这道边界上，最窄值就在这一处）`);
    }
  }

  // ── 校准：请求宽度必须等于「CSS 看到的宽度」，否则整张表都是别的环境的数字 ──
  console.log("\n校准与判据：");
  const ck = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}\n     实际: ${detail}`); } };

  // 校准锚在**媒体查询命中**上：那才是决定布局的那个宽度。
  // （实测关系：桌面档 mobile:false → 媒体查询看 innerWidth(=请求宽)、clientWidth 少 15px 滚动条；
  //   移动档 mobile:true → 媒体查询看 clientWidth(=请求宽)、innerWidth 多 8px。两种口径都不影响本表。）
  const badCal = rows.filter((r) => {
    const expect640 = r.reqW <= 640, expect980 = r.reqW <= 980;
    const mqOk = r.mq640 === expect640 && r.mq980 === expect980;
    const regimeOk = r.reqW <= 980 ? r.clientWidth === r.reqW : r.innerWidth === r.reqW;
    return !mqOk || !regimeOk;
  });
  ck("仪器校准：请求宽度 == 媒体查询看到的宽度（980/640 两侧都对得上）", badCal.length === 0,
    badCal.map((r) => `${r.reqW}→iw${r.innerWidth}/cw${r.clientWidth} mq640=${r.mq640} mq980=${r.mq980}`).join("；"));

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
  const card = (w) => g(w).cardW[0];
  const asc = (a, b) => a.reqW - b.reqW;

  // ── 自动探测「单列回落」的边界（不硬编码阈值）──
  // 阈值本身是被测对象；写死它 ⇒ 每次调阈值探针都假红，等于守护在保护旧的实现形态。
  // 下界取 280 而不是 320：阈值一旦落到 320，单列档就只剩 320 一个采样点，
  // 「单调收窄」类断言会因样本不足假红。多留两档（280/300）当单列档的基线。
  const inSmall = rows.filter((r) => r.reqW >= 280 && r.reqW <= 640).sort(asc);
  const edges = [];
  for (let i = 1; i < inSmall.length; i++) {
    if (inSmall[i].cols !== inSmall[i - 1].cols) edges.push([inSmall[i - 1], inSmall[i]]);
  }
  const drop = edges.find(([lo, hi]) => lo.cols < hi.cols);   // 视口变宽时 1 列 → 2 列
  ck("320–640 之间恰好有一处「单列→两列」的边界",
    !!drop && edges.length === 1,
    edges.length ? edges.map(([lo, hi]) => `${lo.reqW}(${lo.cols}列)→${hi.reqW}(${hi.cols}列)`).join("；") : "一处都没找到");

  const two = drop ? inSmall.filter((r) => r.reqW >= drop[1].reqW) : [];
  const one = drop ? inSmall.filter((r) => r.reqW <= drop[0].reqW) : [];
  const mono = (arr) => arr.every((r, i) => i === 0 || arr[i - 1].cardW[0] <= r.cardW[0]);
  ck("两列档内便签宽随视口单调收窄", two.length >= 3 && mono(two) && two[two.length - 1].cardW[0] > two[0].cardW[0],
    two.map((r) => `${r.reqW}:${r.cardW[0]}`).join(" "));
  ck("单列档内便签宽随视口单调收窄", one.length >= 3 && mono(one) && one[one.length - 1].cardW[0] > one[0].cardW[0],
    one.map((r) => `${r.reqW}:${r.cardW[0]}`).join(" "));

  // ⚠️ 这个下限数字是**所有者拍板的取舍**，不是可读性真理 —— 别把它当独立标准用。
  //    2026-09-19 阈值定为 320 ⇒ 最窄的两列便签出现在 321px 视口：(内宽 249 − 间距 12)/2 = 118.5px。
  //    而本规则最初自述的理由是「两列会把每列压到 ~150px 以下…更难读」，150px 需要阈值 ≥384。
  //    二者互斥，所有者选了 320 ⇒ 150px 那条不变量**被显式取消**，改成「不得比已接受的代价更窄」。
  //    所以现在这条是**回退保护**：阈值再被下调、或列数/间距被改，最窄值掉破 118 就会被抓住。
  //    🔴 教训：这条断言上一版写的是「任何视口下便签都不窄于 150px」，而采样网格里恰好没有
  //       321–379（旧阈值 380 时那一段本就在两列、最窄 118.5px）⇒ 断言名承诺的范围 >
  //       判据实查的范围，缺陷长期不可见。⇒ 采样点必须覆盖「最窄可能出现的位置」= 边界上沿，
  //       网格里常备 321，另有上面的补测兜底。
  const FLOOR = 118;   // (inner(321) − gap)/2 = (249 − 12)/2 = 118.5 的取整下界
  const thinnest = rows.filter((r) => r.cardW[0] > 0).reduce((a, r) => (r.cardW[0] < a.cardW[0] ? r : a));
  const narrow = rows.filter((r) => r.cardW[0] > 0 && r.cardW[0] < FLOOR);
  ck(`任何视口下便签都不窄于 ${FLOOR}px（= 阈值 320 下已接受的代价，回退保护）`, narrow.length === 0,
    narrow.map((r) => `${r.reqW}px 视口只有 ${r.cardW[0]}px`).join("；"));
  console.log(`  ℹ️ 实测最窄便签 ${thinnest.cardW[0]}px @ ${thinnest.reqW}px 视口（阈值 320 的理论最窄 118.5px @321px）`);

  ck("跨过该边界确实变宽（回落规则真的生效）",
    !!drop && drop[0].cardW[0] > drop[1].cardW[0],
    drop ? `${drop[1].reqW}px 两列时 ${drop[1].cardW[0]}px → ${drop[0].reqW}px 单列时 ${drop[0].cardW[0]}px` : "无边界");

  console.log("\n机型对照（便签实际宽 × 在同一行能放几张）：");
  for (const d of DEVICES) {
    const r = g(d.w);
    if (r) console.log(`  ${d.name.padEnd(30)} ${String(d.w).padStart(4)}px 视口 → 便签 ${String(r.cardW[0]).padStart(3)}px 宽，一屏 ${r.cols} 列`);
  }

  if (drop) {
    const a = drop[1].cardW[0], b = drop[0].cardW[0];
    console.log(`\n  ⚠️ ${drop[1].reqW}↔${drop[0].reqW} 的宽度悬崖：视口只差 ${drop[1].reqW - drop[0].reqW}px，便签从 ${a}px 跳到 ${b}px（×${(b / a).toFixed(2)}）—— 单列回落规则在 ≤${drop[0].reqW} 生效`);
  }
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
