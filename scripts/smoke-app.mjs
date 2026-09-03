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

const sandbox = {
  document: documentStub,
  navigator: { userAgent: "node", clipboard: { writeText() {} }, language: "zh-CN", maxTouchPoints: 0 },
  location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search: "", hash: "", href: "https://blog-6p3.pages.dev/", reload() {}, assign() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "", headers: { get: () => null } }),
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
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
process.on("unhandledRejection", (e) => { asyncErr = e; });
process.on("uncaughtException", (e) => { asyncErr = e; });

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "app.js" });
  console.log("✅ app.js 顶层同步执行通过：无 ReferenceError / TDZ 中断");
} catch (e) {
  if (e instanceof ReferenceError || /is not defined|before initialization/.test(e.message)) {
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
  const isRef = e instanceof ReferenceError || /is not defined|before initialization/.test(e.message || "");
  console.log((isRef ? "❌ 异步路径引用错误（真 bug）：" : "⚠️  异步路径其他错误：") + (e && e.constructor ? e.constructor.name : "") + ": " + (e && e.message));
  console.log(((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
} else {
  console.log("✅ 异步路径（loadPosts / 组件初始化等）也未出现引用错误");
}
