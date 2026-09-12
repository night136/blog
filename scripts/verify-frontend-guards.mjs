// 前端行为约定守护：这几条都是踩过线上事故后定下来的，改动容易"顺手改回去"，用断言钉住。
// 用法：node scripts/verify-frontend-guards.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
const headersSrc = fs.readFileSync(path.join(root, "_headers"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

console.log("\n[1] 构建产物快照不得使用 force-cache");
{
  // 事故（2026-09-12）：force-cache = 无条件用本地缓存、永不校验。
  // 构建会更换封面文件名，旧快照里的封面全是死链 → 列表图集体消失且刷新也修不回来。
  check("app.js 里没有 cache:\"force-cache\"（改用 default / no-store）",
    !/cache\s*:\s*["'`]force-cache["'`]/.test(appSrc),
    "发现 cache:\"force-cache\"，会让快照永久停在被改名前的那一版");

  check("读 generated/posts.json 用 cache:\"default\"",
    /generated\/posts\.json"\s*,\s*\{\s*cache:\s*"default"/.test(appSrc),
    "未找到 cache:\"default\"");

  check("读 generated/posts/<slug>.json 用 cache:\"default\"",
    /generated\/posts\/\$\{encodeURIComponent\(slug\)\}\.json`\s*,\s*\{\s*cache:\s*"default"/.test(appSrc),
    "详情快照未使用 cache:\"default\"");

  check("_headers 给 posts.json 配了 SWR（default 才有意义）",
    /\/generated\/posts\.json[\s\S]{0,200}stale-while-revalidate/.test(headersSrc),
    "缺少 SWR 头");
}

console.log("\n[2] 封面加载失败必须能自愈，不能一次失败就永久隐藏");
{
  check("破图兜底带 cache-buster 重试（retry=）",
    /retry=/.test(appSrc), "未找到 retry cache-buster");
  check("卡片封面失败会尝试刷新快照（tryRefreshSnapshotForCovers）",
    /tryRefreshSnapshotForCovers/.test(appSrc), "未找到快照自愈逻辑");
  check("自愈用 cache:\"reload\" 绕过本地缓存",
    /cache:\s*"reload"/.test(appSrc), "未找到 cache:\"reload\"");
  check("重试上限为 2 次（不是 1 次就放弃）",
    /tries\s*<\s*2/.test(appSrc), "未找到 tries < 2");
}

console.log("\n[3] 详情页封面要完整展示，列表卡片才裁剪");
{
  // 事故：详情页用 object-fit:cover + max-height:440px 把图上下裁掉，用户反馈"封面显示不全"。
  const postCoverRules = cssSrc.match(/\.post-cover\s*\{[^}]*\}/g) || [];
  const hasContain = postCoverRules.some((r) => /object-fit:\s*contain/.test(r));
  const hasCoverCrop = postCoverRules.some((r) => /object-fit:\s*cover/.test(r));
  check("存在 .post-cover 规则且用 object-fit: contain", hasContain, postCoverRules.join(" ") || "未找到 .post-cover 规则");
  check("没有任何 .post-cover 规则用 object-fit: cover（会裁掉图）", !hasCoverCrop, postCoverRules.join(" "));
  check("详情页封面保留原始比例（height: auto）",
    postCoverRules.some((r) => /height:\s*auto/.test(r)), postCoverRules.join(" "));

  const cardCover = cssSrc.match(/\.card-cover-img\s*\{[^}]*\}/);
  check("列表卡片仍用 object-fit: cover（缩略图语义，不该改）",
    !!cardCover && /object-fit:\s*cover/.test(cardCover[0]),
    cardCover ? cardCover[0] : "未找到 .card-cover-img 规则");
}

console.log("\n[4] 封面 URL 必须过安全函数");
{
  check("卡片封面走 safeUrl", /card-cover-img"\s+src="\$\{escapeHtml\(safeUrl\(/.test(appSrc),
    "卡片封面未走 escapeHtml(safeUrl(...))");
  check("详情封面走 safeUrl", /const heroCover = post\.cover \? safeUrl\(post\.cover, true\)/.test(appSrc),
    "详情封面未走 safeUrl");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
