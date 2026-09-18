// 只读核验：D1 的两条迁移到底生效没有。
//
// ⚠️ 本脚本第一版的结论行是错的，两个错都在这里留着：
//   ① **把"没测"写成"通过"**：判据标了 `⏭ 本次不适用`，汇总却输出
//      "列存在且历史行已回填"。没执行过的判据不许计入通过。
//   ② **空断言**：`check("服务端 streak ≥ 列表下界", j.streak >= expectedStreak)`
//      在两边都是 0 时恒真 —— 它不承载任何信息，却会报绿。
//      ⇒ 只在"有信息量"时才断言，否则必须落到 INCONCLUSIVE，不许算通过。
//
// 结论（先说清楚，免得白跑）：
//   · guestbook 的 day 列**从公开接口原理上不可验证**。带 day 与不带 day 的两种查询
//     结果逐项相同（这正是设计目标：留言墙绝不能因为少一列就读不出来），
//     而接口只暴露 streak，不暴露天数集合。只有当"今天/昨天有留言"时 streak 才携带信息。
//   · login_attempts 也不可验证：/api/login 的 Turnstile 前置会拦掉无 token 的请求
//     （实测 HTTP 403），走不到限频逻辑，所以那个 X-Login-Delay 响应头拿不到。
//   ⇒ 真正的判定通道是 D1 控制台，见 scripts/d1-verify-migrations.sql。
//
// 本脚本的用途：在**数据条件恰好具备**时（近期有连续留言），
// 用公开接口零成本地交叉验证一次。数据不具备就老实说 INCONCLUSIVE。
//
// 用法： node scripts/audit-d1-migration.mjs

const BASE = "https://blog-6p3.pages.dev";

function todayUtc8() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const p = (x) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? `  ← ${detail}` : ""}`);
};
// 判据本次不适用 ⇒ 既不算通过也不算失败，单独计数（第一版就是在这里撒的谎）
const skip = (name, why) => { skipped++; console.log(`  ⏭  ${name} —— 本次不适用：${why}`); };

const url = `${BASE}/api/guestbook?limit=100&cb=${Math.random().toString(36).slice(2)}`;
const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
console.log(`=== ① guestbook.day 列 ===`);
console.log(`  GET /api/guestbook → HTTP ${r.status}`);
const j = await r.json();

const notes = j.notes || [];
const uniq = [...new Set(notes.map((n) => String(n.created_at || "").slice(0, 10)).filter(Boolean))]
  .sort().reverse();
const today = todayUtc8();
const yesterday = addDays(today, -1);

console.log(`  留言 ${notes.length} 条 / total=${j.total} / streak=${j.streak}`);
console.log(`  列表覆盖的日期：${uniq.join(", ") || "（无）"}`);
console.log(`  今天=${today}  昨天=${yesterday}  列表最新=${uniq[0] || "（无）"}`);

// 由列表逆推 streak（受 limit=100 截断，只作下界）
function streakFrom(dates) {
  const set = new Set(dates);
  let cur = set.has(today) ? today : yesterday;
  if (!set.has(cur)) return 0;
  let n = 0;
  while (set.has(cur)) { n++; cur = addDays(cur, -1); }
  return n;
}
const derived = streakFrom(uniq);
console.log(`  由列表推得的 streak（下界）= ${derived}`);

// ⚠️ 只有 derived > 0 时这条判据才含信息：两边都是 0 时 `>=` 恒真。
//    （这正是第一版空断言的来源。）
if (derived > 0) {
  check("服务端 streak ≥ 列表推得的下界（day 集合没被 IS NOT NULL 掏空）",
    Number(j.streak) >= derived, `服务端=${j.streak} 列表下界=${derived}`);
} else {
  skip("服务端 streak ≥ 列表推得的下界",
    "列表里没有近期（今天/昨天起）连续留言，0 >= 0 恒真、不承载信息");
}

// 另一条：列表里若有"昨天/今天"的留言而服务端 streak 为 0，则 day 列存在却全为 NULL
//（ALTER 跑了、UPDATE 没跑）。同样需要近期留言才有信息量。
if (derived > 0) {
  check("有近期留言时 streak 不为 0（否则说明 day 列存在但历史行未回填）",
    Number(j.streak) > 0, `streak=${j.streak}`);
} else {
  skip("有近期留言时 streak 不为 0", "同上：列表里根本没有近期留言");
}

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail}，不适用 ${skipped} ===`);
if (fail > 0) {
  console.log("结论：FAIL —— day 列存在但历史行未回填（很可能 ALTER 执行了、UPDATE 没执行）");
} else if (pass > 0) {
  console.log("结论：PASS —— 数据条件具备且交叉验证通过");
} else {
  console.log("结论：INCONCLUSIVE —— 一条判据都没能真正跑起来，本次**没有**验证到任何东西。");
  console.log("      ⇒ 判定通道只有 D1 控制台：scripts/d1-verify-migrations.sql");
}
process.exit(fail > 0 ? 1 : 0);
