// 运行时行为验证：真跑一遍 app.js，断言农历库的加载时机。
// 这是对「窄屏不白下载 426KB」的**行为级**验证，不只是源码 grep。
// 用法：node scripts/verify-lunar-boot.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const code = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// 在沙箱里跑一次 app.js，返回观测结果
function boot({ narrow, clickLunar }) {
  const appended = [];      // 记录被 append 到 head 的 script
  const byId = new Map();   // id -> 元素桩（可读 innerHTML / dataset）
  const listeners = new Map(); // id -> { click: [fn] }

  function makeEl(tag = "div") {
    const el = {
      tagName: tag, style: {}, dataset: {}, attrs: {},
      children: [], childNodes: [], src: "", alt: "", value: "", hidden: false, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      _html: "", textContent: "", title: "",
      addEventListener(type, fn) { const k = this._id || "anon"; if (!listeners.has(k)) listeners.set(k, {}); (listeners.get(k)[type] ||= []).push(fn); },
      removeEventListener() {},
      appendChild(c) { this.children.push(c); appended.push(c); return c; },
      append(c) { this.children.push(c); appended.push(c); },
      prepend(c) { this.children.unshift(c); },
      insertAdjacentHTML() {}, insertBefore(c) { return c; }, removeChild() {}, remove() {}, replaceChildren() {},
      querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; }, hasAttribute: () => false,
      setSelectionRange() {}, focus() {}, blur() {}, click() { fire(this._id, "click"); }, submit() {}, reset() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 }),
      scrollIntoView() {}, scrollTo() {}, animate: () => ({ finished: Promise.resolve(), cancel() {} }),
      dispatchEvent: () => true, contains: () => false, cloneNode: () => makeEl(tag),
      getContext: () => null, insertAdjacentElement() {}, after() {}, before() {},
      offsetParent: null, offsetTop: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0,
      firstChild: null, lastChild: null, parentNode: null, nextSibling: null, previousSibling: null,
      selectionStart: 0, selectionEnd: 0, maxLength: 0, checked: false,
    };
    Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; }, enumerable: true });
    return el;
  }
  function fire(id, type) { const m = listeners.get(id); if (m && m[type]) m[type].forEach((f) => f({})); }

  const documentStub = {
    documentElement: makeEl("html"), body: makeEl("body"), head: makeEl("head"),
    getElementById(id) { if (!byId.has(id)) { const e = makeEl("div"); e._id = id; byId.set(id, e); } return byId.get(id); },
    querySelector: (sel) => { const e = makeEl("el"); e._id = "sel" + sel; return e; },
    querySelectorAll: () => [],
    createElement: (t) => { const e = makeEl(t); if (t === "script") e.tagName = "script"; return e; },
    createTextNode: (t) => ({ text: t }),
    createDocumentFragment: () => makeEl("fragment"),
    addEventListener() {}, removeEventListener() {},
    readyState: "complete", title: "", cookie: "", referrer: "",
  };

  const liveIntervals = [];
  const sandbox = {
    document: documentStub,
    navigator: { userAgent: "node", clipboard: { writeText() {} }, language: "zh-CN", maxTouchPoints: 5 },
    location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search: "", hash: "", href: "https://blog-6p3.pages.dev/", reload() {}, assign() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "", headers: { get: () => null } }),
    setTimeout, clearTimeout, setImmediate,
    setInterval: (fn, ms) => { liveIntervals.push(ms); return 0; },   // 不真跑，只记录周期
    clearInterval: () => {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
    queueMicrotask,
    alert() {}, confirm: () => true, prompt: () => null,
    console, Buffer, process,
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    matchMedia: () => ({ matches: narrow, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    history: { pushState() {}, replaceState() {}, back() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    crypto: { randomUUID: () => "uuid", getRandomValues: (a) => a },
    performance: { now: () => Date.now() },
    caches: { default: { match: async () => null, put: async () => {} } },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    scrollTo() {}, addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn({ didTimeout: false }); return 1; },
    Intl, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, WeakMap, Promise, RegExp, Error, TypeError, Symbol, BigInt, Function, Proxy, Reflect, ArrayBuffer, Uint8Array, Float64Array,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "app.js" });
  if (clickLunar) fire("lunarClock", "click");

  return {
    lunarRequests: appended.filter((s) => String(s.src || "").includes("lunar.js")).length,
    heroHtml: documentStub.getElementById("lunarClock").innerHTML,
    heroCta: documentStub.getElementById("lunarClock").dataset.lunarCta,
    intervals: liveIntervals,
  };
}

console.log("\n[1] 窄屏（≤980px）：不得自动下载农历库，但仍显示有用的时辰 + 时间");
{
  const r = boot({ narrow: true });
  check("未注入 lunar.js", r.lunarRequests === 0, "实际请求次数=" + r.lunarRequests);
  check("hero 行显示时辰与时间（不是无意义的占位）",
    /时/.test(r.heroHtml) && /\d{2}:\d{2}:\d{2}/.test(r.heroHtml), r.heroHtml);
  check("hero 行给出「查农历」入口", /lunar-hint/.test(r.heroHtml), r.heroHtml);
  check("hero 行标记为可点击（data-lunar-cta=1）", r.heroCta === "1", "实际=" + r.heroCta);
}

console.log("\n[2] 窄屏点击后：才加载农历库");
{
  const r = boot({ narrow: true, clickLunar: true });
  check("点击后注入 lunar.js", r.lunarRequests === 1, "实际请求次数=" + r.lunarRequests);
}

console.log("\n[3] 宽屏（>980px）：保持自动加载（右侧栏需要它）");
{
  const r = boot({ narrow: false });
  check("自动注入 lunar.js", r.lunarRequests === 1, "实际请求次数=" + r.lunarRequests);
  check("hero 行未显示「查农历」入口（库会自己加载好）",
    !/lunar-hint/.test(r.heroHtml), r.heroHtml);
  check("hero 行此时显示公历时刻（库加载前）", /\d{2}:\d{2}:\d{2}/.test(r.heroHtml), r.heroHtml);
}

console.log("\n[4] 秒级定时器只有 1 个 1000ms（原先是 2 个，各跑两遍）");
{
  const r = boot({ narrow: false });
  const per1000 = r.intervals.filter((ms) => ms === 1000).length;
  check("只注册一个 1000ms 定时器", per1000 === 1, "实际=" + per1000 + " 个（全部周期：" + r.intervals.join(",") + "）");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
