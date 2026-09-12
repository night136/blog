// 冒烟测试：用最小 DOM stub 执行 app.js，捕获顶层执行路径上的引用错误（如 TDZ）
// 背景：曾经因 let 的暂时性死区导致脚本在第 1475 行中断，整站文章/组件都不加载。
// 用法：node scripts/smoke-app.mjs [可选:要检查的 js 文件路径]
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 默认检查 assets/app.js，路径基于脚本自身位置解析，任意 cwd 都可运行
const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, "..", "assets", "app.js");
const code = fs.readFileSync(target, "utf8");

function makeEl(tag = "div") {
  const el = {
    tagName: tag, style: {}, dataset: {}, attrs: {},
    children: [], childNodes: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: "", textContent: "", value: "", href: "", src: "", alt: "",
    hidden: false, disabled: false, checked: false, maxLength: 0,
    selectionStart: 0, selectionEnd: 0, offsetTop: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0,
    firstChild: null, lastChild: null, parentNode: null, nextSibling: null, previousSibling: null,
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    append(c) { this.children.push(c); },
    prepend(c) { this.children.unshift(c); },
    insertAdjacentHTML() {}, insertBefore(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute() {}, hasAttribute: () => false,
    setSelectionRange() {}, focus() {}, blur() {}, click() {}, submit() {}, reset() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 }),
    scrollIntoView() {}, scrollTo() {}, animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    dispatchEvent: () => true, contains: () => false, cloneNode: () => makeEl(tag),
    getContext: () => null, insertAdjacentElement() {}, after() {}, before() {},
  };
  return el;
}

// 返回 stub 元素（而不是 null），让代码能继续执行到更深路径，暴露更多引用问题
const documentStub = {
  documentElement: makeEl("html"), body: makeEl("body"), head: makeEl("head"),
  getElementById: (id) => makeEl("div#" + id),
  querySelector: (sel) => makeEl("el" + sel),
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t), createTextNode: (t) => ({ text: t }),
  createDocumentFragment: () => makeEl("fragment"),
  addEventListener() {}, removeEventListener() {},
  readyState: "complete", title: "", cookie: "", referrer: "",
};

// ⚠️ 定时器登记：app.js 里有 2 个常驻 setInterval（农历挂件 + 侧边圆盘钟，每秒一次）。
// 若把原生 setInterval 直接注入沙箱，事件循环永不排空 —— 脚本输出全部结果后仍不退出，
// 表现为「回归任务一直运行」（曾挂着 10h+）。这里统一登记，跑完在末尾清掉。
const liveIntervals = new Set();
const rawSetInterval = globalThis.setInterval;
const rawClearInterval = globalThis.clearInterval;

const sandbox = {
  document: documentStub,
  navigator: { userAgent: "node", clipboard: { writeText() {} }, language: "zh-CN", maxTouchPoints: 0 },
  location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search: "", hash: "", href: "https://blog-6p3.pages.dev/", reload() {}, assign() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "", headers: { get: () => null } }),
  setTimeout, clearTimeout, setImmediate,
  setInterval: (fn, ms, ...rest) => {
    const id = rawSetInterval(fn, ms, ...rest);
    liveIntervals.add(id);
    return id;
  },
  clearInterval: (id) => {
    liveIntervals.delete(id);
    return rawClearInterval(id);
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
  queueMicrotask,
  alert() {}, confirm: () => true, prompt: () => null,
  console, Buffer, process,
  Event: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
  CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  history: { pushState() {}, replaceState() {}, back() {} },
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
  crypto: { randomUUID: () => "uuid", getRandomValues: (a) => a },
  performance: { now: () => Date.now() },
  caches: { default: { match: async () => null, put: async () => {} } },
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  scrollTo() {}, addEventListener() {}, removeEventListener() {},
  Intl, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, WeakMap, Promise, RegExp, Error, TypeError, Symbol, BigInt, Function, Proxy, Reflect, ArrayBuffer, Uint8Array, Float64Array,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// 捕获异步路径逃出的错误（async 函数里的异常）
let asyncErr = null;
let hardFail = false; // 出现真引用错误 → 以非 0 退出码结束，方便 CI / 回归串起来判断
const isRefError = (e) => e instanceof ReferenceError || /is not defined|before initialization/.test((e && e.message) || "");
process.on("unhandledRejection", (e) => { asyncErr = e; });
process.on("uncaughtException", (e) => { asyncErr = e; });

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "app.js" });
  console.log("✅ app.js 顶层同步执行通过：无 ReferenceError / TDZ 中断");
} catch (e) {
  if (isRefError(e)) {
    hardFail = true;
    console.log("❌ 引用错误（真 bug）：" + e.constructor.name + ": " + e.message);
    console.log((e.stack || "").split("\n").slice(0, 8).join("\n"));
  } else {
    console.log("⚠️  其他错误（可能是 stub 不完整导致，需人工判断）：" + e.constructor.name + ": " + e.message);
    console.log((e.stack || "").split("\n").slice(0, 8).join("\n"));
  }
}
// 等一拍，让 async 路径跑完，检查是否有引用错误
await new Promise((r) => setTimeout(r, 300));
if (asyncErr) {
  const e = asyncErr;
  const isRef = isRefError(e);
  if (isRef) hardFail = true;
  console.log((isRef ? "❌ 异步路径引用错误（真 bug）：" : "⚠️  异步路径其他错误：") + (e && e.constructor ? e.constructor.name : "") + ": " + (e && e.message));
  console.log(((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
} else {
  console.log("✅ 异步路径（loadPosts / 组件初始化等）也未出现引用错误");
}

// 收尾：清掉沙箱内注册的常驻定时器，否则 Node 事件循环永不排空、进程不会退出
for (const id of liveIntervals) rawClearInterval(id);
liveIntervals.clear();

// 兜底看门狗：万一 app.js 将来又引入别的常驻句柄（长连接 / 递归定时器等），
// 也保证脚本在 15s 内退出，绝不会再变成「跑一整天」的僵尸任务。
setTimeout(() => {
  console.log("⚠️  冒烟测试超时兜底触发（仍有未释放的句柄），强制退出");
  process.exit(hardFail ? 1 : 0);
}, 15000).unref();

process.exit(hardFail ? 1 : 0);
