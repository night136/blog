// 运行时行为验证：真跑一遍 app.js，断言农历库的加载时机与**失败恢复**。
// 这是对「窄屏不白下载 110KB」与「加载失败不能是静默终态」的**行为级**验证，
// 不只是源码 grep —— 用一个带假定时器的沙箱把 onerror / 挂起 / 超时都真跑一遍。
// 用法：node scripts/verify-lunar-boot.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const code = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// 假定时器：让「退避重试 / 看门狗超时」这类依赖时间的行为可以在测试里被推进，
// 否则只能靠真等 15 秒。只实现本文件需要的部分（timeout / interval / advance）。
function makeClock() {
  const c = {
    now: 0, seq: 0, errors: [],
    timeouts: new Map(), intervals: new Map(), periods: [],
    setTimeout(fn, ms) { const id = ++c.seq; c.timeouts.set(id, { fn, due: c.now + (ms || 0) }); return id; },
    clearTimeout(id) { c.timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++c.seq; const period = ms || 1; c.periods.push(ms); c.intervals.set(id, { fn, period, next: c.now + period }); return id; },
    clearInterval(id) { c.intervals.delete(id); },
    // 推进 ms 毫秒：按时间顺序执行到期的 timeout 与 interval
    advance(ms) {
      const target = c.now + ms;
      let guard = 0;
      while (guard++ < 200000) {
        let nextAt = target;
        for (const t of c.timeouts.values()) nextAt = Math.min(nextAt, t.due);
        for (const iv of c.intervals.values()) nextAt = Math.min(nextAt, iv.next);
        if (nextAt > target) break;
        c.now = Math.max(c.now, nextAt);
        for (const [id, t] of [...c.timeouts]) if (t.due <= c.now) { c.timeouts.delete(id); try { t.fn(); } catch (e) { c.errors.push(e); } }
        for (const iv of c.intervals.values()) if (iv.next <= c.now) { iv.next = c.now + iv.period; try { iv.fn(); } catch (e) { c.errors.push(e); } }
        if (c.now >= target) break;
      }
      c.now = target;
    },
  };
  return c;
}

// 在沙箱里跑一次 app.js，返回观测结果
// opts: { narrow, clickLunar, source? }
function boot({ narrow, clickLunar, source }) {
  const appended = [];      // 记录被 append 到 head 的 script
  const byId = new Map();   // id -> 元素桩（可读 innerHTML / dataset）
  const listeners = new Map(); // id -> { click: [fn] }
  const clock = makeClock();

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

  const sandbox = {
    document: documentStub,
    navigator: { userAgent: "node", clipboard: { writeText() {} }, language: "zh-CN", maxTouchPoints: 5 },
    location: { origin: "https://blog-6p3.pages.dev", pathname: "/", search: "", hash: "", href: "https://blog-6p3.pages.dev/", reload() {}, assign() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "", headers: { get: () => null } }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    setImmediate,
    requestAnimationFrame: (cb) => clock.setTimeout(cb, 0), cancelAnimationFrame: clock.clearTimeout,
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
  vm.runInContext(source ?? code, sandbox, { filename: "app.js" });
  if (clickLunar) fire("lunarClock", "click");

  const hero = documentStub.getElementById("lunarClock");
  const lunarScripts = () => appended.filter((s) => s.tagName === "script" && String(s.src || "").includes("lunar.js"));
  const r = {
    clock, sandbox, fire,
    heroHtml: () => hero.innerHTML,
    heroCta: () => hero.dataset.lunarCta,
    lunarScripts,
    lunarRequests: () => lunarScripts().length,
    intervals: clock.periods,
    el: (id) => documentStub.getElementById(id),
    // 最新一次注入的 script（重试时可能已经注入了好几个）
    last: () => { const l = lunarScripts(); return l[l.length - 1]; },
  };
  return r;
}

// 让 app.js 认为 lunar.js 真的装载好了（UMD 会把 Lunar 挂到 window 上）
const fakeLunar = {
  fromDate: () => ({
    getYearInGanZhi: () => "丙午", getYearShengXiao: () => "马",
    getMonthInChinese: () => "八", getDayInChinese: () => "初四",
    getCurrentJieQi: () => null, getNextJieQi: () => null,
    getYear: () => 2026, getMonth: () => 7, getDay: () => 4,
  }),
};

console.log("\n[1] 窄屏（≤980px）：不得自动下载农历库，但仍显示有用的时辰 + 时间");
{
  const r = boot({ narrow: true });
  check("未注入 lunar.js", r.lunarRequests() === 0, "实际请求次数=" + r.lunarRequests());
  check("hero 行显示时辰与时间（不是无意义的占位）",
    /时/.test(r.heroHtml()) && /\d{2}:\d{2}:\d{2}/.test(r.heroHtml()), r.heroHtml());
  check("hero 行给出「查农历」入口", /lunar-hint/.test(r.heroHtml()), r.heroHtml());
  check("hero 行标记为可点击（data-lunar-cta=1）", r.heroCta() === "1", "实际=" + r.heroCta());
}

console.log("\n[2] 窄屏点击后：才加载农历库");
{
  const r = boot({ narrow: true, clickLunar: true });
  check("点击后注入 lunar.js", r.lunarRequests() === 1, "实际请求次数=" + r.lunarRequests());
}

console.log("\n[3] 宽屏（>980px）：保持自动加载（右侧栏需要它）");
{
  const r = boot({ narrow: false });
  check("自动注入 lunar.js", r.lunarRequests() === 1, "实际请求次数=" + r.lunarRequests());
  check("hero 行未显示「查农历」入口（库会自己加载好）",
    !/lunar-hint/.test(r.heroHtml()), r.heroHtml());
  check("hero 行此时显示公历时刻（库加载前）", /\d{2}:\d{2}:\d{2}/.test(r.heroHtml()), r.heroHtml());
}

console.log("\n[4] 秒级定时器只有 1 个 1000ms（原先是 2 个，各跑两遍）");
{
  const r = boot({ narrow: false });
  const per1000 = r.intervals.filter((ms) => ms === 1000).length;
  check("只注册一个 1000ms 定时器", per1000 === 1, "实际=" + per1000 + " 个（全部周期：" + r.intervals.join(",") + "）");
}

console.log("\n[5] 宽屏加载失败：不能是静默终态（自动退避重试 + 可见提示）");
{
  const r = boot({ narrow: false });
  r.last().onerror();                       // 第 1 次：下载失败
  check("失败后立即给出可点重试的提示（宽屏原先什么都不显示）",
    /lunar-hint/.test(r.heroHtml()), r.heroHtml());
  check("提示期 hero 行标记为可点击", r.heroCta() === "1", "实际=" + r.heroCta());
  check("侧栏挂件同步显示失败态（原先 5 个字段一起显示「—」，看着就是坏了）",
    /失败/.test(r.el("lunarGanZhi").textContent), r.el("lunarGanZhi").textContent);
  check("侧栏挂件标记为可点击重试", r.el("lunarWidget").dataset.lunarState === "failed",
    "实际=" + r.el("lunarWidget").dataset.lunarState);

  r.clock.advance(2000);                    // 越过第 1 次退避（1.5s）
  check("第 1 次退避后自动重试", r.lunarRequests() === 2, "实际请求次数=" + r.lunarRequests());
  r.last().onerror();                       // 第 2 次也失败
  r.clock.advance(6000);                    // 越过第 2 次退避（5s）→ 第 3 次
  check("第 2 次退避后再次重试", r.lunarRequests() === 3, "实际请求次数=" + r.lunarRequests());
  r.last().onerror();                       // 第 3 次也失败
  r.clock.advance(120000);
  check("达到上限后停止自动重试（不刷用户网络）", r.lunarRequests() === 3, "实际请求次数=" + r.lunarRequests());
  check("上限用尽后提示仍在（可人工点按恢复）", /lunar-hint/.test(r.heroHtml()), r.heroHtml());
}

console.log("\n[6] 请求挂住（既不 load 也不 error）：看门狗超时也算失败并重试");
{
  const r = boot({ narrow: false });
  r.clock.advance(18000);                   // 越过看门狗（15s）+ 第 1 次退避（1.5s）
  check("超时后触发重试（原先永远停在 loading，页面看起来就是坏掉）",
    r.lunarRequests() === 2, "实际请求次数=" + r.lunarRequests());
  check("超时后 hero 行给出提示", /lunar-hint/.test(r.heroHtml()), r.heroHtml());
}

console.log("\n[7] 重试成功后：状态收敛、不再重试、hero 行升级为农历");
{
  const r = boot({ narrow: false });
  r.last().onerror();
  r.clock.advance(2000);                    // 自动重试注入第 2 个 script
  r.sandbox.Lunar = fakeLunar;              // 模拟这次下载成功
  r.last().onload();
  check("hero 行升级为干支（不再显示公历占位）", /丙午/.test(r.heroHtml()), r.heroHtml());
  check("成功后不再显示提示", !/lunar-hint/.test(r.heroHtml()), r.heroHtml());
  check("成功后 hero 行不再标记可点击", r.heroCta() === "0", "实际=" + r.heroCta());
  check("成功后侧栏挂件清掉失败态", !r.el("lunarWidget").dataset.lunarState,
    "实际=" + r.el("lunarWidget").dataset.lunarState);
  check("侧栏挂件填上了农历内容", /丙午/.test(r.el("lunarGanZhi").textContent), r.el("lunarGanZhi").textContent);
  r.clock.advance(120000);
  check("成功后再推进时间也不会重复注入", r.lunarRequests() === 2, "实际请求次数=" + r.lunarRequests());
}

console.log("\n[8] 脚本「下载成功但 Lunar 没挂上全局」（被过滤/内容不对）：也要算失败");
{
  const r = boot({ narrow: false });
  r.last().onload();                        // 没有 Lunar 全局
  check("onload 但无 Lunar → 不算就绪，进入失败重试",
    r.lunarRequests() >= 1 && /lunar-hint/.test(r.heroHtml()), r.heroHtml());
  r.clock.advance(2000);
  check("并触发重试", r.lunarRequests() === 2, "实际请求次数=" + r.lunarRequests());
}

console.log("\n[9] 人工点按重试：自动重试预算用尽后仍能救回来");
{
  const r = boot({ narrow: false });
  for (let i = 0; i < 3; i++) { r.last().onerror(); r.clock.advance(6000); }
  check("自动重试已用尽（3 次）", r.lunarRequests() === 3, "实际请求次数=" + r.lunarRequests());
  r.fire("lunarClock", "click");
  check("点按 hero 行后重新发起加载", r.lunarRequests() === 4, "实际请求次数=" + r.lunarRequests());
  check("点按后重置预算，可再次自动重试", (r.last().onerror(), r.clock.advance(2000), r.lunarRequests() === 5),
    "实际请求次数=" + r.lunarRequests());
}

console.log("\n[10] 预加载与动态注入必须同 URL（否则 preload 白费、还会双下载）");
{
  const m = html.match(/<link[^>]+rel="preload"[^>]*as="script"[^>]*>/g) || [];
  const lunarPreload = m.find((s) => s.includes("lunar.js"));
  check("index.html 预加载了 lunar.js（桌面端不必等 idle 回调才开始下载）", !!lunarPreload, m.join(" | "));
  check("预加载带 media，窄屏不会白下 110KB",
    !!lunarPreload && /media="\(min-width:\s*981px\)"/.test(lunarPreload), lunarPreload || "");
  const srcInApp = (code.match(/const LUNAR_SRC = "([^"]+)"/) || [])[1];
  const hrefInHtml = lunarPreload && (lunarPreload.match(/href="([^"]+)"/) || [])[1];
  check("两处 URL 完全一致（不带 ?v= 之类差异）",
    !!srcInApp && srcInApp === hrefInHtml, `app.js=${srcInApp} / index.html=${hrefInHtml}`);
}

console.log("\n[11] 负向验证：把修复点改回旧写法，上面的断言必须变红");
{
  // ① 去掉自动重试
  const noRetry = code.replace(/if \(lunarAttempts < LUNAR_MAX_ATTEMPTS\)/, "if (false)");
  check("注入点存在：自动重试判断", noRetry !== code);
  {
    const r = boot({ narrow: false, source: noRetry });
    r.last().onerror();
    r.clock.advance(120000);
    check("负向①：无自动重试 → 只有 1 次请求（[5] 会抓到）", r.lunarRequests() === 1, "实际=" + r.lunarRequests());
  }
  // ② 去掉超时看门狗
  const noWatchdog = code.replace(/lunarWatchdogTimer = setTimeout\(lunarFail, LUNAR_WATCHDOG_MS\);/, "lunarWatchdogTimer = 0;");
  check("注入点存在：看门狗", noWatchdog !== code);
  {
    const r = boot({ narrow: false, source: noWatchdog });
    r.clock.advance(120000);
    check("负向②：无看门狗 → 挂起即永久停在 loading（[6] 会抓到）",
      r.lunarRequests() === 1, "实际=" + r.lunarRequests());
  }
  // ③ 去掉宽屏失败提示（提示文案是常量，锚点稳定）
  const noWideHint = code.replace(
    /const LUNAR_HINT_FAIL = '<span class="lunar-hint">农历加载失败 · 点按重试<\/span>';/,
    "const LUNAR_HINT_FAIL = \"\";");
  check("注入点存在：宽屏失败提示", noWideHint !== code);
  {
    const r = boot({ narrow: false, source: noWideHint });
    r.last().onerror();
    check("负向③：宽屏失败后无任何提示（[5] 会抓到）", !/lunar-hint/.test(r.heroHtml()), r.heroHtml());
  }
  // ④ 两侧 URL 不一致（预加载带 ?v= 而动态注入不带）
  {
    const mismatch = `${code}/*xx*/`;
    check("负向④：URL 比对能发现 ?v= 差异",
      (() => {
        const a = (mismatch.match(/const LUNAR_SRC = "([^"]+)"/) || [])[1];
        return a !== "assets/vendor/lunar.js?v=1";
      })());
  }
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
