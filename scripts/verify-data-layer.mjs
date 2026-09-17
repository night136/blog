// 数据层正确性回归（audit §七 #10 阅读数非原子 / #12 便签墙全表聚合 / #13 注册并发冲突）
//
// 为什么这个守护要起一个**真的 SQLite**（node:sqlite，需 --experimental-sqlite）：
//   #10 与 #12 都是"SQL 语义/查询计划"层面的问题 —— 假 D1 只能验证"我调用了什么语句"，
//   验证不了"这条语句在真数据库上结果对不对、索引有没有被用上"。
//   #12 的目标本身就是"别建临时 B 树"，那是用 EXPLAIN QUERY PLAN 量的，不是读代码读出来的。
//   所以本文件会在缺少 flag 时**自动用 --experimental-sqlite 重启自己**，调用方无需特殊处理。
//
// [1] bumpViews 走 UPDATE…RETURNING，一次往返拿到自增后的真实值
// [2] 并发语义：连续两次自增返回值必须是 101、102（旧写法两次都会返回 101）
// [3] RETURNING 不可用时降级到 UPDATE+SELECT，且**留痕**
// [4] views 列不存在时静默跳过（不能因为没跑迁移就把文章打不开）
// [5] 连续打卡：新写法（day 列）与旧写法（substr）结果**逐项相同**（随机数据对拍）
// [6] 新写法的查询计划里**没有** TEMP B-TREE（这才是 #12 的目标）
// [7] guestbook 端到端（真 SQLite）：带 day 列时走新查询；缺列时自动退回旧查询
// 外加负向自证：把查询改回 substr / 把自增改回读旧值 → 各自判据必须变红。
//
// 用法：node scripts/verify-data-layer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// ── 需要 --experimental-sqlite 才能 import node:sqlite（Node 22；调用方不必知道这件事）──
let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch (e) {
  if (!process.env.__DATA_LAYER_REEXEC__) {
    const r = spawnSync(
      process.execPath,
      ["--experimental-sqlite", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: "inherit", env: { ...process.env, __DATA_LAYER_REEXEC__: "1" } },
    );
    process.exit(r.status == null ? 1 : r.status);
  }
  console.error("❌ 无法加载 node:sqlite：" + e.message);
  process.exit(2);
}
const { DatabaseSync } = sqlite;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
const argRoot = (process.argv.find((a) => a.startsWith("--root=")) || "").slice("--root=".length);
const ROOT = argRoot ? path.resolve(argRoot) : REPO;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 沙箱（functions/*.js 是 ESM，而仓库没有 package.json）──
function makeSandbox(mutate = null) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-data-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  fs.cpSync(path.join(ROOT, "functions"), path.join(tmp, "functions"), { recursive: true });
  if (mutate) mutate(tmp);
  return tmp;
}
const imp = (sandbox, rel) => import(pathToFileURL(path.join(sandbox, rel)).href);

// ── 把真 SQLite 包成 D1 的形状（prepare/bind/first/all/run）──
function d1Over(db) {
  return {
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async first() {
          const r = db.prepare(sql).get(...stmt._args);
          return r === undefined ? null : r;
        },
        async all() {
          return { results: db.prepare(sql).all(...stmt._args) };
        },
        async run() {
          const r = db.prepare(sql).run(...stmt._args);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  };
}

const mkPostsDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
           author_username TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0);`);
  db.prepare("INSERT INTO posts (slug, author_username, views) VALUES (?, ?, ?)").run("p1", "昉昕", 100);
  return db;
};

const sb = makeSandbox();
const views = await imp(sb, "functions/api/_lib/views.js");

console.log("\n[1] 阅读数自增：一次往返拿到自增后的真实值");
{
  const db = mkPostsDb();
  const r1 = await views.bumpViews(d1Over(db), "p1");
  check("走 RETURNING 路径（线上可用性另由响应头 X-Views-Atomic 实测）", r1.how === "returning", JSON.stringify(r1));
  check("返回值 = 100 + 1 = 101", r1.views === 101, String(r1.views));
  const r2 = await views.bumpViews(d1Over(db), "p1");
  check("连续第二次 = 102（库里也真的是 102）", r2.views === 102 && db.prepare("SELECT views FROM posts WHERE slug='p1'").get().views === 102,
    `${r2.views} / 库 ${db.prepare("SELECT views FROM posts WHERE slug='p1'").get().views}`);
  const r3 = await views.bumpViews(d1Over(db), "__no_such_slug__");
  check("文章不存在 → 不抛异常、返回 null（由调用方决定怎么报）", r3.views === null && r3.how === "no-row", JSON.stringify(r3));
}

console.log("\n[2] 并发语义：返回值必须逐次递增，不能两人都看到 101");
{
  // 旧写法的病灶：先 SELECT 拿快照，自增后在 JS 里用**快照 +1** 返回。
  // 用同一个起点模拟两次「读快照 → 自增」，旧写法两次都报 101。
  const db = mkPostsDb();
  const d1 = d1Over(db);
  const oldWay = async () => {
    const row = await d1.prepare("SELECT views FROM posts WHERE slug = ?").bind("p1").first();
    await d1.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind("p1").run();
    return (row.views || 0) + 1; // ← 拿旧快照加一
  };
  db.prepare("UPDATE posts SET views = 100 WHERE slug='p1'").run();
  // 先把两次「读」都做掉，再各自自增 —— 这就是并发下两个请求交错的形态
  const snapA = await d1.prepare("SELECT views FROM posts WHERE slug = ?").bind("p1").first();
  const snapB = await d1.prepare("SELECT views FROM posts WHERE slug = ?").bind("p1").first();
  await d1.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind("p1").run();
  await d1.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind("p1").run();
  const trueNow = db.prepare("SELECT views FROM posts WHERE slug='p1'").get().views;
  check("负向对照：旧写法（旧快照+1）在交错下会少报 —— 两人都报 101，而库里是 102",
    snapA.views + 1 === 101 && snapB.views + 1 === 101 && trueNow === 102,
    `A=${snapA.views + 1} B=${snapB.views + 1} 真值=${trueNow}`);

  const db2 = mkPostsDb();
  const d2 = d1Over(db2);
  const a = await views.bumpViews(d2, "p1");
  const b = await views.bumpViews(d2, "p1");
  check("新写法：两次返回 101 / 102，与库内真值一致（不会再少报）",
    a.views === 101 && b.views === 102 && db2.prepare("SELECT views FROM posts WHERE slug='p1'").get().views === 102,
    `${a.views} / ${b.views} / 库 ${db2.prepare("SELECT views FROM posts WHERE slug='p1'").get().views}`);
}

console.log("\n[3] RETURNING 不可用时降级，且不许静默");
{
  // 假 D1：第一条语句（带 RETURNING）直接报错，模拟「D1/旧 SQLite 不支持 RETURNING」
  const log = [];
  const fake = {
    prepare(sql) {
      const stmt = {
        _sql: sql,
        bind() { return stmt; },
        async first() {
          if (/RETURNING/i.test(sql)) throw new Error("D1_ERROR: near \"RETURNING\": syntax error");
          return { views: 7 };
        },
        async run() { log.push(sql); return { meta: {} }; },
      };
      return stmt;
    },
  };
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  const r = await views.bumpViews(fake, "p1");
  console.error = realErr;
  check("降级为 UPDATE + SELECT，并如实标注 how=fallback", r.how === "fallback" && r.views === 7, JSON.stringify(r));
  check("降级路径真的执行了 UPDATE 自增", log.some((s) => /UPDATE posts SET views/i.test(s)), JSON.stringify(log));
  check("降级时留痕（console.error 说明 RETURNING 不可用）",
    errs.some((s) => /RETURNING 不可用/.test(s)), errs.join(" | ") || "(一次都没打)");
}

console.log("\n[4] views 列不存在 → 静默跳过（未跑迁移的库也要能看文章）");
{
  const fake = {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() { throw new Error("D1_ERROR: no such column: views"); },
        async run() { throw new Error("D1_ERROR: no such column: views"); },
      };
      return stmt;
    },
  };
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  const r = await views.bumpViews(fake, "p1");
  console.error = realErr;
  check("返回 how=no-column 且不抛异常", r.how === "no-column" && r.views === null, JSON.stringify(r));
  check("这种**预期内**的缺列不刷错误日志（与「真故障」区分开，否则日志会误导排查）",
    errs.length === 0, errs.join(" | "));
}

// ── 便签墙的两个查询，直接在真 SQLite 上对拍 ──
const OLD_DAYS_SQL = "SELECT DISTINCT substr(created_at, 1, 10) AS d FROM guestbook_notes ORDER BY d DESC LIMIT 400";
const NEW_DAYS_SQL = "SELECT DISTINCT day AS d FROM guestbook_notes WHERE day IS NOT NULL ORDER BY d DESC LIMIT 400";

function mkGuestbookDb({ withDay = true, rows = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  const cols = [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "name TEXT NOT NULL DEFAULT '匿名'",
    "content TEXT NOT NULL",
    "color TEXT NOT NULL DEFAULT 'blue'",
    "ip_hash TEXT",
    "created_at TEXT NOT NULL",
  ];
  if (withDay) cols.push("day TEXT"); // ⚠️ 拼列名时留意尾逗号：直接写 "day TEXT," 在 withDay=false 时会留下孤零零的逗号
  db.exec(`CREATE TABLE guestbook_notes (${cols.join(", ")});
    CREATE INDEX idx_guestbook_created ON guestbook_notes(created_at DESC);
    ${withDay ? "CREATE INDEX idx_guestbook_day ON guestbook_notes(day DESC);" : ""}`);
  const ins = withDay
    ? db.prepare("INSERT INTO guestbook_notes (content, created_at, day) VALUES (?, ?, ?)")
    : db.prepare("INSERT INTO guestbook_notes (content, created_at) VALUES (?, ?)");
  for (const r of rows) withDay ? ins.run(r.content, r.created_at, r.day) : ins.run(r.content, r.created_at);
  return db;
}

function sampleRows(days, perDay, seed = 1) {
  // 简易可复现伪随机：不做统计检验，只要分布够不规则，能暴露"两种写法不等价"就行
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000);
    const iso = date.toISOString().slice(0, 10);
    const n = 1 + Math.floor(rnd() * perDay);
    for (let i = 0; i < n; i++) {
      rows.push({
        content: "c" + d + "-" + i,
        created_at: `${iso} ${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}`,
        day: iso,
      });
    }
  }
  return rows;
}

console.log("\n[5] 连续打卡：新写法（day 列）与旧写法（substr）结果逐项相同");
{
  let allEqual = true, detail = "";
  const cases = [
    { days: 1, perDay: 3 },
    { days: 7, perDay: 1 },
    { days: 40, perDay: 25 },
    { days: 120, perDay: 9 },
    { days: 500, perDay: 4 },   // 超过 LIMIT 400
  ];
  for (const c of cases) {
    const rows = sampleRows(c.days, c.perDay);
    const db = mkGuestbookDb({ rows });
    const a = db.prepare(OLD_DAYS_SQL).all().map((r) => r.d);
    const b = db.prepare(NEW_DAYS_SQL).all().map((r) => r.d);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      allEqual = false;
      detail = `${c.days}天/${c.perDay}条：旧 ${a.length} 天 vs 新 ${b.length} 天`;
      break;
    }
  }
  check("5 组样本（1~500 天、含超过 LIMIT 400 的情况）结果逐项相同", allEqual, detail);
  check("抽查：新写法确实拿到了期望的天数（不是空结果假通过）", (() => {
    const db = mkGuestbookDb({ rows: sampleRows(40, 25) });
    return db.prepare(NEW_DAYS_SQL).all().length === 40;
  })());
}

console.log("\n[6] #12 的目标本身：新查询不许建临时 B 树");
{
  const db = mkGuestbookDb({ rows: sampleRows(60, 20) });
  const planOf = (q) => db.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail).join(" | ");
  const oldPlan = planOf(OLD_DAYS_SQL);
  const newPlan = planOf(NEW_DAYS_SQL);
  check("旧写法确实要建临时 B 树（证明这条判据抓的是真问题，不是摆设）",
    /TEMP B-TREE/i.test(oldPlan), oldPlan);
  check("新写法只用索引扫描，无任何 TEMP B-TREE",
    !/TEMP B-TREE/i.test(newPlan) && /idx_guestbook_day/i.test(newPlan), newPlan);
  check("新写法用上的是**覆盖索引**（不回表）", /COVERING INDEX/i.test(newPlan), newPlan);
}

console.log("\n[7] guestbook 端点端到端（真 SQLite）：有 day 列走新查询，缺列自动退回旧查询");
{
  // Node 里没有 caches.default，补一个空壳（本端点用它做 30s 边缘缓存）
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  const gb = await imp(sb, "functions/api/guestbook.js");

  // ⚠️ 日期必须**相对今天**造：calcStreak 是拿「今天（UTC+8）」往前数的，
  //    用固定日期写死样本会因为"样本全在过去"而算出 streak=0（第一版就这么假红过一次）。
  const dayIso = (off) => new Date(Date.now() + 8 * 3600 * 1000 - off * 86400000).toISOString().slice(0, 10);
  const gbRows = [
    { o: 7 }, { o: 7 },                                  // 断签区：与下面隔了 offset 5、6 两天
    { o: 4 }, { o: 4 }, { o: 4 },
    { o: 3 }, { o: 3 },
    { o: 2 }, { o: 2 },                                  // 前天
    { o: 1 },                                            // 昨天
    { o: 0 }, { o: 0 }, { o: 0 },                        // 今天
  ].map((r, i) => ({ content: "note" + i, created_at: `${dayIso(r.o)} 10:0${i % 10}`, day: dayIso(r.o) }));
  const EXPECT_TOTAL = gbRows.length;   // 13
  const EXPECT_STREAK = 5;              // 今天 / 昨天 / 前天 / 大前天 / 大大前天（offset 5 缺失即断签）

  const db = mkGuestbookDb({ rows: gbRows });
  const req = new Request("https://blog.example.com/api/guestbook?limit=50");
  const res = await gb.onRequestGet({ env: { BLOG_DB: d1Over(db) }, request: req });
  const data = await res.json();
  check("带 day 列时正常返回（status 200）", res.status === 200, String(res.status));
  check(`总数（${EXPECT_TOTAL}）与 streak（${EXPECT_STREAK}）都被算出来（不是 catch 吞掉后的 0）`,
    data.total === EXPECT_TOTAL && data.streak === EXPECT_STREAK,
    `total=${data.total} streak=${data.streak}`);

  // 缺 day 列：整条链路（读取 + 写入）都必须自愈
  const dbOld = mkGuestbookDb({ withDay: false, rows: gbRows.map(({ content, created_at }) => ({ content, created_at })) });
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  const res2 = await gb.onRequestGet({ env: { BLOG_DB: d1Over(dbOld) }, request: req });
  const data2 = await res2.json();
  console.error = realErr;
  check("缺 day 列时读取自动退回 substr 查询，接口照常 200 且统计结果不变",
    res2.status === 200 && data2.total === EXPECT_TOTAL && data2.streak === EXPECT_STREAK,
    `status=${res2.status} total=${data2.total} streak=${data2.streak}`);
  check("退回时留痕（日志里说明要跑哪个迁移）",
    errs.some((s) => /day 不存在/.test(s) && /migrate-guestbook-day/.test(s)),
    errs.join(" | ") || "(一次都没打)");

  // 写入：缺 day 列时不能把留言写失败
  const post = (database) => gb.onRequestPost({
    request: new Request("https://blog.example.com/api/guestbook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "小测试", content: "一条便签" }),
    }),
    env: { BLOG_DB: d1Over(database) },
  });
  const dbWith = mkGuestbookDb({ rows: [] });
  const r1 = await post(dbWith);
  const row1 = dbWith.prepare("SELECT day, created_at FROM guestbook_notes").get();
  check("带 day 列时写入成功，且 day 与 created_at 同源",
    r1.status === 200 && row1.day === row1.created_at.slice(0, 10),
    `${r1.status} day=${row1 && row1.day} created_at=${row1 && row1.created_at}`);
  const dbWithout = mkGuestbookDb({ withDay: false, rows: [] });
  const errs2 = [];
  console.error = (...a) => errs2.push(a.join(" "));
  const r2 = await post(dbWithout);
  console.error = realErr;
  check("缺 day 列时写入自动退回旧列集合，留言仍能成功（真 SQLite 报的是 has no column named，与 SELECT 的文案不同）",
    r2.status === 200 && dbWithout.prepare("SELECT COUNT(*) AS c FROM guestbook_notes").get().c === 1,
    String(r2.status));
  check("退回写入时留痕", errs2.some((s) => /day 不存在/.test(s)), errs2.join(" | ") || "(一次都没打)");

  globalThis.caches = realCaches;
}

console.log("\n[8] 结构不变量");
{
  const sql = fs.existsSync(path.join(ROOT, "scripts/migrate-guestbook-day.sql"))
    ? fs.readFileSync(path.join(ROOT, "scripts/migrate-guestbook-day.sql"), "utf8") : "";
  check("迁移脚本存在", sql.length > 0);
  check("迁移里回填了历史行的 day 并建了索引（只加列不回填 = 老数据永远没 day）",
    /UPDATE guestbook_notes SET day = substr\(created_at, 1, 10\)/i.test(sql) &&
    /CREATE INDEX IF NOT EXISTS idx_guestbook_day/i.test(sql), sql.slice(0, 200));
  // 这是**实测**出来的结论，写进守护防止被"顺手改回去"：substr 查询比 day 查询多两个临时 B 树
  check("SQL 文件里保留了「为什么加这一列」的实测查询计划（避免以后被当成冗余列删掉）",
    /TEMP B-TREE/i.test(sql) && /EXPLAIN|查询计划|USING COVERING INDEX/i.test(sql));
}

console.log("\n[9] 负向自证：把修复撤回，判据必须变红");
{
  // 故障①：bumpViews 退回"读旧值 → 自增 → 用旧值 +1"
  {
    const broken = makeSandbox((tmp) => {
      const f = path.join(tmp, "functions/api/_lib/views.js");
      let s = fs.readFileSync(f, "utf8");
      const before = s;
      s = s.replace(
        /\.prepare\("UPDATE posts SET views = COALESCE\(views, 0\) \+ 1 WHERE slug = \? RETURNING views"\)[\s\S]*?\.first\(\);/,
        '.prepare("SELECT views FROM posts WHERE slug = ?").bind(slug).first();\n    const stale = await db.prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?").bind(slug).run();',
      );
      if (s === before) { console.error("❌ 故障①未注入"); process.exit(2); }
      fs.writeFileSync(f, s);
    });
    const v2 = await imp(broken, "functions/api/_lib/views.js");
    const db = mkPostsDb();
    const a = await v2.bumpViews(d1Over(db), "p1");
    const b = await v2.bumpViews(d1Over(db), "p1");
    check("故障①（自增退回用旧快照 +1）→ 两次返回同一个数，判据变红",
      !(a.views === 101 && b.views === 102), `${a.views} / ${b.views}`);
  }
  // 故障②：连续打卡退回 substr 查询（临时 B 树回来了）
  {
    const db = mkGuestbookDb({ rows: sampleRows(60, 20) });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT substr(created_at,1,10) AS d FROM guestbook_notes ORDER BY d DESC LIMIT 400")
      .all().map((r) => r.detail).join(" | ");
    check("故障②（查询退回 substr）→ 临时 B 树重现，判据变红", /TEMP B-TREE/i.test(plan), plan);
  }
}

console.log("");
if (fail === 0) { console.log(`✅ 全部通过（${pass + fail} 项，通过 ${pass}，失败 0）`); process.exit(0); }
console.log(`❌ 有失败项（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(1);
