// 注册表单「确认密码」的真浏览器实测（audit §十八）。
// 用法：node scripts/audit-register-form.mjs [width] [height]
//   默认测线上 https://blog-6p3.pages.dev；截图落在 .diag/out/regform/。
//
// 为什么必须真浏览器：静态断言能证明"校验写在了取 token 之前"，但答不了
//   · 点了提交之后**到底有没有发出请求**（只能从网络层看）
//   · 那格有没有被清空、焦点有没有移过去
//   · 多了一个字段之后，弹窗在手机宽度下会不会溢出、提交按钮还够不够得到
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", ".diag", "out", "regform");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BLOG_BASE || "https://blog-6p3.pages.dev";
const W = Number(process.argv[2] || 1200);
const H = Number(process.argv[3] || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}` + (detail ? `\n     实际: ${detail}` : "")); }
};

const CDP_PORT = 9861 + Math.floor(Math.random() * 60);
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));
if (!EDGE) { console.error("找不到 Edge/Chrome"); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), "edge-regform-"));
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

let pass_note = "";
try {
  const wsUrl = await connect();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const cdp = new CDP(ws);

  const reqs = [];
  cdp.on((m) => { if (m.method === "Network.requestWillBeSent") reqs.push(m.params.request.url); });

  const errors = [];
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text || "?");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    }
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
  };

  console.log(`\n视口 ${W}×${H}  目标 ${BASE}`);

  // ── 打开页面并等 app.js 就绪 ──
  await cdp.send("Page.navigate", { url: `${BASE}/?cb=${Math.random()}` });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try { if (await ev("!!window.__APP_READY__")) { ready = true; break; } } catch (_) {}
  }
  check("页面启动完成（__APP_READY__ 置位）", ready);
  if (!ready) throw new Error("页面没起来，后面的断言无意义");

  // ── 打开弹窗 → 切到注册 tab ──
  await ev(`document.getElementById("authBtn").click()`);
  await sleep(400);
  const modalOpen = await ev(`!document.getElementById("authModal").hidden`);
  check("点顶栏按钮能打开认证弹窗", modalOpen);
  await ev(`document.querySelector('.tab[data-tab="register"]').click()`);
  await sleep(400);
  const regActive = await ev(`document.getElementById("registerForm").classList.contains("active")`);
  check("能切到注册表单", regActive);

  // ── 字段与顺序 ──
  const shape = await ev(`(function(){
    var f = document.getElementById("registerForm");
    var p1 = f.querySelector('input[name="password"]');
    var p2 = f.querySelector('input[name="password2"]');
    var ts = document.getElementById("registerTurnstile");
    if (!p2) return { hasP2: false };
    var r1 = p1.getBoundingClientRect(), r2 = p2.getBoundingClientRect();
    return {
      hasP2: true,
      p2Type: p2.type, p2Required: p2.required, p2Autocomplete: p2.autocomplete,
      p2Placeholder: p2.placeholder,
      label: (p2.closest("label") ? p2.closest("label").textContent : "").trim(),
      p2Visible: p2.getClientRects().length > 0,
      p1Y: Math.round(r1.top), p2Y: Math.round(r2.top),
      p2H: Math.round(r2.height),
      p1MinLength: p1.minLength,
      tsY: ts ? Math.round(ts.getBoundingClientRect().top) : null,
      domOrderOk: !!(p1.compareDocumentPosition(p2) & Node.DOCUMENT_POSITION_FOLLOWING),
      visualOrderOk: r2.top > r1.top,
      beforeTurnstile: ts ? (p2.getBoundingClientRect().top < ts.getBoundingClientRect().top) : null,
    };
  })()`);
  check("注册表单里有确认密码框", !!shape.hasP2, JSON.stringify(shape).slice(0, 160));
  check("确认密码框是 password 类型且必填",
    shape.p2Type === "password" && shape.p2Required === true, JSON.stringify(shape));
  check("确认密码框的 label 文字是「确认密码」", /确认密码/.test(shape.label || ""), shape.label);
  check("确认密码框在页面上可见（不是 display:none / 零宽）", shape.p2Visible === true);
  check("DOM 顺序：确认密码在密码之后", shape.domOrderOk === true);
  check("视觉顺序：确认密码在密码下方", shape.visualOrderOk === true, `p1Y=${shape.p1Y} p2Y=${shape.p2Y}`);
  check("确认密码框在 Turnstile 容器之前（否则会白耗一个一次性 token）",
    shape.beforeTurnstile === true, `p2Y=${shape.p2Y} tsY=${shape.tsY}`);
  check("密码框带 minLength=6（前端先拦一次）", shape.p1MinLength === 6, String(shape.p1MinLength));
  await shot("01-register-form.png");

  // ── 行为：两次不一致时提交 ──
  const beforeBad = reqs.length;
  await ev(`(function(){
    var f = document.getElementById("registerForm");
    f.querySelector('input[name="username"]').value = "probe_regform_" + Date.now();
    f.querySelector('input[name="password"]').value = "abc123456";
    f.querySelector('input[name="password2"]').value = "abc123457";  // 故意差一个字符
    return 1;
  })()`);
  // 用 requestSubmit 而不是点按钮 —— 二者走同一条 submit 路径，但它不受按钮是否被遮挡影响
  const html5valid = await ev(`document.getElementById("registerForm").checkValidity()`);
  check("表单原生校验通过（所以下面测的是我们的 JS 校验，不是浏览器拦截）", html5valid === true);
  await ev(`document.getElementById("registerForm").requestSubmit()`);
  await sleep(1200);

  const afterSubmit = await ev(`(function(){
    var f = document.getElementById("registerForm");
    var p2 = f.querySelector('input[name="password2"]');
    var msg = document.getElementById("registerMsg");
    return {
      msg: msg ? msg.textContent : "(无)",
      msgClass: msg ? msg.className : "",
      p2Value: p2.value,
      activeIsP2: document.activeElement === p2,
      activeName: document.activeElement ? (document.activeElement.name || document.activeElement.tagName) : "(无)",
      modalStillOpen: !document.getElementById("authModal").hidden,
    };
  })()`);
  const newReqs = reqs.slice(beforeBad);
  // ⚠️ 必须限定**同源**：第一版用 /\/api\// 匹配全部 URL，于是把 Turnstile 自己向
  //    challenges.cloudflare.com 发的内部请求（路径里含 /turnstile/.../api/normal）
  //    也算了进来 —— 一条**假故障**。第三方域名不是我们发的请求。
  const sameOriginApi = (u) => {
    try {
      const x = new URL(u);
      return x.origin === new URL(BASE).origin && x.pathname.startsWith("/api/");
    } catch (_) { return false; }
  };
  const hitRegister = newReqs.filter((u) => sameOriginApi(u) && /^\/api\/register/.test(new URL(u).pathname));
  const hitAnyApi = newReqs.filter(sameOriginApi);
  const thirdParty = newReqs.filter((u) => !sameOriginApi(u) && /\/api\//.test(u));

  // ── 方法自证：这个过滤器**确实能**捕获同源 /api/ 请求，否则下面那条判据是恒绿的摆设 ──
  const allSameOriginApi = reqs.filter(sameOriginApi).map((u) => new URL(u).pathname);
  check("方法自证：同源 /api/ 过滤器确实抓得到请求（否则「一个都没发」恒真）",
    allSameOriginApi.length > 0,
    `全程捕获 ${allSameOriginApi.length} 条：${[...new Set(allSameOriginApi)].join(", ")}`);
  if (thirdParty.length) {
    console.log(`     ℹ️ 另有 ${thirdParty.length} 条第三方 /api/ 路径请求被正确排除（Turnstile 内部，非本站）：${new URL(thirdParty[0]).origin}`);
  }

  check("不一致时给出明确提示", /不一致/.test(afterSubmit.msg || ""), JSON.stringify(afterSubmit.msg));
  check("提示是错误样式（.form-msg.err）", /err/.test(afterSubmit.msgClass || ""), afterSubmit.msgClass);
  // 🔴 核心：不一致必须在**取 token 之前**就被拦下 —— 表现为一个（同源）请求都不发
  check("不一致时**一个本站 /api/ 请求都没有发出**（证明校验抢在取 token 之前）",
    hitAnyApi.length === 0, `发了：${hitAnyApi.join(" , ") || "（无）"}`);
  check("不一致时没有打 /api/register", hitRegister.length === 0, hitRegister.join(" , "));
  check("第二格被清空（让用户直接重输）", afterSubmit.p2Value === "", JSON.stringify(afterSubmit.p2Value));
  check("焦点自动移到第二格", afterSubmit.activeIsP2 === true, `当前焦点：${afterSubmit.activeName}`);
  check("弹窗没有被误关（用户不用重新打开）", afterSubmit.modalStillOpen === true);
  await shot("02-mismatch.png");

  // ── 页面上不该有 JS 报错 ──
  const realErrors = errors.filter((e) => !/turnstile|challenge|110200|Failed to load resource/i.test(e));
  check("过程中没有非预期 JS 报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  // ── 窄屏布局：多了一个字段之后，弹窗还能不能正常用 ──
  if (W < 600) {
    const layout = await ev(`(function(){
      var f = document.getElementById("registerForm");
      var btn = f.querySelector('button[type="submit"]');
      var mask = document.getElementById("authModal");
      var inps = Array.prototype.slice.call(f.querySelectorAll("input")).filter(function(i){
        // ⚠️ 必须滤掉 Turnstile 注入的隐藏 input（type=hidden，高度 0）——
        //    第一版没滤，量出 [43,43,43,43,0] 里那个 0 就是它，白白多一条假失败。
        return i.type !== "hidden" && i.getClientRects().length > 0;
      });
      return {
        maskScrollable: mask.scrollHeight > mask.clientHeight,
        maskScrollH: mask.scrollHeight, maskClientH: mask.clientHeight,
        inputHeights: inps.map(function(i){ return Math.round(i.getBoundingClientRect().height); }),
        inputOverflowsX: inps.some(function(i){ var r = i.getBoundingClientRect(); return r.left < -1 || r.right > window.innerWidth + 1; }),
        formTop: Math.round(f.getBoundingClientRect().top),
        btnText: btn ? btn.textContent.trim() : "(无按钮)",
      };
    })()`);
    check("窄屏下输入框触控高度 ≥ 44px（移动端可用性底线）",
      layout.inputHeights.length > 0 && layout.inputHeights.every((h) => h >= 44),
      JSON.stringify(layout.inputHeights));
    check("窄屏下输入框没有横向溢出视口", layout.inputOverflowsX === false);
    check("窄屏下弹窗是纵向可滚动的（字段变多也不会被裁掉）",
      layout.maskScrollable === true || layout.maskScrollH <= layout.maskClientH,
      `scrollHeight=${layout.maskScrollH} clientHeight=${layout.maskClientH}`);

    // 真的滚到底，确认提交按钮能到达
    await ev(`(function(){ var m = document.getElementById("authModal"); m.scrollTop = m.scrollHeight; return 1; })()`);
    await sleep(400);
    const reach = await ev(`(function(){
      var btn = document.getElementById("registerForm").querySelector('button[type="submit"]');
      var r = btn.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
    })()`);
    check("滚到底后提交按钮完整可见（够得到）", reach.visible === true, JSON.stringify(reach));
    await shot("03-mobile-bottom.png");
    await ev(`(function(){ document.getElementById("authModal").scrollTop = 0; return 1; })()`);
    await sleep(300);
    await shot("04-mobile-top.png");
  }

  console.log(`\n${"─".repeat(56)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  console.log(`截图：${OUT}`);
  ws.close();
} catch (e) {
  console.error("探针异常中断：" + e.message);
  fail++;
} finally {
  try { child.kill(); } catch (_) {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

process.exit(fail ? 1 : 0);
