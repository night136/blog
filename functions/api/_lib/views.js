// 阅读数自增（audit §七 #10：非原子自增）
//
// 原来的写法是三条独立语句：
//     SELECT views FROM posts WHERE slug = ?      ← 读到旧值
//     UPDATE posts SET views = COALESCE(views,0)+1 WHERE slug = ?   ← SQL 侧自增（这步本身是原子的）
//     views = row.views + 1                       ← 在 JS 里用**旧值**算返回值
// `views = views + 1` 本身不会丢更新，但**返回给前端的数字**是拿旧快照加一的：
// 并发下两个请求都读到 100，各自返回 101，而库里已经是 102 —— 计数没丢，显示是错的。
//
// 现在用 `UPDATE … RETURNING views` 一次拿到自增后的真实值：既原子，又省掉一次往返。
//
// ⚠️ RETURNING 需要 SQLite ≥ 3.35 / D1 支持。没有实测过的能力不能当既成事实，
//    所以这里保留两级优雅降级，并且**降级不静默**：
//      ① RETURNING（原子，一次往返）
//      ② UPDATE + SELECT（自增仍原子，但返回值的读回有微小竞态）
//      ③ 列不存在（未执行 migrate-views.sql）→ 静默跳过，与旧行为一致：不因缺列把文章打不开
//
// 想确认线上到底走了哪条路：POST /api/posts/view 的响应头 `X-Views-Atomic`
// （1 = RETURNING，0 = 降级）。这是**实测**该能力是否可用的唯一办法，不是装饰。

export async function bumpViews(db, slug) {
  if (!db || !slug) return { views: null, how: "no-db" };
  try {
    const row = await db
      .prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ? RETURNING views")
      .bind(slug)
      .first();
    if (row && row.views != null) return { views: Number(row.views), how: "returning" };
    // RETURNING 生效但没这一行 = 文章不存在
    return { views: null, how: "no-row" };
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/no such column: views/i.test(msg)) return { views: null, how: "no-column" };
    console.error("[views] RETURNING 不可用，降级为 UPDATE + SELECT：", e && e.stack ? e.stack : e);
    try {
      await db
        .prepare("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE slug = ?")
        .bind(slug)
        .run();
      const r = await db.prepare("SELECT views FROM posts WHERE slug = ?").bind(slug).first();
      return { views: r && r.views != null ? Number(r.views) : null, how: "fallback" };
    } catch (e2) {
      if (!/no such column: views/i.test(String((e2 && e2.message) || ""))) {
        console.error("[views] 降级路径也失败（本次不更新阅读数）：", e2 && e2.stack ? e2.stack : e2);
      }
      return { views: null, how: "failed" };
    }
  }
}
