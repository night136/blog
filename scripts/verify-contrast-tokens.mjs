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

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
