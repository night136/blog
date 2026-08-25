// backfill-words.mjs
// 把 D1 中【存量文章】的 words 列补算准确（算法与 functions/_lib/readingTime.js 完全一致）。
// 列表接口 /api/posts 直接用 words 计算「约 N 分钟」「M 字」，所以回填后首页卡片数据才会准确。
//
// 为什么不用 wrangler：当前环境未安装 wrangler 也无 wrangler.toml，本脚本用 Cloudflare D1 REST API，
// 只需 Node（>=18，自带 fetch）即可运行，跨平台、无需登录 wrangler。
//
// ===== 准备工作（在 Cloudflare 控制台获取）=====
//   1) CF_ACCOUNT_ID  ：右侧账户图标 → 或浏览器地址栏 account/ 后的那段
//   2) CF_DATABASE_ID ：D1 → 选中 blog 库 → 数据库详情页 URL 里的 id（是一串 UUID）
//   3) CF_API_TOKEN   ：My Profile → API Tokens → Create Token → 选 "D1 Edit" 权限（或自定义：Account/D1 编辑）
//
// ===== 运行（Windows PowerShell）=====
//   $env:CF_ACCOUNT_ID="xxxx"; $env:CF_DATABASE_ID="xxxx"; $env:CF_API_TOKEN="xxxx"
//   node scripts/backfill-words.mjs
//   # 先只校验、不写入，可加： $env:DRY_RUN="1"
//
// ===== 运行（Git Bash / Linux / macOS）=====
//   CF_ACCOUNT_ID=xxxx CF_DATABASE_ID=xxxx CF_API_TOKEN=xxxx node scripts/backfill-words.mjs
//   # 先只校验： DRY_RUN=1 CF_ACCOUNT_ID=... node scripts/backfill-words.mjs

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DATABASE_ID = process.env.CF_DATABASE_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const DRY_RUN = !!process.env.DRY_RUN;

if (!ACCOUNT_ID || !DATABASE_ID || !API_TOKEN) {
  console.error("❌ 缺少环境变量，请先设置：");
  console.error("   CF_ACCOUNT_ID  - Cloudflare 账户 ID");
  console.error("   CF_DATABASE_ID - D1 数据库 UUID（数据库详情页 URL 中的 id）");
  console.error("   CF_API_TOKEN   - 具有 D1 编辑权限的 API Token");
  console.error("   可选：DRY_RUN=1 只校验不写入");
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function d1(sql) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json();
  if (!data.success) {
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || "unknown error";
    throw new Error(`D1 查询失败: ${msg} | sql=${String(sql).slice(0, 120)}`);
  }
  return data.result;
}

// ---- 与 functions/_lib/readingTime.js 完全一致的字数算法 ----
function countWords(md) {
  const text = (md || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/[#*`\[\](){}|>\-]/g, "");
  const cjk = (text.match(/[一-龥]/g) || []).length;
  const nonCjk = text
    .replace(/[一-龥]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((x) => x).length;
  return cjk + nonCjk;
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

async function main() {
  // 1) 确保 words 列存在（SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复加列报错则忽略）
  try {
    await d1("ALTER TABLE posts ADD COLUMN words INTEGER NOT NULL DEFAULT 0");
    console.log("✅ 已添加 words 列");
  } catch (e) {
    if (/duplicate column/i.test(e.message)) console.log("ℹ️  words 列已存在，跳过建列");
    else throw e;
  }

  // 2) 取出所有文章的 slug 与 body
  const list = await d1("SELECT slug, body FROM posts");
  const rows = list[0].results;
  console.log(`📦 共 ${rows.length} 篇文章`);

  let total = 0;
  const batches = [];
  for (let i = 0; i < rows.length; i += 50) {
    batches.push(rows.slice(i, i + 50));
  }

  let done = 0;
  for (const batch of batches) {
    const computed = batch.map((r) => ({ slug: r.slug, words: countWords(r.body) }));
    total += computed.reduce((s, c) => s + c.words, 0);
    if (DRY_RUN) {
      computed.forEach((c) => console.log(`   [dry] ${c.slug} -> ${c.words} 字`));
    } else {
      const stmts = computed.map(
        (c) => `UPDATE posts SET words = ${c.words} WHERE slug = '${esc(c.slug)}';`
      );
      await d1(stmts.join("\n"));
    }
    done += batch.length;
    console.log(`  → 已处理 ${done}/${rows.length}`);
  }

  console.log(`\n${DRY_RUN ? "🔍 校验完成（未写入）" : "✅ 回填完成"}：合计 ${total} 字`);
  if (DRY_RUN) console.log("   去掉 DRY_RUN=1 重新运行即可正式写入。");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
