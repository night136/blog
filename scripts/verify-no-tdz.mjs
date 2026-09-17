// 守护：禁止「函数体内使用 IIFE 后半段才 let/const 声明的变量」（暂时性死区 TDZ）
//
// 背景（真实线上事故）：
//   app.js:478 的 openPost() 里写 `currentSlug = slug`，而 `let currentSlug` 声明在 1858 行。
//   函数一旦被调用就落在 TDZ，抛 ReferenceError；又因为 openPost 外层是 `catch (_) {...}`，
//   异常被静默吞掉 —— 用户只看到「文章加载失败，请重试」，控制台完全没有报错。
//   该 bug 存活了数周未被发现（smoke-app 只跑顶层同步路径，不调用 openPost，抓不到）。
//
// 本脚本做的是**作用域感知**的静态检查，而不是简单的文本比对：
//   1. 收集 IIFE 顶层的所有 `let/const` 声明及其行号；
//   2. 逐个扫描函数体（含箭头函数），找出「引用了这些名字」且「引用行号 < 声明行号」的位置；
//   3. 排除在该函数作用域内被重新声明/作为参数/被解构的名字（那是本地变量，不是 TDZ）；
//   4. 排除 `typeof x` 这种对 TDZ 安全的用法。
//
// 用法：node scripts/verify-no-tdz.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, "..", "assets", "app.js");
const src = fs.readFileSync(target, "utf8");
const lines = src.split(/\r?\n/);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " —— " + detail : "")); }
};

// ── 1. 计算每行的花括号净深度，用于判断某个声明是否处于「IIFE 顶层」 ──
// 说明：app.js 是单个 `(function(){ ... })();`，顶层语句深度为 1（最外层 function 之内）。
// 为稳妥起见，我们不硬编码深度，而是找 IIFE 的第一行与最后一行作为范围。
const depth = new Array(lines.length).fill(0);
{
  let d = 0;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // 去掉块注释，避免注释里的 { } 干扰计数
    let clean = "";
    for (let j = 0; j < line.length; j++) {
      if (inBlockComment) {
        if (line[j] === "*" && line[j + 1] === "/") { inBlockComment = false; j++; }
        continue;
      }
      if (line[j] === "/" && line[j + 1] === "*") { inBlockComment = true; j++; continue; }
      if (line[j] === "/" && line[j + 1] === "/") break; // 行注释
      clean += line[j];
    }
    depth[i] = d;                        // 该行开始时的深度
    const opens = (clean.match(/\{/g) || []).length;
    const closes = (clean.match(/\}/g) || []).length;
    d += opens - closes;
  }
}

// ── 2. 收集「IIFE 顶层」的 let/const 声明：深度为 1 的顶层语句 ──
// IIFE 形如 `(function () {` ... `})();`，其内部第一层语句深度 = 1。
const topLevelDecls = new Map(); // name -> 声明行号(1-based)
for (let i = 0; i < lines.length; i++) {
  if (depth[i] !== 1) continue;
  const m = lines[i].match(/^\s*(?:let|const)\s+([A-Za-z_$][\w$]*)\s*[=;,]/);
  if (m && !topLevelDecls.has(m[1])) topLevelDecls.set(m[1], i + 1);
}

console.log(`\n[1] IIFE 顶层声明收集：${topLevelDecls.size} 个变量`);
console.log("    " + [...topLevelDecls.entries()].map(([k, v]) => `${k}@${v}`).join(", ") + "\n");

// ── 3. 逐函数扫描：找出在声明行之前就被使用的顶层变量 ──
// 简化但有效的做法：扫描每个「函数体」块（从含 `function`/`=>` 的行到其配对 `}`），
// 在其中查找顶层变量名的出现，且出现行号 < 声明行号。
const violations = [];

// 找出所有函数体的起止行（按花括号配对）
function findFunctionBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const isFn = /(?:^|\s)(?:async\s+)?function\s*[A-Za-z_$]*\s*\(/.test(line)
      || /=>\s*\{?\s*$/.test(line)
      || /(?:^|\s)(?:async\s+)?function\s*\(/.test(line);
    if (!isFn) continue;
    // 从该行开始找配对花括号
    let d = depth[i];
    let start = i;
    let end = -1;
    const opensHere = (line.match(/\{/g) || []).length;
    if (opensHere === 0) {
      // 单行函数（如 `(x) => x + 1`），只扫本行
      blocks.push([start, start]);
      continue;
    }
    for (let j = i; j < lines.length; j++) {
      if (j > i && depth[j] <= d) { end = j - 1; break; }
    }
    if (end === -1) end = lines.length - 1;
    blocks.push([start, end]);
  }
  return blocks;
}

const blocks = findFunctionBlocks();
console.log(`[2] 扫描函数体：${blocks.length} 个`);

for (const [start, end] of blocks) {
  const bodyLines = lines.slice(start, end + 1);
  const bodyText = bodyLines.join("\n");
  // 该函数内被重新声明 / 作为参数 / 解构的名字 → 属于本地变量，不是 TDZ
  const localNames = new Set();
  for (const m of bodyText.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) localNames.add(m[1]);
  for (const m of bodyText.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
    m[1].split(",").forEach((p) => { const n = p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, ""); if (n) localNames.add(n); });
  }
  for (const m of bodyText.matchAll(/\(([^)]*)\)\s*=>/g)) {
    m[1].split(",").forEach((p) => { const n = p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, ""); if (n) localNames.add(n); });
  }
  for (const m of bodyText.matchAll(/for\s*\(\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) localNames.add(m[1]);
  for (const m of bodyText.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) localNames.add(m[1]);

  for (const [name, declLine] of topLevelDecls) {
    if (declLine <= start + 1) continue;   // 声明在函数之前 → 安全
    if (localNames.has(name)) continue;     // 函数内自有声明/参数 → 不是 TDZ
    for (let i = start; i <= end; i++) {
      const line = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;          // 注释行
      // 去掉行内注释后再匹配
      const code = line.replace(/\/\/.*$/, "");
      if (!new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code)) continue;
      // typeof 对 TDZ 安全（不会抛错）
      if (new RegExp(`typeof\\s+${name}\\b`).test(code)) continue;
      violations.push({ name, declLine, useLine: i + 1, fnStart: start + 1, snippet: code.trim().slice(0, 100) });
      break; // 同一变量同一函数只报一次
    }
  }
}

// ── 4. 断言 ──
console.log("\n[3] TDZ 检查结果");
if (violations.length === 0) {
  check("无「函数体使用后方声明的顶层变量」（TDZ）", true);
} else {
  check("无「函数体使用后方声明的顶层变量」（TDZ）", false, `发现 ${violations.length} 处`);
  for (const v of violations) {
    console.log(`      · ${v.name} 在 ${v.fnStart} 行的函数内第 ${v.useLine} 行被使用，但声明在第 ${v.declLine} 行`);
    console.log(`        ${v.snippet}`);
  }
}

// ── 5. 关键变量必须在文件前 1/3 处声明（防止有人又把它们挪回后半段） ──
console.log("\n[4] 关键状态变量的声明位置守护");
const mustBeEarly = ["currentUser", "currentSlug", "currentPost", "currentPostAuthor", "editingSlug", "commentSort", "replyTo"];
const threshold = Math.floor(lines.length / 3);
for (const name of mustBeEarly) {
  const line = topLevelDecls.get(name);
  check(
    `${name} 声明在文件前 1/3（≤${threshold} 行）`,
    line !== undefined && line <= threshold,
    line === undefined ? "未找到顶层声明" : `实际在第 ${line} 行`
  );
}

// ── 6. 重复声明检查（同一变量被 let 两次会 SyntaxError，早期人工编辑易犯） ──
console.log("\n[5] 顶层变量重复声明检查");
const dupes = [];
{
  const seen = new Map();
  for (const [name, line] of topLevelDecls) seen.set(name, line);
  // 额外找出文件中**所有** `let <name>` 出现次数（含非顶层）
  for (const name of mustBeEarly) {
    const re = new RegExp(`^\\s*let\\s+${name}\\b`, "gm");
    const count = (src.match(re) || []).length;
    if (count > 1) dupes.push(`${name} 被 let 声明 ${count} 次`);
  }
}
check("关键变量无重复 let 声明", dupes.length === 0, dupes.join("; "));

// ── 7. openPost 竞态保护守护 ──
console.log("\n[6] openPost 结构守护");
check("openPost 使用 openSeq 做竞态保护", /const seq = \+\+openSeq;/.test(src) && /const stale = \(\) => seq !== openSeq;/.test(src));
check("openPost 的 await 之后有 stale() 校验（≥4 处）", (src.match(/if \(stale\(\)\) return;/g) || []).length >= 4,
  `实际 ${(src.match(/if \(stale\(\)\) return;/g) || []).length} 处`);
check("openSeq 在 IIFE 顶层声明", topLevelDecls.has("openSeq"));

// ── 8. 阅读进度监听清理守护 ──
console.log("\n[7] 事件监听泄漏守护");
check("initReadingProgress 绑定前先移除旧监听",
  /if \(progressHandler\) \{ window\.removeEventListener\("scroll", progressHandler\); progressHandler = null; \}/.test(src));
check("不再直接 addEventListener(\"scroll\", update)", !/addEventListener\("scroll", update, \{ passive: true \}\)/.test(src));

// ── 9. 后端安全守护 ──
console.log("\n[8] 后端安全守护");
const root = path.join(here, "..");
// 断言前先剥掉注释：否则「解释为什么不能区分」的注释文字本身会误伤断言（踩过一次）
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:])\/\/.*$/gm, "$1");
const loginSrc = fs.readFileSync(path.join(root, "functions", "api", "login.js"), "utf8");
const loginCode = stripComments(loginSrc);
check("登录不泄露「用户不存在/密码错误」的差异（只看代码，不看注释）",
  !/用户不存在/.test(loginCode) && !/"密码错误"/.test(loginCode),
  "代码中仍存在可区分的错误文案");
check("登录统一返回「用户名或密码错误」", /"用户名或密码错误"/.test(loginCode));
check("登录错误响应不回显内部异常信息", !/登录失败：" \+\s*\(e/.test(loginCode) && /登录失败，请稍后重试/.test(loginCode));

// ⚠️ 下面两条曾经写死成「假哈希是 `salt:hash` 格式」（`/const DUMMY_HASH = "…:…"/`）。
//    §五 把哈希格式换成自描述 `pbkdf2$<iter>$<salt>$<hash>` 之后它们立刻变红 —— **但代码是对的**：
//    假哈希本来就应该跟着换格式。这就是「拿代理指标当判据」的典型：真正的不变量不是
//    "某个字符串长什么样"，而是**假哈希与真密码走同一条迭代数来源**（否则两边耗时又拉开，侧信道重新打开）。
//    现在改成解析调用实参、回溯到它的声明表达式，并加一条负向自证证明判据不是恒真。
const dummyIterExpr = (src) => {
  const call = src.match(/dummyHash\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (!call) return null;
  // 变量名要转义后再塞进正则（`$` 是合法标识符字符，直接拼会变成锚点）
  const name = call[1].replace(/[$]/g, "\\$");
  const decl = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([^;]+);`));
  return decl ? decl[1].trim() : null;
};
const iterIsSharedSource = (expr) => !!expr && /targetIterations\(\s*env\s*\)/.test(expr) && !/^\d+$/.test(expr);

check("登录对不存在的用户也做假哈希校验（防时序侧信道）",
  /user\s*\?\s*user\.password_hash\s*:\s*dummyHash\(/.test(loginCode),
  "未找到「用户不存在时也走一次假哈希」的三元分支");
const dummyExpr = dummyIterExpr(loginCode);
check(`假哈希与真密码同源（迭代数取自 ${dummyExpr || "?"}）`,
  iterIsSharedSource(dummyExpr),
  "假哈希的迭代数不是从 targetIterations(env) 取的 —— 写死数字会让两边耗时重新拉开");
check("负向自证：把迭代数写死成字面量，上一条必须判红",
  !iterIsSharedSource(dummyIterExpr(loginCode.replace(/const iterations = targetIterations\(env\);/, "const iterations = 100000;"))),
  "改坏了判据依然全绿 ⇒ 这条断言是摆设");

const gbSrc = fs.readFileSync(path.join(root, "functions", "api", "guestbook.js"), "utf8");
check("便签墙缓存键包含登录态维度", /cacheUrl\.searchParams\.set\("_u"/.test(gbSrc));

const searchSrc = fs.readFileSync(path.join(root, "functions", "api", "posts", "search.js"), "utf8");
check("搜索结果有 LIMIT 上限", /LIMIT \?/.test(searchSrc) && /MAX_RESULTS/.test(searchSrc));

// ── 10. 焦点样式守护 ──
console.log("\n[9] 键盘可达性守护");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
check("存在全局 :focus-visible 规则", /:focus-visible\s*\{/.test(cssSrc));
check(":focus-visible 使用强调色轮廓", /:focus-visible[\s\S]{0,400}?outline:\s*2px solid var\(--accent\)/.test(cssSrc));
check("卡片有专属焦点轮廓", /\.card:focus-visible/.test(cssSrc));

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
