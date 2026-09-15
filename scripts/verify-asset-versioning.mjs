// 资源版本化回归（build.mjs 的 hashAssets）
//
// 事故（2026-09-12 线上实测）：旧实现把 app/style 复制成带内容哈希的新文件名
// （assets/app.<hash>.js）并写进 index.html，这类文件是 .gitignore 的构建产物、
// 只存在于当次部署。于是任何陈旧 HTML（/ 的缓存策略原本允许端旧壳近一天）
// 在下次部署后都会指向已被删除的文件 → app.js 404 → 整站 JS 全废。
//
// 修法：文件名固定为仓库里已提交的 assets/app.js，版本改用 ?v=<内容哈希>。
// 本脚本在临时目录里真跑一遍 build.mjs，验证：
//   ① 产出 index.html 用「稳定文件名 + ?v=」，且不再生成哈希副本文件
//   ② 引用的站内资源全部真实存在
//   ③ 幂等：连跑两次结果一致；内容变了版本号才变
//   ④ 兼容归一化：老形态（assets/app.<hash>.js）会被改回稳定 URL
//   ⑤ 源码守护：_headers 首页规则必须 max-age=0（不许再出现长时间 stale）
// 用法：node scripts/verify-asset-versioning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-asset-verify-"));
function setup() {
  fs.mkdirSync(path.join(tmp, "assets", "vendor"), { recursive: true });
  fs.copyFileSync(path.join(root, "build.mjs"), path.join(tmp, "build.mjs"));
  fs.copyFileSync(path.join(root, "index.html"), path.join(tmp, "index.html"));
  // 复制 index.html 会引用到的资源（uploads/ 是用户图片，不参与本次验证）
  const srcAssets = path.join(root, "assets");
  for (const f of fs.readdirSync(srcAssets)) {
    if (f === "uploads") continue;
    const s = path.join(srcAssets, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmp, "assets", f));
  }
  for (const f of fs.readdirSync(path.join(srcAssets, "vendor"))) {
    fs.copyFileSync(path.join(srcAssets, "vendor", f), path.join(tmp, "assets", "vendor", f));
  }
  // build.mjs 现在会 import scripts/lib/seo-render.mjs（正文 SEO 片段渲染器），
  // 临时目录里必须也有它，否则 build.mjs 一启动就 ERR_MODULE_NOT_FOUND。
  const srcLib = path.join(root, "scripts", "lib");
  if (fs.existsSync(srcLib)) {
    fs.mkdirSync(path.join(tmp, "scripts", "lib"), { recursive: true });
    for (const f of fs.readdirSync(srcLib)) {
      fs.copyFileSync(path.join(srcLib, f), path.join(tmp, "scripts", "lib", f));
    }
  }
}
function build() {
  // 不设 CF_* 环境变量 → main() 提前返回，只执行 finally 里的 hashAssets()
  const env = { ...process.env };
  delete env.CF_ACCOUNT_ID; delete env.CF_DATABASE_ID; delete env.CF_API_TOKEN;
  return execFileSync(process.execPath, ["build.mjs"], { cwd: tmp, env, encoding: "utf8", stdio: "pipe" });
}
const html = () => fs.readFileSync(path.join(tmp, "index.html"), "utf8");

try {
  setup();

  console.log("\n[1] 产出形态：稳定文件名 + ?v=内容哈希");
  const out1 = build();
  let h1 = html();
  const appRef = (h1.match(/assets\/app\.js\?v=([a-z0-9]+)/) || [])[1];
  const cssRef = (h1.match(/assets\/style\.css\?v=([a-z0-9]+)/) || [])[1];
  check("index.html 引用 assets/app.js?v=<hash>", !!appRef, "未找到 app.js?v=");
  check("index.html 引用 assets/style.css?v=<hash>", !!cssRef, "未找到 style.css?v=");
  check("不再出现哈希文件名（assets/app.<hash>.js）",
    !/assets\/(app|style)\.[a-f0-9]{6,64}\.(js|css)/.test(h1),
    (h1.match(/assets\/(app|style)\.[a-f0-9]{6,64}\.(js|css)/) || [])[0]);
  check("assets/ 下没有生成新文件（不再产出哈希副本）",
    !fs.readdirSync(path.join(tmp, "assets")).some((f) => /\.(js|css)$/.test(f) && f !== "app.js" && f !== "style.css"),
    fs.readdirSync(path.join(tmp, "assets")).join(", "));
  check("日志说明已改为稳定文件名", /稳定文件名/.test(out1), out1.trim().split("\n").pop());

  console.log("\n[2] 引用的站内资源必须都存在");
  {
    const refs = [...h1.matchAll(/(?:src|href)="(assets\/[^"?#]+)/g)].map((m) => m[1]);
    const missing = refs.filter((r) => !fs.existsSync(path.join(tmp, r)));
    check(`HTML 里 ${refs.length} 个站内资源全部存在`, missing.length === 0, missing.join(", "));
  }

  console.log("\n[3] 幂等性与版本变更");
  build();
  check("连跑两次 index.html 完全一致", html() === h1);
  fs.appendFileSync(path.join(tmp, "assets", "app.js"), "\n// touch\n");
  build();
  const appRef2 = (html().match(/assets\/app\.js\?v=([a-z0-9]+)/) || [])[1];
  check("app.js 内容变化 → 版本号变化", appRef2 && appRef2 !== appRef, `${appRef} → ${appRef2}`);

  console.log("\n[4] 兼容归一化（老形态与旧壳）");
  fs.writeFileSync(path.join(tmp, "index.html"),
    '<link rel="stylesheet" href="assets/style.0123456789.css"><script src="assets/app.deadbeef00.js" defer></script>');
  build();
  const h4 = html();
  check("哈希文件名被归一化为 assets/app.js?v=",
    /assets\/app\.js\?v=[a-z0-9]+/.test(h4) && !/app\.deadbeef00\.js/.test(h4), h4);
  check("style 哈希名同样被归一化",
    /assets\/style\.css\?v=[a-z0-9]+/.test(h4) && !/style\.0123456789\.css/.test(h4), h4);

  console.log("\n[5] 源码守护");
  {
    const buildSrc = fs.readFileSync(path.join(root, "build.mjs"), "utf8");
    const headersSrc = fs.readFileSync(path.join(root, "_headers"), "utf8").replace(/\r\n/g, "\n");
    check("build.mjs 不再写哈希副本文件",
      !/app\.\$\{appH\}\.js/.test(buildSrc) && !/hashCopy/.test(buildSrc),
      "仍存在生成哈希文件名的逻辑");
    check("build.mjs 有「引用资源存在性」自检", /引用了不存在的资源/.test(buildSrc), "未找到自检");
    // 首页规则块必须是 max-age=0，且不得再出现长时间 stale
    const block = (headersSrc.match(/^\/\n((?:  .*\n)+)/m) || [])[1] || "";
    check("_headers 首页规则为 max-age=0", /max-age=0/.test(block), block.trim());
    check("_headers 首页不再允许长时间陈旧（无 86400 级 stale）",
      !/stale-while-revalidate=\d{4,}/.test(block), block.trim());
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS —— 旧 HTML 外壳再也不会引用到不存在的资源");
