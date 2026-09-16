// 守护：回归套件的「覆盖完整性」。
//
// 背景（真实事故，2026-09-16 发现）：
//   本轮新增 `scripts/verify-avatar-asset.mjs`（13 项断言），却没有同步加进
//   `scripts/run-all.sh` 的硬编码列表 —— 结果是「写了守护，但主入口永远不跑它」。
//   这种失效最阴险：套件全绿 ≠ 通过，因为**根本没执行**。
//
// 这个脚本守的不是代码，是「套件本身有没有漏项」：
//   [1] 磁盘上每个 verify-*.mjs / smoke-app.mjs 都在 run-all.sh 列表里
//   [2] run-all.sh 里不能有磁盘上不存在的名字（改名/删除后的幽灵项）
//   [3] 列表里不能有重复项
//   [4] 顺序约束：verify-no-tdz 必须第一个跑（最快、兜底最基础的崩溃）
//   [5] 负向自证：从列表里删掉一个，本判据必须判红（证明不是恒真）
//   [6] run-all.sh 能过 `bash -n`（找到 bash 才查，找不到明确标为「跳过」而不是失败）
//
// 用法：node scripts/verify-suite-coverage.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ALL = join(ROOT, "scripts", "run-all.sh");

let pass = 0, fail = 0, skip = 0;
// ⚠️ 参数顺序：msg 在前，ok 在后。首版写成 (ok, msg) 而调用处按 (msg, ok) 传，
//    结果每行都打印成「✅ true」+ 真正的内容掉到 detail 里 —— 断言全绿但没人看得懂。
//    凡是「会打印通过与否」的辅助函数，都要拿一条**故意失败**的输入验一次。
const log = (msg, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
  if (detail) console.log(`     ${detail}`);
  ok ? pass++ : fail++;
};

if (!existsSync(RUN_ALL)) {
  console.log("❌ 找不到 scripts/run-all.sh");
  process.exit(1);
}
const sh = readFileSync(RUN_ALL, "utf8");

// ── 解析 run-all.sh 的 for 列表 ──
// 只认 `for s in a b c; do` 这一行的内容，避免把注释里的示例名算进来。
const listLine = (sh.match(/^\s*for\s+s\s+in\s+([^;]*);\s*do/m) || [])[1];
if (!listLine) {
  console.log("❌ 无法从 run-all.sh 解析出套件列表（`for s in …; do` 形态变了？）");
  process.exit(1);
}
const listed = listLine
  .split(/\s+/)
  .map((x) => x.trim())
  .filter((x) => x && !x.startsWith("#"));

// ── 磁盘上的实际套件 ──
const onDisk = readdirSync(join(ROOT, "scripts"))
  .filter((f) => /^(verify-.*|smoke-app)\.mjs$/.test(f))
  .map((f) => f.replace(/\.mjs$/, ""));

console.log("── 套件覆盖 ──");
console.log(`   run-all.sh 列表：${listed.length} 项`);
console.log(`   磁盘上的脚本  ：${onDisk.length} 项\n`);

// [1] 磁盘有、列表没有 → 漏项（最严重）
const missing = onDisk.filter((n) => !listed.includes(n));
log(
  `[1] 磁盘上每个套件都在 run-all.sh 里（漏 ${missing.length} 项）`,
  missing.length === 0,
  missing.length ? "❌ 这些脚本永远不会被主入口执行：" + missing.join(", ") : "全部已收录"
);

// [2] 列表有、磁盘没有 → 幽灵项
const ghosts = listed.filter((n) => !onDisk.includes(n));
log(
  `[2] run-all.sh 里没有幽灵项（幽灵 ${ghosts.length} 个）`,
  ghosts.length === 0,
  ghosts.length ? "❌ 列表里有磁盘上不存在的脚本：" + ghosts.join(", ") : "无"
);

// [3] 重复项
const dup = [...new Set(listed.filter((n, i) => listed.indexOf(n) !== i))];
log(
  `[3] 列表无重复项（重复 ${dup.length} 个）`,
  dup.length === 0,
  dup.length ? "❌ 重复：" + dup.join(", ") : "无"
);

// [4] 顺序约束
log(
  `[4] verify-no-tdz 排在首位（当前首位：${listed[0]}）`,
  listed[0] === "verify-no-tdz",
  listed[0] === "verify-no-tdz"
    ? "崩溃类检查最快，先跑能最快给出「整站 JS 是否可运行」的答案"
    : "它是最快的兜底项，常规应排第一（若确有意调整，请同步改本断言并说明原因）"
);

// [5] 负向自证：删掉一项后判据必须变红
{
  const probe = listed.filter((n) => n !== "verify-avatar-asset");
  const wouldMiss = onDisk.filter((n) => !probe.includes(n));
  log(
    "[5] 负向自证：从列表里删掉 verify-avatar-asset 必须能判红",
    wouldMiss.includes("verify-avatar-asset"),
    wouldMiss.length ? `模拟结果：会报出漏项 ${wouldMiss.join(", ")} ⇒ 判据不是恒真` : "❌ 判据恒真，等于没守"
  );
}

// [6] 语法兜底：run-all.sh 是 bash 脚本，手改很容易改坏整个套件。
//     ⚠️ 这个环境下 `bash` 不在 node 的 PATH 里（Git Bash 是 PortableGit，路径固定），
//     所以先探测候选路径；一个都找不到就如实标「跳过」—— 既不伪装成通过，也不冤枉成失败。
{
  const candidates = [
    process.env.BASH,
    "bash",
    "C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin/bash.exe",
    "C:/Program Files/Git/bin/bash.exe",
    "/usr/bin/bash",
  ].filter(Boolean);
  let result = null, used = null;
  for (const c of candidates) {
    const r = spawnSync(c, ["-n", RUN_ALL], { encoding: "utf8" });
    if (r.error && r.error.code === "ENOENT") continue; // 这个候选不存在，试下一个
    result = r; used = c; break;
  }
  if (!result) {
    console.log("⏭️  [6] 跳过：找不到任何 bash 可执行文件，无法做语法检查");
    skip++;
  } else {
    const ok = result.status === 0;
    log(
      `[6] run-all.sh 通过 \`bash -n\` 语法检查（用 ${used}）`,
      ok,
      ok ? "" : (result.stderr || String(result.error || "")).trim().slice(0, 200)
    );
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}${skip ? ` / 跳过 ${skip}` : ""}`);
process.exit(fail === 0 ? 0 : 1);
