// 文字 token 的对比度守护：把 --text / --text-soft / --text-faint 在**每一种可能的底色**上
// 都算一遍 WCAG 相对亮度，任何一对低于 AA(4.5:1) 就判红。
//
// 为什么需要它：2026-09-16 的分享面板审计里发现 --text-faint(#A8A095) 实测只有 2.51:1、
// --text-soft(#7A756D) 4.44:1 —— 这两个 token 是全站在用的（日期 / 元信息 / 提示文案），
// 但没有任何断言守着它们。对比度是「换算出来」的量，肉眼看不出来、改一次色就可能复发。
//
// 口径说明：
//   ① rgba 底一律**合成到该主题自己的 --bg 上**再算（弹窗那种「玻璃叠在暗遮罩上」的极端情况
//      另有 .share-panel 的专项断言，见 verify-share.mjs）。
//   ② 只断言 ≥4.5:1（AA 正常字号）。大字号门槛 3:1 不用管 —— 这三个 token 全用在小字号上。
// 用法：node scripts/verify-contrast-tokens.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

// 取一段花括号配对的函数体：用于「这一个函数里有没有做某件事」的体检。
// 不用 `/function x\(\)[\s\S]{0,N}?}/` 那种带长度上限的写法 —— N 是个会过期的代理指标
// （verify-mobile-guards 里就因为这个把 showView 误判成"未找到"）。
function fnBody(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ── 色彩换算 ──
function parseColor(v) {
  const s = String(v).trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return { rgb: [...m[1]].map((c) => parseInt(c + c, 16)), a: 1 };
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}
function over(fg, bg) {   // fg 带 alpha 合成到不透明 bg 上
  const a = fg.a;
  return fg.rgb.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
}
function chan(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function lum(rgb) { return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]); }
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── 取 token 块 ──
function tokenBlock(pred) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssSrc))) {
    if (!pred(m[1])) continue;
    const vars = {};
    // 键统一带 `--` 前缀，和 CSS 里的写法一致（少一层「记得去掉前缀」的心智负担）
    for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars["--" + d[1]] = d[2].trim();
    if (Object.keys(vars).length > 3) return { sel: m[1].trim(), vars };
  }
  return null;
}
const light = tokenBlock((sel) => /:root/.test(sel) && !/dark/.test(sel));
const dark = tokenBlock((sel) => /\[data-theme=["']dark["']\]/.test(sel));

// 可能承载文字的所有底色（含半透明的都合成一遍）
const SURFACES = ["--bg", "--bg-soft", "--surface-solid", "--surface-3", "--surface-2", "--surface", "--surface-strong"];
const TEXT_TOKENS = ["--text", "--text-soft", "--text-faint"];

function auditTheme(label, block) {
  if (!block) { check(`${label}：取到 token 块`, false, "未找到该主题的变量块"); return null; }
  const v = block.vars;
  const base = parseColor(v["--bg"]);
  if (!base) { check(`${label}：--bg 可解析`, false, String(v["--bg"])); return null; }
  const bg0 = base.a < 1 ? over(base, [255, 255, 255]) : base.rgb;   // --bg 本身不该半透明
  const eff = {};
  for (const s of SURFACES) {
    const c = parseColor(v[s] || "");
    if (c) eff[s] = c.a < 1 ? over(c, bg0) : c.rgb;
  }
  const rows = [];
  for (const t of TEXT_TOKENS) {
    const c = parseColor(v[t] || "");
    if (!c) { check(`${label}：${t} 可解析`, false, String(v[t])); continue; }
    const fg = c.a < 1 ? over(c, bg0) : c.rgb;
    for (const [s, bg] of Object.entries(eff)) {
      if (bg.join(",") === fg.join(",")) continue;
      rows.push({ text: t, on: s, ratio: contrast(fg, bg) });
    }
  }
  rows.sort((a, b) => a.ratio - b.ratio);
  const worst = rows[0];
  return { v, rows, worst };
}

const hex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

console.log("\n[1] 浅色主题：三个文字 token × 七种底色");
const L = auditTheme("浅色", light);
if (L) {
  console.log("    最苛刻的五对：");
  L.rows.slice(0, 5).forEach((r) => console.log(`      ${r.text}(${L.v[r.text]}) on ${r.on} = ${r.ratio.toFixed(2)}:1`));
  check("全部 ≥4.5:1（AA 正常字号）",
    L.rows.every((r) => r.ratio >= 4.5),
    `最差 ${L.worst.text} on ${L.worst.on} = ${L.worst.ratio.toFixed(2)}:1`);
  check("--text-faint 不再落在 --text-soft 的亮度过近（两家不该挤在一起）", (() => {
    const a = parseColor(L.v["--text-faint"]), b = parseColor(L.v["--text-soft"]);
    return a && b && lum(a.rgb) > lum(b.rgb);
  })(), "faint 应该比 soft 浅");
}

console.log("\n[2] 深色主题：同样的七个底色（亮字暗底，角色互换）");
const D = auditTheme("深色", dark);
if (D) {
  console.log("    最苛刻的五对：");
  D.rows.slice(0, 5).forEach((r) => console.log(`      ${r.text}(${D.v[r.text]}) on ${r.on} = ${r.ratio.toFixed(2)}:1`));
  check("全部 ≥4.5:1（AA 正常字号）",
    D.rows.every((r) => r.ratio >= 4.5),
    `最差 ${D.worst.text} on ${D.worst.on} = ${D.worst.ratio.toFixed(2)}:1`);
}

console.log("\n[3] 负向自检：把历史值写回去，同一批判定必须变红");
console.log("    （「断言通过」不等于「断言有效」—— 不造一次真失败就不知道它有没有在管事）");
{
  const back = (src, from, to) => src.replace(from, to);
  const oldFaint = back(cssSrc, /--text-faint:\s*#6E6860;/i, "--text-faint: #A8A095;");
  const oldSoft = back(cssSrc, /--text-soft:\s*#665F57;/i, "--text-soft: #7A756D;");
  const darkOldFaint = back(cssSrc, /--text-faint:\s*#A8A096;/i, "--text-faint: #8A837A;");
  check("变异确实改到了文件（否则下面两条是空断言）",
    oldFaint !== cssSrc && oldSoft !== cssSrc && darkOldFaint !== cssSrc,
    "replace 没命中");
  // 用同一套逻辑重算
  const worstOf = (src, pick) => {
    const save = cssSrc;
    const re = /([^{}]+)\{([^{}]*)\}/g; let m, found = null;
    while ((m = re.exec(src))) {
      if (!pick(m[1])) continue;
      const vars = {};
      for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars["--" + d[1]] = d[2].trim();
      if (Object.keys(vars).length > 3) { found = vars; break; }
    }
    if (!found) return 99;
    const bg0 = parseColor(found["--bg"]).rgb;
    let worst = 99;
    for (const s of SURFACES) {
      const c = parseColor(found[s] || ""); if (!c) continue;
      const bg = c.a < 1 ? over(c, bg0) : c.rgb;
      for (const t of TEXT_TOKENS) {
        const tc = parseColor(found[t] || ""); if (!tc) continue;
        const fg = tc.a < 1 ? over(tc, bg0) : tc.rgb;
        worst = Math.min(worst, contrast(fg, bg));
      }
    }
    void save;
    return worst;
  };
  check("浅色 --text-faint 写回 #A8A095 会判红", worstOf(oldFaint, (s) => /:root/.test(s) && !/dark/.test(s)) < 4.5);
  check("浅色 --text-soft 写回 #7A756D 会判红", worstOf(oldSoft, (s) => /:root/.test(s) && !/dark/.test(s)) < 4.5);
  check("深色 --text-faint 写回 #8A837A 会判红", worstOf(darkOldFaint, (s) => /\[data-theme=["']dark["']\]/.test(s)) < 4.5);
}

console.log("\n[4] 弹窗底色不能把它自己的小字拖到 AA 以下");
{
  // .share-panel 必须用不透明度更高的 --surface-strong：
  // 0.82 的玻璃叠在 45% 暗遮罩上，面板实际底色只有 ≈#E4E0DB，--text-faint 实测 4.19:1。
  const panelRule = (cssSrc.match(/\.share-panel\s*\{[^}]*\}/) || [""])[0];
  check(".share-panel 用 --surface-strong（不是半透明的 --surface）",
    /background:\s*var\(--surface-strong\)/.test(panelRule), panelRule.slice(0, 200));
  const strong = parseColor((light && light.vars["--surface-strong"]) || "");
  const soft = parseColor((light && light.vars["--surface"]) || "");
  check("--surface-strong 比 --surface 更不透明（否则这条修法没有意义）",
    !!strong && !!soft && strong.a > soft.a, `strong.a=${strong && strong.a} soft.a=${soft && soft.a}`);
  if (strong && soft && light) {
    // 「遮罩之后」的实际底色按**实测反解**，不靠猜：
    // .diag/share-contrast.py 在 0.82 那一版量到的面板底色是 #E4E0DB（228,224,219，text rect 的最亮像素），
    // 代入 (实测底色 − a×玻璃) / (1−a) 反解出底 = (105,101,92)。
    // 好处：模型能复现实测值（4.19:1），而不是给出一个和现实无关的乐观数字。
    const BACKDROP = [105, 101, 92];
    const faint = parseColor(light.vars["--text-faint"]).rgb;
    const panelBg = (a) => over({ rgb: [255, 251, 247], a }, BACKDROP);
    const rStrong = contrast(faint, panelBg(strong.a));
    const rSoft = contrast(faint, panelBg(soft.a));
    console.log(`      弹窗实际底色：${strong.a} ⇒ ${hex(panelBg(strong.a))}，--text-faint ${rStrong.toFixed(2)}:1`);
    console.log(`      旧写法 ${soft.a} ⇒ ${hex(panelBg(soft.a))}，--text-faint ${rSoft.toFixed(2)}:1`);
    check("模型可信：0.82 那一档能复现实测的 4.19:1（容差 0.1）",
      Math.abs(rSoft - 4.19) < 0.1, rSoft.toFixed(2));
    check("弹窗最坏底色下 --text-faint 仍 ≥4.5:1", rStrong >= 4.5, `${rStrong.toFixed(2)}:1`);
    check("负向自检：退回 0.82 必须判红", rSoft < 4.5, `${rSoft.toFixed(2)}:1`);
  }
}

console.log("\n[5] 实心强调色上的文字（登录按钮 / 筛选 chip / 顶栏当前导航 / 发布按钮都用它）");
{
  // --accent-text 是「画在实心 --accent 上」的字，跟 --text 那三档无关，必须单独算。
  // 2026-09-16 登录弹窗审计：浅色主题旧值 #FFFFFF 实测只有 2.28:1（「登录」主按钮！）。
  const onAccent = (label, block) => {
    if (!block) return;
    const t = parseColor(block.vars["--accent-text"] || "");
    const bg = parseColor(block.vars["--accent"] || "");
    if (!t || !bg) { check(`${label}：--accent-text / --accent 可解析`, false,
      `${block.vars["--accent-text"]} / ${block.vars["--accent"]}`); return; }
    const r = contrast(t.rgb, bg.rgb);
    check(`${label}：--accent-text(${block.vars["--accent-text"]}) on --accent(${block.vars["--accent"]}) = ${r.toFixed(2)}:1`,
      r >= 4.5, "实心按钮上的字也受 AA 约束");
  };
  onAccent("浅色", light);
  onAccent("深色", dark);
  if (light) {
    const rWhite = contrast(parseColor("#FFFFFF").rgb, parseColor(light.vars["--accent"]).rgb);
    check("负向自检：白字写回同一个 --accent 必须判红",
      rWhite < 4.5, `#FFFFFF on ${light.vars["--accent"]} = ${rWhite.toFixed(2)}:1`);
  }
}

console.log("\n[6] 链接色与校验提示色（同样是文字，同样要 AA）");
{
  // 链接可能落在任何面上，取该主题**最深**的浅底当最苛刻条件。
  const worstBg = (block) => {
    let worst = null;
    for (const s of SURFACES) {
      const c = parseColor(block.vars[s] || "");
      if (!c) continue;
      const bg0 = parseColor(block.vars["--bg"]);
      const rgb = c.a < 1 ? over(c, bg0.rgb) : c.rgb;
      if (!worst || lum(rgb) < lum(worst)) worst = rgb;
    }
    return worst;
  };
  const linkOnWorstBg = (label, block) => {
    if (!block) return;
    const c = parseColor(block.vars["--accent-dark"] || "");
    if (!c) { check(`${label}：--accent-dark 可解析`, false, String(block.vars["--accent-dark"])); return; }
    const bg = worstBg(block);
    const r = contrast(c.rgb, bg);
    check(`${label}：--accent-dark(${block.vars["--accent-dark"]}) 在最苛刻底色 ${hex(bg)} 上 = ${r.toFixed(2)}:1`,
      r >= 4.5, "正文链接 / 评论作者名都用它");
  };
  linkOnWorstBg("浅色", light);
  linkOnWorstBg("深色", dark);
  if (light) {
    const r = contrast(parseColor("#C77E34").rgb, worstBg(light));
    check("负向自检：链接色退回 #C77E34 必须判红", r < 4.5, `= ${r.toFixed(2)}:1`);
  }

  // .form-msg.err / .ok 是按颜色硬写在 CSS 里的（不走 token），单独把值抠出来算
  const pick = (re) => { const m = cssSrc.match(re); return m && parseColor(m[1]); };
  const errL = pick(/\.form-msg\.err\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  const okL = pick(/\.form-msg\.ok\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  const errD = pick(/\[data-theme=["']dark["']\]\s*\.form-msg\.err\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  const okD = pick(/\[data-theme=["']dark["']\]\s*\.form-msg\.ok\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  check("四条 .form-msg 颜色规则都能抠出来", !!(errL && okL && errD && okD), "正则没命中");
  if (errL && okL && light) {
    const bgL = worstBg(light);
    for (const [n, c] of [["err", errL], ["ok", okL]]) {
      const r = contrast(c.rgb, bgL);
      check(`浅色 .form-msg.${n} = ${r.toFixed(2)}:1`, r >= 4.5, "提示读不清等于没提示");
    }
    const rOld = contrast(parseColor("#D1665A").rgb, bgL);
    check("负向自检：.form-msg.err 退回 #D1665A 必须判红", rOld < 4.5, `= ${rOld.toFixed(2)}:1`);
  }
  if (errD && okD && dark) {
    // 深色下最苛刻的是**最亮**的深底（亮字暗底，底越亮对比越低）
    let bgD = null;
    for (const s of SURFACES) {
      const c = parseColor(dark.vars[s] || "");
      if (!c) continue;
      const bg0 = parseColor(dark.vars["--bg"]);
      const rgb = c.a < 1 ? over(c, bg0.rgb) : c.rgb;
      if (!bgD || lum(rgb) > lum(bgD)) bgD = rgb;
    }
    for (const [n, c] of [["err", errD], ["ok", okD]]) {
      const r = contrast(c.rgb, bgD);
      check(`深色 .form-msg.${n} = ${r.toFixed(2)}:1`, r >= 4.5, `底 ${hex(bgD)}`);
    }
  }
}

console.log("\n[7] 登录弹窗（含注册）与分享面板同源：底色、焦点、关闭按钮");
{
  // .modal 是「玻璃叠在 45% 暗遮罩上」，必须和 .share-panel 一样用 --surface-strong
  const modalRule = (cssSrc.match(/(?:^|\n)\.modal\s*\{[^}]*\}/) || [""])[0];
  check(".modal 用 --surface-strong（不是半透明的 --surface）",
    /background:\s*var\(--surface-strong\)/.test(modalRule), modalRule.slice(0, 160));
  const darkModal = (cssSrc.match(/\[data-theme=["']dark["']\]\s*\.modal-auth\s*\{[^}]*\}/) || [""])[0];
  check("深色主题下的 .modal-auth 也用 --surface-strong",
    /background:\s*var\(--surface-strong\)/.test(darkModal), darkModal.slice(0, 120));

  // P0：× 是 .auth-side 的**兄弟**，旧写法 `.auth-side .modal-close` 永不匹配，
  // 于是 ≤640px 时 .auth-side（DOM 在后、z-index 都是 auto）把 × 整块盖住 —— 手机上看不见也点不到。
  check("存在给 × 抬层级的规则，且选择器真的能命中（子选择器 / 后代选择器都行，但不能是 .auth-side 的后代）",
    /\.modal-auth\s*>\s*\.modal-close\s*\{[^}]*z-index:\s*[1-9]/.test(cssSrc),
    "未找到 `.modal-auth > .modal-close { z-index: … }`");
  check("负向自检：旧写法 `.auth-side .modal-close` 必须已移除（× 不是 .auth-side 的子元素）",
    !/\.auth-side\s+\.modal-close\s*\{/.test(cssSrc), "死代码选择器又回来了");

  // 焦点锁
  const appJs = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
  check("登录弹窗有 authFocusables（按「真的可见」过滤焦点候选）",
    /function\s+authFocusables\s*\(/.test(appJs) && /getClientRects\(\)\.length\s*>\s*0/.test(appJs));
  check("登录弹窗有 trapAuthFocus", /function\s+trapAuthFocus\s*\(/.test(appJs));
  check("焦点锁绑在弹窗的 keydown 上", /authModal\.addEventListener\(\s*["']keydown["']\s*,\s*trapAuthFocus\s*\)/.test(appJs));
  check("负向自检：去掉 keydown 绑定必须判红",
    !/authModal\.addEventListener\(\s*["']keydown["']\s*,\s*trapAuthFocus\s*\)/.test(
      appJs.replace(/authModal\.addEventListener\(\s*["']keydown["']\s*,\s*trapAuthFocus\s*\)/, "")),
    "replace 没命中");

  // ⚠️ 候选集必须按「原生可顺序聚焦」过滤 —— 这是 2026-09-16 实测踩到的坑：
  // 选择器里的 [href] 会匹配到 tabindex="-1" 的占位链接（.forgot / .social-link），
  // 它们排在 .btn-submit 之后 ⇒ last 指错人 ⇒ 回卷条件 active === last 永不成立
  // ⇒ 连按 Tab 第 7 次逃出面板（.diag/out/auth/after-390.txt）。
  // 光有 getClientRects() 那道可见性过滤挡不住它：那些链接是可见的，只是不可 Tab 达。
  //
  // ⚠️ 这条断言原来是「命中处数 === 2（shareFocusables + authFocusables）」。
  //    2026-09-17 加第三个候选集（lightboxFocusables，§七#15）时它立刻误红 ——
  //    而那个新候选集**确实**带了这道过滤。把"当时有几个"写死就是又一次拿代理指标当判据。
  //    真正的不变量是：**每一个** xxxFocusables() 都同时带「可见」和「tabIndex>=0」两道过滤；
  //    枚举出来逐个体检，将来的第四个自动被覆盖。
  const focusablesFns = [...appJs.matchAll(/function\s+(\w*Focusables)\s*\(\s*\)\s*\{/g)].map((m) => m[1]);
  const badCandidates = focusablesFns.filter((name) => {
    const body = fnBody(appJs, `function ${name}(`);
    return !body || !/el\.tabIndex\s*>=\s*0/.test(body) || !/el\.getClientRects\(\)\.length\s*>\s*0/.test(body);
  });
  check(`每个焦点候选集都按「可见 + tabIndex>=0」过滤（共 ${focusablesFns.length} 个：${focusablesFns.join(", ")}）`,
    focusablesFns.length >= 2 && badCandidates.length === 0,
    focusablesFns.length < 2
      ? `只找到 ${focusablesFns.length} 个候选集，解析方式可能已失效：${focusablesFns.join(", ")}`
      : `这些候选集缺过滤：${badCandidates.join(", ")}`);
  check("负向自检：删掉 tabIndex 过滤必须判红",
    focusablesFns.length > 0 && (() => {
      const broken = appJs.replace(/el\.tabIndex\s*>=\s*0\s*&&\s*/g, "");
      return broken !== appJs && focusablesFns.some((name) => {
        const body = fnBody(broken, `function ${name}(`);
        return !body || !/el\.tabIndex\s*>=\s*0/.test(body);
      });
    })(),
    "replace 没命中");
  check("打开弹窗时把焦点移进去", /openAuth[\s\S]{0,600}?\.focus\(\)/.test(appJs));
  check("关闭弹窗时把焦点还给触发按钮", /authReturnFocus[\s\S]{0,200}?\.focus\(\)/.test(appJs));
  check("authReturnFocus 声明在 IIFE 顶部（免得落进 TDZ，见 verify-no-tdz）",
    appJs.indexOf("let authReturnFocus") < appJs.indexOf("// ===== Markdown → HTML ====="),
    "index=" + appJs.indexOf("let authReturnFocus"));

  // dialog 命名 + × 的可访问名 + 状态播报
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const authDialog = (html.match(/<div class="modal modal-auth"[^>]*>/) || [""])[0];
  check("弹窗 dialog 有 aria-labelledby（读屏才知道进的是哪个对话框）",
    /aria-labelledby="authTitle"/.test(authDialog), authDialog);
  const authCloseTag = (html.match(/<button class="modal-close" id="authClose"[^>]*>/) || [""])[0];
  check("× 有 aria-label（否则可访问名就是一个「×」）", /aria-label="[^"]+"/.test(authCloseTag), authCloseTag);
  check("登录结果有 role=status + aria-live（读屏要播报登录失败）",
    /id="loginMsg"[^>]*role="status"[^>]*aria-live="polite"/.test(html) &&
    /id="registerMsg"[^>]*role="status"[^>]*aria-live="polite"/.test(html));

  // 死链：留着但必须是明确的禁用态
  check("第三方登录 / 忘记密码 标了 aria-disabled + tabindex=-1（点不动的东西不该进 Tab 序）",
    (html.match(/class="social-link" aria-disabled="true" tabindex="-1"/g) || []).length === 3 &&
    /class="forgot" aria-disabled="true" tabindex="-1"/.test(html));
  check("第三方登录的可访问名是有意义的（不再只是「G / ● / ✕」）",
    /aria-label="Google 登录/.test(html) && /aria-label="微博登录/.test(html) && /aria-label="X 登录/.test(html));
  check("禁用态的颜色也不低于 AA 的 token（用 --text-faint，不用 opacity 压暗）",
    /\.social-link\[aria-disabled="true"\][\s\S]{0,200}?color:\s*var\(--text-faint\)/.test(cssSrc) ||
    /\.social-link\[aria-disabled="true"\],?[\s\S]{0,200}?color:\s*var\(--text-faint\)/.test(cssSrc));

  // 触控目标 / 输入体验
  check("两个 tab 都给到 44px 高（原来 43，差 1px）", /\.tab\s*\{[^}]*min-height:\s*44px/.test(cssSrc));
  check("placeholder 颜色写死成 --text-faint（不写就走 UA 默认 #757575，实测只有 3.4:1）",
    /input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--text-faint\)/.test(cssSrc));
  check("placeholder 带 opacity:1（Firefox 默认给 placeholder 加不透明度）",
    /input::placeholder,\s*textarea::placeholder\s*\{[^}]*opacity:\s*1/.test(cssSrc));
  check("表单开了 autocomplete 语义（原来 form 上是 off，密码管理器填不了）",
    /autocomplete="username"/.test(html) && /autocomplete="current-password"/.test(html) && /autocomplete="new-password"/.test(html));
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
