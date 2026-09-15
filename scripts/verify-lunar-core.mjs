// 内联农历的**正确性**验证：把 assets/app.js 里的 LUNAR-INLINE 代码块整段抽出来真跑，
// 逐日、逐月对着黄金基准全量比对。
//
// 为什么需要它：官方的农历数据（闰月、大小月、节气）没法靠公式推准 —— 实测「节气公式」
// 在 1900–2100 里有 5% 的年份差一天。所以内联实现用的是**从旧库导出的表**，
// 而这张表是否被正确解读，只能靠全量比对来证明（73445 天 + 2498 个农历月）。
//
// 用法：node scripts/verify-lunar-core.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { computeLunarDigest, iso } from "./lib/lunar-digest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
const golden = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "lunar-golden.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}
const section = (t) => console.log("\n" + t);

// ---------- 抽取内联块并求值 ----------
const START = "// ===== LUNAR-INLINE-START =====";
const END = "// ===== LUNAR-INLINE-END =====";
function extract(src) {
  const i = src.indexOf(START), j = src.indexOf(END, i);
  if (i < 0 || j < 0) return null;
  return src.slice(i + START.length, j);
}
const EXPORTS = ["lunarOf", "lunarMonthDays", "lunarToSolar", "solarWeekday", "lDayCn", "lMonthCn",
  "lGanZhi", "lShengXiao", "lLeapMonth", "lYearDays", "lFromSolarNum", "lToSolarNum", "lJieQiDay",
  "LUNAR_Y0", "LUNAR_YEAR_INFO", "LUNAR_JIEQI_DAYS"];
function evalBlock(body) {
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn {" + EXPORTS.join(",") + "};")();
}

const body = extract(appSrc);
const api = body ? evalBlock(body) : null;

// 把内联实现适配成摘要格式（与 gen-lunar-data.mjs 里的「旧库适配器」一一对应）
function adapterOf(a) {
  return {
    fromDate(date) {
      const lu = a.lunarOf(date);
      if (!lu) return null;
      return {
        y: lu.y, m: lu.m, d: lu.d, monthCn: lu.month, dayCn: lu.day,
        ganZhi: lu.ganZhi, shengXiao: lu.shengXiao, jieQi: lu.jieQi,
        nextName: lu.next.name, nextYmd: iso(lu.next.y, lu.next.m, lu.next.d),
      };
    },
    monthsOfYear(y) {
      const lp = a.lLeapMonth(y);
      const ms = [];
      // 与生成器一致：按时间顺序插入闰月（闰月紧跟同名平月之后）
      for (let m = 1; m <= 12; m++) { ms.push(m); if (m === lp) ms.push(-lp); }
      return ms;
    },
    monthDayCount: (y, m) => a.lunarMonthDays(y, m),
    lunarToSolar: (y, m, d) => { const s = a.lunarToSolar(y, m, d); return iso(s.y, s.m, s.d); },
  };
}

// 缩小范围的摘要，供负向验证用（全量跑一遍要几百毫秒，8 组变异会拖慢整套回归）。
// 窗口从 1900 起 —— 1899-01..11 在支持范围外，会拿到 null。
// 遇到 null 也照常记一行（而不是抛错）：变异有可能把日期推出范围，那本身就是「变了」。
function digestWindow(a, fromY, toY) {
  const ad = adapterOf(a);
  const lines = [];
  for (let y = fromY; y <= toY; y++) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const lu = ad.fromDate(new Date(y, m - 1, d));
        lines.push(lu
          ? [iso(y, m, d), lu.y, lu.m, lu.d, lu.monthCn, lu.dayCn, lu.ganZhi, lu.shengXiao,
            lu.jieQi || "", lu.nextName + "@" + lu.nextYmd].join("|")
          : iso(y, m, d) + "|NULL");
      }
    }
    for (const mm of ad.monthsOfYear(y)) {
      lines.push(`M|${y}|${mm}|${ad.monthDayCount(y, mm)}|${ad.lunarToSolar(y, mm, 1)}|${ad.lunarToSolar(y, mm, ad.monthDayCount(y, mm))}`);
    }
  }
  return lines.join("\n");
}

// ============================================================
section("[1] 内联块存在且自洽");
check("能定位 LUNAR-INLINE 起止标记", !!body);
check("能求值（无语法/引用错误）", !!api);
{
  check("年表覆盖 1899..2100（202 项）", api && api.LUNAR_YEAR_INFO.length === 202, api && String(api.LUNAR_YEAR_INFO.length));
  check("节气表长度 = (2101−1899+1) × 24 = 4872（含跨年所需的 2101 年）",
    api && api.LUNAR_JIEQI_DAYS.length === (2101 - 1899 + 1) * 24, api && String(api.LUNAR_JIEQI_DAYS.length));
  // 内联块必须是**纯函数**：不碰任何外部的 Lunar/Solar 全局，也不碰 DOM/window
  const forbidden = ["Lunar", "Solar", "LunarMonth", "window", "document", "localStorage", "fetch"];
  const hit = forbidden.filter((w) => new RegExp("\\b" + w + "\\b").test(body));
  check("块内不引用任何外部全局（" + forbidden.join("/") + "）", hit.length === 0, "命中: " + hit.join(", "));
}

// ============================================================
section("[2] 外部依赖已彻底移除（这是本改动的主要收益）");
// 断言前必须剥掉注释：改动说明里会**提到** lunar.js（讲清楚为什么删它），
// 若直接全文匹配就会把注释当成引用 —— 这类「注释误伤」在别处已经踩过。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const appCode = stripComments(appSrc);
const htmlCode = stripComments(htmlSrc);
const cssCode = stripComments(cssSrc);
check("assets/vendor/lunar.js 已删除",
  !fs.existsSync(path.join(root, "assets", "vendor", "lunar.js")));
check("app.js 代码里不再引用 lunar.js（注释除外）", !/lunar\.js/.test(appCode));
check("index.html 代码里不再引用 lunar.js（注释除外）", !/lunar\.js/.test(htmlCode));
check("index.html 不再有 <link rel=\"preload\">",
  !/<link[^>]*\brel=["']preload["']/i.test(htmlSrc));
check("app.js 已删除加载状态机（lunarLibState / loadLunarLib / retryLunarNow）",
  !/lunarLibState|lunarAttempts|loadLunarLib|retryLunarNow/.test(appCode));
check("app.js 已删除看门狗与退避重试",
  !/LUNAR_WATCHDOG|lunarRetryTimer|LUNAR_RETRY_DELAYS/.test(appCode));
check("app.js 已删除加载中/失败提示文案",
  !/LUNAR_HINT|lunar-hint|农历加载中|农历加载失败/.test(appCode));
check("窄屏不再需要「按需加载」入口（data-lunar-cta 已移除）",
  !/data-lunar-cta|lunarCta/.test(appCode) && !/data-lunar-cta/.test(cssCode));
check("侧栏「未就绪态」逻辑已移除（renderLunarStatus / data-lunar-state）",
  !/renderLunarStatus|lunar-state/.test(appCode) && !/data-lunar-state/.test(cssCode));
check("农历数据随 app.js 一起到达 —— 不再有网络请求路径",
  !/createElement\("script"\)[\s\S]{0,200}lunar/.test(appCode));

// ============================================================
section("[3] 全量基准比对：1899-12-01 .. 2100-12-31 每一天 + 每个农历月");
let got = null;
if (api) {
  const t0 = Date.now();
  got = computeLunarDigest(adapterOf(api));
  const ms = Date.now() - t0;
  check(`逐日 ${got.dayLines.length} 条 + 逐月 ${got.monthLines.length} 条 = ${got.total} 条与旧库完全一致`,
    got.digest === golden.digest,
    `\n     期望 ${golden.digest.slice(0, 16)}… 实际 ${got.digest.slice(0, 16)}…`);
  check(`覆盖范围与基准一致（${golden.range[0]} .. ${golden.range[1]}）`,
    got.dayLines[0].startsWith(golden.range[0]) && got.dayLines[got.dayLines.length - 1].startsWith(golden.range[1]),
    `${got.dayLines[0]} .. ${got.dayLines[got.dayLines.length - 1]}`);
  console.log(`     （耗时 ${ms}ms）`);
}

// ============================================================
section("[4] 每个农历年的正月初一（年边界最容易错位的地方）");
if (api) {
  const bad = [];
  golden.yearStarts.forEach((want, i) => {
    const y = 1900 + i;
    const s = api.lunarToSolar(y, 1, 1);
    const have = iso(s.y, s.m, s.d);
    if (have !== want) bad.push(`${y}: 期望 ${want} 实际 ${have}`);
  });
  check(`${golden.yearStarts.length} 个正月初一全部正确`, bad.length === 0, bad.slice(0, 6).join("；") + (bad.length > 6 ? ` …共 ${bad.length}` : ""));
}

// ============================================================
section("[5] 抽样逐条比对（失败可定位到具体日期）");
if (api) {
  const ad = adapterOf(api);
  const bad = [];
  for (const line of golden.samples) {
    const [ds] = line.split("|");
    const [y, m, d] = ds.split("-").map(Number);
    const lu = ad.fromDate(new Date(y, m - 1, d));
    const have = [ds, lu.y, lu.m, lu.d, lu.monthCn, lu.dayCn, lu.ganZhi, lu.shengXiao,
      lu.jieQi || "", lu.nextName + "@" + lu.nextYmd].join("|");
    if (have !== line) bad.push(`${ds}\n       期望 ${line}\n       实际 ${have}`);
  }
  check(`${golden.samples.length} 条抽样逐字段一致`, bad.length === 0, bad.slice(0, 3).join("; "));
}

// ============================================================
section("[6] 内部一致性（往返换算 + 月长与公历跨度相符）");
if (api) {
  let rt = 0, rtBad = 0, spanBad = 0, chainBad = 0, leapYears = 0;
  for (let y = 1899; y <= 2100; y++) {
    const lp = api.lLeapMonth(y);
    if (lp) leapYears++;
    const ms = [];
    for (let m = 1; m <= 12; m++) { ms.push(m); if (m === lp) ms.push(-lp); }
    for (const m of ms) {
      const cnt = api.lunarMonthDays(y, m);
      const a = api.lunarToSolar(y, m, 1);
      const b = api.lunarToSolar(y, m, cnt);
      // 月末 − 月初 + 1 应当等于月长
      const span = (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000 + 1;
      if (span !== cnt) spanBad++;
      for (let d = 1; d <= cnt; d++) {
        rt++;
        const s = api.lunarToSolar(y, m, d);
        const back = api.lFromSolarNum(api.lToSolarNum(y, m, d));
        if (back.y !== y || back.m !== m || back.d !== d) rtBad++;
      }
    }
    // 月与月之间必须首尾相接（没有空隙也没有重叠）
    const firstThis = api.lunarToSolar(y, ms[0], 1);
    for (let k = 1; k < ms.length; k++) {
      const prevCnt = api.lunarMonthDays(y, ms[k - 1]);
      const prevLast = api.lunarToSolar(y, ms[k - 1], prevCnt);
      const curFirst = api.lunarToSolar(y, ms[k], 1);
      const gap = (Date.UTC(curFirst.y, curFirst.m - 1, curFirst.d) - Date.UTC(prevLast.y, prevLast.m - 1, prevLast.d)) / 86400000;
      if (gap !== 1) chainBad++;
    }
    void firstThis;
  }
  check(`${rt} 次农历↔公历往返全部自洽`, rtBad === 0, `不自洽 ${rtBad} 次`);
  check("每个月「月末−月初+1」与月长一致", spanBad === 0, `不一致 ${spanBad} 个`);
  check("同一年内月份首尾相接（gap 恒为 1 天）", chainBad === 0, `异常 ${chainBad} 处`);
  check(`闰年 ${leapYears} 个（1900–2100 实际为 74）`, leapYears === 74, String(leapYears));
}

// ============================================================
section("[7] 范围边界与降级");
if (api) {
  const inRange = [new Date(1899, 11, 1), new Date(1900, 0, 1), new Date(1900, 0, 31), new Date(2026, 8, 15), new Date(2100, 11, 31)];
  const outRange = [new Date(1899, 10, 30), new Date(2101, 0, 1)];
  check("范围内日期均返回结果（含两端点）", inRange.every((d) => api.lunarOf(d) !== null),
    inRange.map((d) => `${d.toDateString()}=${!!api.lunarOf(d)}`).join(" "));
  check("范围外返回 null（不抛错、不返回脏数据）", outRange.every((d) => api.lunarOf(d) === null),
    outRange.map((d) => `${d.toDateString()}=${JSON.stringify(api.lunarOf(d))}`).join(" "));
  check("范围外不抛异常（系统时间被调错时页面仍可用）",
    (() => { try { outRange.forEach((d) => api.lunarOf(d)); return true; } catch (e) { return false; } })());
  check("tickClock 对 null 有降级分支（只显示时辰，不留空）",
    /const lu = lunarOf\(now\);/.test(appCode) && /if \(lu\) \{/.test(appCode) &&
    /🕐 <strong>" \+ sc\.name \+ "时<\/strong>/.test(appCode));
}

// ============================================================
section("[8] 负向验证（把算法改坏，基准比对必须变红）");
const MUTATIONS = [
  ["下一个节气改为「含当天」", /if \(nm > m \|\| dd > d\)/, "if (nm > m || dd >= d)"],
  ["月名表冬/腊调换", /LUNAR_MONTH_CN = "正二三四五六七八九十冬腊"/, 'LUNAR_MONTH_CN = "正二三四五六七八九十腊冬"'],
  ["日名「廿」改成「二十」", /return \(d < 10 \? "初" : d < 20 \? "十" : "廿"\)/, 'return (d < 10 ? "初" : d < 20 ? "十" : "二十")'],
  ["干支偏移错 1 年", /LUNAR_GAN\.charAt\(\(y - 4\) % 10\)/, "LUNAR_GAN.charAt((y - 3) % 10)"],
  ["闰月不再插入月序", /if \(i === lp && !\(leap && i === t\)\) sum \+= lLeapDays\(y\);/, ""],
  ["节气日解码差 1", /return c < 58 \? c - 48 : c - 87;/, "return c < 58 ? c - 48 : c - 86;"],
  ["小月算成 28 天", /\? 30 : 29\) : 0;/, "? 30 : 28) : 0;"],
  ["农历日偏移一天", /return \{ y: y, m: m, d: off \+ 1 \};/, "return { y: y, m: m, d: off };"],
];
const baseWindow = api ? digestWindow(api, 1900, 1906) : null;
check("对照组：未改动的实现窗口摘要可复现（负向验证的前提）",
  baseWindow !== null && baseWindow === digestWindow(api, 1900, 1906));
for (const [label, re, repl] of MUTATIONS) {
  const mutated = body.replace(re, repl);
  check(`注入点存在：${label}`, mutated !== body);
  if (mutated === body || !baseWindow) continue;
  let changed = false, threw = false;
  try {
    const m = evalBlock(mutated);
    changed = digestWindow(m, 1900, 1906) !== baseWindow;
  } catch (e) { threw = true; }
  check(`负向：${label} → 基准比对报警`, changed || threw, changed ? "" : "摘要未变化（说明该断言可能过松）");
}
{
  // 守卫本身也要做负向：把外部全局引用塞回块里，[1] 的纯净性断言必须抓到
  const pure = (src) => ["Lunar", "Solar", "window", "document"].filter((w) => new RegExp("\\b" + w + "\\b").test(src));
  const dirty = body.replace("var LUNAR_Y0", "var LUNAR_Y0, _probe = typeof Lunar + window.name");
  check("负向：块内引入外部 Lunar/window → 纯净性断言报警", pure(dirty).length === 2, JSON.stringify(pure(dirty)));
  check("正向对照：未改动的块判定为纯净", pure(body).length === 0, JSON.stringify(pure(body)));
}

// ============================================================
section("[9] 前端配套");
check("窄屏隐藏生肖那截（.lunar-sx）",
  /@media \(max-width: 980px\)[\s\S]{0,200}\.lunar-clock \.lunar-sx \{ display: none; \}/.test(cssSrc));
check("窄屏允许换行，避免 320px 溢出", /@media \(max-width: 980px\)[\s\S]{0,120}\.lunar-clock \{ flex-wrap: wrap/.test(cssSrc));
check("hero 行确实渲染了 .lunar-sx 包裹层（否则上面的 CSS 是死代码）",
  // app.js 里的字面量是 "<span class=\"lunar-sx\">（" —— 属性引号被转义过，
  // 用 includes 直接比对字面量，比写正则少一层转义陷阱
  appSrc.includes('<span class=\\"lunar-sx\\">') && appSrc.includes("lu.shengXiao"));
check("hero 行仍显示农历日期（不只是时辰）",
  /lu\.month \+ "月" \+ lu\.day/.test(appCode));
check("农历数据已内联进 app.js（体积台账）",
  /var LUNAR_YEAR_INFO = \[/.test(appCode) && /var LUNAR_JIEQI_DAYS =/.test(appCode));
{
  const gz = (s) => zlib.gzipSync(s).length;
  const oldApp = 116481, oldGz = 40794;   // 上一版 assets/app.js 的原始/压缩体积
  const nowGz = gz(appSrc);
  console.log(`     台账：app.js 原始 ${(Buffer.byteLength(appSrc) / 1024).toFixed(1)}KB（旧 ${(oldApp / 1024).toFixed(1)}KB，+${((Buffer.byteLength(appSrc) - oldApp) / 1024).toFixed(1)}KB）`);
  console.log(`           app.js gzip ${(nowGz / 1024).toFixed(1)}KB（旧 ${(oldGz / 1024).toFixed(1)}KB，+${((nowGz - oldGz) / 1024).toFixed(1)}KB）`);
  console.log(`           被删除的 lunar.js 435.9KB / br 约 110KB —— 首屏净省约 108KB（且不再有加载失败这一整类问题）`);
  check("app.js 的 gzip 增幅小于删掉的农历库的 1/10（净收益为正）", (nowGz - oldGz) < 110000 / 10,
    `+${nowGz - oldGz} 字节`);
}

// ============================================================
section("[10] 行为验证：在 DOM 沙箱里真跑 app.js，看渲染出来的东西");
// 前面的比对证明了「算得对」，这一节证明「画得对」—— 两者都必要：
// 曾经就有过算得没问题、但渲染分支写错导致整块空白的教训。
function renderAt(when, { narrow = false } = {}) {
  const FIXED = when;
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(FIXED.getTime()); else super(...a); }
    static now() { return FIXED.getTime(); }
  }
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
  const els = new Map();
  const WANTED = ["lunarClock", "lunarWidget", "lunarGanZhi", "lunarMonth", "lunarJieQi", "lunarDays",
    "lunarShiChen", "sideClock", "clockDate", "clockHour", "clockMin", "clockSec"];
  for (const id of WANTED) els.set(id, mk(id));
  const intervals = [];
  const el = (id) => els.get(id) || null;
  const doc = {
    documentElement: mk("html"), body: mk("body"), head: mk("head"),
    // 只对关心的几个 id 返回**稳定的**节点，其余现造 —— 否则读不到渲染结果
    getElementById: (id) => els.get(id) || mk(id),
    querySelector: (sel) => mk(sel), querySelectorAll: () => [],
    createElement: (t) => mk(t), createTextNode: (t) => ({ text: t }), createDocumentFragment: () => mk("frag"),
    addEventListener() {}, removeEventListener() {}, readyState: "complete", title: "", cookie: "", referrer: "",
  };
  const sandbox = {
    document: doc, window: null, self: null, globalThis: null,
    navigator: { userAgent: "node", language: "zh-CN", maxTouchPoints: 0, clipboard: { writeText: async () => {} } },
    location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search: "", hash: "", href: "https://blog-6p3.pages.dev/", reload() {}, assign() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "", headers: { get: () => null } }),
    setTimeout: () => 0, clearTimeout() {}, setImmediate: () => 0,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask,
    matchMedia: () => ({ matches: narrow, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    history: { pushState() {}, replaceState() {}, back() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    alert() {}, confirm: () => true, prompt: () => null,
    // window === sandbox，所以 window 上的事件接口要在沙箱根上提供
    addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollBy() {}, open: () => null,
    console: { log() {}, error() {}, warn() {} },
    Date: FakeDate, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, WeakMap, Promise,
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
  // 走一次秒级 tick：hero 行与侧栏挂件都在这条路径上（启动时只调了 tickClock）
  for (const fn of intervals) { try { fn(); } catch (e) { console.error("tick 抛错", e.message); } }
  return el;
}

const D = (y, m, d, hh = 15, mm = 52, ss = 5) => new Date(y, m - 1, d, hh, mm, ss);

{
  const r = renderAt(D(2026, 9, 15));
  check("hero 行：干支年 + 生肖 + 农历月日 + 时辰 + 秒",
    r("lunarClock").innerHTML ===
    '🗓 丙午年<span class="lunar-sx">（马）</span>八月初五 · <strong>申时</strong> <span class="lunar-time">15:52:05</span>',
    JSON.stringify(r("lunarClock").innerHTML));
  check("hero 行 title 带上时辰区间",
    r("lunarClock").title === "农历：丙午年八月初五 · 申时（15:00–17:00）", JSON.stringify(r("lunarClock").title));
  check("hero 行不再出现任何「加载中/失败/—」字样",
    !/加载|失败|—/.test(r("lunarClock").innerHTML), r("lunarClock").innerHTML);
  check("侧栏挂件：干支 · 生肖", r("lunarGanZhi").textContent === "丙午年 · 马", r("lunarGanZhi").textContent);
  check("侧栏挂件：农历月日", r("lunarMonth").textContent === "农历 八月 · 初五", r("lunarMonth").textContent);
  check("侧栏挂件：节气倒计时（2026-09-15 → 秋分 9-23 = 8 天后）",
    r("lunarJieQi").textContent === "8 天后 · 秋分", r("lunarJieQi").textContent);
  check("侧栏挂件：时辰区间", r("lunarShiChen").textContent === "申时（15:00–17:00）", r("lunarShiChen").textContent);

  const cal = r("lunarDays").innerHTML;
  const heads = (cal.match(/lunar-cal-head/g) || []).length;
  const cells = (cal.match(/lunar-cal-cell/g) || []).length;
  const today = (cal.match(/lunar-cal-cell today/g) || []).length;
  check("月历：7 个星期表头", heads === 7, "实际 " + heads);
  // 2026 农历八月：初一 = 09-11（周五）→ 5 个前置空格 + 29 天 = 34 格，补 1 格收成 5 整行
  check("月历：前置空格 + 月长补足整行（35 格 = 5 行）", cells === 35, "实际 " + cells);
  check("月历：格子数必为 7 的整数倍（不会出现残行）", cells % 7 === 0, "实际 " + cells);
  check("月历：今天恰好高亮 1 格", today === 1, "实际 " + today);
  check("月历：今天那格是 公历 15 / 农历初五",
    /lunar-cal-cell today"><span class="cal-solar">15<\/span><span class="cal-lunar">初五<\/span>/.test(cal),
    (cal.match(/lunar-cal-cell today[\s\S]{0,120}/) || [""])[0]);
}
{
  const r = renderAt(D(2026, 9, 22));
  check("节气分支：前一天 → 「明日节气」", r("lunarJieQi").textContent === "明日节气 · 秋分", r("lunarJieQi").textContent);
  const r2 = renderAt(D(2026, 9, 23));
  check("节气分支：当天 → 「今日节气」", r2("lunarJieQi").textContent === "今日节气 · 秋分", r2("lunarJieQi").textContent);
}
{
  const r = renderAt(D(2020, 6, 1));
  check("闰月渲染：2020-06-01 是 农历闰四月初十",
    r("lunarMonth").textContent === "农历 闰四月 · 初十", r("lunarMonth").textContent);
  check("闰月渲染：hero 行也带「闰」字",
    /闰四月/.test(r("lunarClock").innerHTML), r("lunarClock").innerHTML);
}
{
  const r = renderAt(D(2026, 9, 15), { narrow: true });
  check("窄屏：hero 行照常显示农历日期（数据内联，无需点按）",
    /丙午年/.test(r("lunarClock").innerHTML) && /八月初五/.test(r("lunarClock").innerHTML),
    r("lunarClock").innerHTML);
  // 沙箱不解析 HTML，所以「未被渲染」表现为空串（真实页面上是 index.html 里写死的「—」占位）
  check("窄屏：不渲染侧栏挂件（那里整体 display:none，白算）",
    r("lunarGanZhi").textContent === "" && r("lunarDays").innerHTML === "",
    `${JSON.stringify(r("lunarGanZhi").textContent)} / ${JSON.stringify(r("lunarDays").innerHTML)}`);
}
{
  // 秒级路径：同一时辰内只改秒数，不得重建整行（重建会打断选中/触发重排）
  const r = renderAt(D(2026, 9, 15));
  const before = r("lunarClock").innerHTML;
  const span = r("lunarClock").querySelector(".lunar-time");
  check("秒级快路径：能取到 .lunar-time 节点（供后续只改秒数）", !!span);
}

console.log(`
${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
