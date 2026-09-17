// 样式表内联回归（build.mjs + scripts/lib/inline-css.mjs）
//
// 背景（docs/optimization-audit-2026-09-16.md §三）：
// `<link rel="stylesheet">` 是渲染阻塞资源，实测首页「HTML 到齐 → 首绘」要等 ~600ms 才等到
// 这张 108KB（br 32.9KB）的表。改成构建期把 assets/style.css **内联进 HTML 外壳**之后，
// 首绘不再等那一个跨境往返（本地真浏览器 + 限速实测 843ms → 425ms，见 docs/first-paint.md）。
//
// 这个守护盯的是**不变量**（不是实现细节）：
//   ① 构建产物里不能再有任何指向站内资源的外链样式表（否则阻塞又回来了）
//   ② 内联进去的 CSS 必须与 assets/style.css **逐字相同**（防「HTML 里是旧样式、文件是新的」）
//   ③ 内联块必须仍在 `<head>` 里、且在关键 CSS 之后（级联顺序 = 改之前的外链位置，样式表现不变）
//   ④ 幂等：连跑两次产物一致（否则每次部署都在漂）
//   ⑤ CSS 变了内联内容必须跟着变
//   ⑥ 优雅降级：源 HTML 里没有可替换的 link 时，宁可外链也不能产出没样式的页面
//   ⑦ 响亮失败：CSS 里含 `</style>` 时拒绝内联（否则正文会被吐到页面上）
//   ⑧ 仓库里的 index.html 必须仍是**外链形态**（源码单一事实来源；也保证构建没跑时行为不变）
// 外加**负向自证**：把内联那一步换成空操作，① ② 必须变红 —— 否则这个守护只是恒真的摆设。
//
// 用法：node scripts/verify-inline-css.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS } from "../functions/_lib/security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

const MARKER = '<style data-inlined="style.css">';
const INLINE_BLOCK_RE = /<style data-inlined="style\.css">\n([\s\S]*?)\n<\/style>/;
const SAME_ORIGIN_SHEET_RE = /<link[^>]+rel=["']?stylesheet["']?[^>]*href="(?!https?:)[^"]*"/i;
// ⚠️ 产物里会出现**两个** </head>：前一个在 head 里的注释文本中（讲 OG 注入点那段）。
// 用 indexOf 会拿到注释里那个，于是「内联块在 head 之前」这种假故障（踩过）。
const headEndOf = (html) => html.lastIndexOf("</head>");

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-inline-verify-"));
  fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
  fs.copyFileSync(path.join(root, "build.mjs"), path.join(tmp, "build.mjs"));
  fs.copyFileSync(path.join(root, "index.html"), path.join(tmp, "index.html"));
  const srcAssets = path.join(root, "assets");
  for (const f of fs.readdirSync(srcAssets)) {
    if (f === "uploads") continue;
    const s = path.join(srcAssets, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmp, "assets", f));
  }
  const srcLib = path.join(root, "scripts", "lib");
  fs.mkdirSync(path.join(tmp, "scripts", "lib"), { recursive: true });
  for (const f of fs.readdirSync(srcLib)) fs.copyFileSync(path.join(srcLib, f), path.join(tmp, "scripts", "lib", f));
  return tmp;
}
function build(tmp) {
  const env = { ...process.env };
  delete env.CF_ACCOUNT_ID; delete env.CF_DATABASE_ID; delete env.CF_API_TOKEN;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["build.mjs"], { cwd: tmp, env, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    // build.mjs 的 hashAssets 在 finally 里、且自己吞异常；真抛出来说明它挂了，必须看见
    out = String(e.stdout || "") + String(e.stderr || "");
    return { out, crashed: true };
  }
  return { out, crashed: false };
}
const readHtml = (tmp) => fs.readFileSync(path.join(tmp, "index.html"), "utf8");
const readCss = (tmp) => fs.readFileSync(path.join(tmp, "assets", "style.css"), "utf8");

// ── 断言集做成纯函数，好让负向自证复用同一套判据（而不是另写一套）──
function audit(html, cssText) {
  const r = [];
  const add = (name, ok, detail = "") => r.push({ name, ok, detail });

  add("产物里没有指向站内资源的外链样式表（阻塞资源已消除）",
    !SAME_ORIGIN_SHEET_RE.test(html),
    (html.match(SAME_ORIGIN_SHEET_RE) || [])[0] || "");

  const m = html.match(INLINE_BLOCK_RE);
  add("产物里有内联样式块（不是只把 link 删了）", !!m, m ? "" : "未找到 <style data-inlined=...>");

  if (m) {
    // 逐字比对：内联内容必须就是 assets/style.css 的原文
    add("内联内容与 assets/style.css 逐字相同", m[1] === cssText,
      m[1] === cssText ? "" : `内联 ${m[1].length} 字符 vs 源文件 ${cssText.length} 字符`);
    // 位置：必须在 </head> 之前，且在**关键 CSS 块之后**（级联顺序与原来的外链一致）
    const headEnd = headEndOf(html);
    const at = html.indexOf(MARKER);
    const criticalEnd = html.indexOf("</style>");
    add("内联块位于 </head> 之前的 <head> 内", at > 0 && at < headEnd, `marker@${at} head@${headEnd}`);
    add("内联块排在关键 CSS 之后（级联顺序未变）", criticalEnd > 0 && at > criticalEnd,
      `关键CSS结束@${criticalEnd} 内联块@${at}`);
    add("关键 CSS 块仍在（内联不是替换掉它）", /\.js \.card\{opacity:0\}/.test(html), "关键 CSS 特征规则不见了");
  }

  // ── CSP 白名单里的 sha256 必须命中**构建产物**里那段内联启动脚本 ──
  // 这一环只有这里能验：verify-security-headers 验的是"源码 ↔ CSP"，但真正发给浏览器的是
  // **构建产物**（build.mjs 会就地改写 index.html）。万一以后构建顺手动了那段脚本
  // （归一化换行、改个字符串……），源码与 CSP 都还是对的，线上却是白屏。
  // 所以把"产物 ↔ CSP"也钉住，整条链路才算闭合。
  //
  // ⚠️ 必须按 **LF** 归一化后再算：本仓库 core.autocrlf=true，
  //    工作区是 CRLF，而提交上去、被 CF 构建、最终发给浏览器的都是 **LF**。
  //    这里在临时目录里跑构建，产物继承工作区的 CRLF ⇒ 直接算会得到另一个哈希
  //    （第一版就是这样误红：产物 4913 字符 vs 线上 4834，差的就是那 79 个 \r）。
  {
    const lf = html.replace(/\r\n/g, "\n");
    const stripped = lf.replace(/<!--[\s\S]*?-->/g, "");
    const block = (stripped.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/) || [])[1];
    const hash = block ? "sha256-" + createHash("sha256").update(block, "utf8").digest("base64") : null;
    const rawHash = block ? "sha256-" + createHash("sha256").update(html.replace(/<!--[\s\S]*?-->/g, "").match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)?.[1] || "", "utf8").digest("base64") : null;
    const csp = SECURITY_HEADERS["Content-Security-Policy"] || "";
    add("构建产物内联脚本的哈希 == CSP 白名单里的哈希（构建不许改动那段脚本）",
      !!hash && csp.includes(hash),
      hash
        ? `产物(LF) ${hash}${rawHash && rawHash !== hash ? `；产物(原样 CRLF) ${rawHash}（差值只是行尾，说明构建确实没改内容）` : ""} 不在 CSP 里`
        : "产物里没抽到内联 <script>");
  }
  return r;
}

let tmp = null, tmpNeg = null;
try {
  // ══ 正常路径 ══
  tmp = setup();
  const cssText = readCss(tmp);
  console.log("\n[1] 构建产物的形态");
  const b1 = build(tmp);
  check("build.mjs 正常退出（内联不该弄挂构建）", !b1.crashed, b1.out.slice(-300));
  const html1 = readHtml(tmp);
  const results = audit(html1, cssText);
  for (const a of results) check(a.name, a.ok, a.detail);

  console.log("\n[2] 幂等与同步");
  const b2 = build(tmp);
  check("连跑两次产物逐字相同（部署不会每次漂）", !b2.crashed && readHtml(tmp) === html1);
  check("构建日志明确报告已内联", /样式表已内联/.test(b2.out), b2.out.trim().split("\n").slice(-2).join(" / "));
  // 改 CSS → 内联内容必须跟着变（防「内联写死成一次性拷贝」）
  fs.appendFileSync(path.join(tmp, "assets", "style.css"), "\n.inline-probe{color:#123456}\n");
  const b3 = build(tmp);
  check("CSS 变更后内联内容同步更新", !b3.crashed && readHtml(tmp).includes(".inline-probe{color:#123456}"),
    "改 style.css 后产物里没有新规则 ⇒ 内联用的是陈旧副本");

  console.log("\n[3] 优雅降级与响亮失败");
  {
    // 源 HTML 里没有可替换的样式引用：应保持外链、构建不挂、也不能把 HTML 改坏
    const before = readHtml(tmp);
    fs.writeFileSync(path.join(tmp, "index.html"), before.replace(/<style data-inlined="style\.css">[\s\S]*?<\/style>/, '<link rel="stylesheet" href="assets/style.css" />'));
    fs.writeFileSync(path.join(tmp, "index.html"), fs.readFileSync(path.join(tmp, "index.html"), "utf8").replace(/[ \t]*<link[^>]+href="assets\/style\.css(?:\?v=[a-z0-9]+)?"[^>]*>[ \t]*\r?\n?/, ""));
    const b4 = build(tmp);
    const h4 = readHtml(tmp);
    check("找不到样式引用时不内联、也不产出坏页面（保持原样）", !b4.crashed && !/<style data-inlined/.test(h4), h4.slice(0, 200));
    check("此时构建日志有明确告警（不静默）", /未内联/.test(b4.out), b4.out.trim().split("\n").slice(-2).join(" / "));
    // ⚠️ 判据要看**link 标签**，不能用 /assets\/style\.css\?v=/ 这种松散子串：
    // index.html 的注释里本来就写着「assets/style.css」（讲它为什么故意阻塞），
    // 而版本化正则会连注释里的这处一起改写 ⇒ 松散子串会数出「凭空外链了一个样式」的假故障。
    check("未内联时也不会凭空外链一个样式（源码里本来就没有）",
      !/<link[^>]+href="assets\/style\.css/.test(h4),
      (h4.match(/<link[^>]+href="assets\/style\.css[^"]*"/) || [])[0] || "");
  }
  {
    // CSS 里含 </style>：必须拒绝内联，保留外链形态（否则正文会被吐到页面上）
    fs.writeFileSync(path.join(tmp, "index.html"), fs.readFileSync(path.join(root, "index.html"), "utf8"));
    fs.appendFileSync(path.join(tmp, "assets", "style.css"), "\n/* 恶意/事故样本 */\n.x{content:'</style><script>alert(1)</script>'}\n");
    const b5 = build(tmp);
    const h5 = readHtml(tmp);
    check("CSS 含 </style> 时拒绝内联（不产出坏页面）",
      !b5.crashed && !/<style data-inlined/.test(h5) && !/<script>alert\(1\)<\/script>/.test(h5),
      "内联了危险 CSS");
    check("拒绝内联时保留外链形态（样式不会丢）", /href="assets\/style\.css\?v=[a-z0-9]+"/.test(h5));
    check("拒绝内联时构建日志有明确告警", /未内联/.test(b5.out), b5.out.trim().split("\n").slice(-1)[0]);
  }

  console.log("\n[4] 源码形态（仓库里的 index.html）");
  {
    const srcHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
    check("仓库 index.html 仍保留外链 <link>（assets/style.css 是唯一事实来源）",
      /<link rel="stylesheet" href="assets\/style\.css"[^>]*>/.test(srcHtml),
      "源码里没有外链 ⇒ 构建没跑时页面会没样式，且本地探针/其它守护读到的形态与线上不一致");
    check("仓库 index.html 里没有内联样式块（别把构建产物提交进来）",
      !srcHtml.includes(MARKER), "源码里出现了构建产物才有的内联块");
  }

  console.log("\n[5] 负向自证：把内联改成空操作，判据必须变红");
  {
    tmpNeg = setup();
    const libPath = path.join(tmpNeg, "scripts", "lib", "inline-css.mjs");
    const libSrc = fs.readFileSync(libPath, "utf8");
    const broken = libSrc.replace(
      "export function inlineStyleSheet(html, css) {",
      "export function inlineStyleSheet(html, css) { return { html, replaced: 'none' };"
    );
    if (broken === libSrc) {
      check("负向自证：成功把内联改成了空操作（造故障这一步本身必须成功）", false,
        "没匹配到目标函数签名 —— 造故障失败不等于通过");
    } else {
      fs.writeFileSync(libPath, broken);
      const nb = build(tmpNeg);
      const nHtml = readHtml(tmpNeg);
      const nRes = audit(nHtml, readCss(tmpNeg));
      const reds = nRes.filter((a) => !a.ok);
      check("负向自证：拆掉内联后，判据确实报红（守护不是恒真的摆设）",
        !nb.crashed && reds.length > 0,
        reds.length ? "" : "拆掉内联后所有判据依然全绿 ⇒ 这个守护验的是自己，不是产物");
      check("负向自证：报红的正是「无外链样式表」与「有内联块」这两条核心判据",
        reds.some((a) => /没有指向站内资源的外链样式表/.test(a.name)) &&
        reds.some((a) => /有内联样式块/.test(a.name)),
        reds.map((a) => a.name).join(" / ") || "（无任何报红）");
    }
  }
} finally {
  for (const d of [tmp, tmpNeg]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS —— 首绘不再等那一个往返，且样式与源码逐字一致");
