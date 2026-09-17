-- 留言墙「连续打卡天数」的聚合提速（audit §七 #12）
-- 在 Cloudflare D1 Console 粘贴执行。
--
-- 问题（实测出来的，不是猜的）
-- ─────────────────────────
--   SELECT DISTINCT substr(created_at,1,10) AS d FROM guestbook_notes ORDER BY d DESC LIMIT 400
-- 结果只有几十个「天」，但 SQLite 必须**对每一行**算一次 substr、去重、再排序。实测查询计划：
--   SCAN guestbook_notes USING COVERING INDEX idx_guestbook_created
--   | USE TEMP B-TREE FOR DISTINCT
--   | USE TEMP B-TREE FOR ORDER BY          ← 两个临时 B 树，成本随留言总数线性增长
-- 加了 day 列 + 索引之后：
--   SCAN guestbook_notes USING COVERING INDEX idx_guestbook_day     ← 无临时 B 树，可提前收工
-- 两种写法在 40 天 / 1000 条样本上**结果逐项相同**（等价性已实测）。
--
-- ⚠️ ALTER TABLE ADD COLUMN 不是幂等的：如果这一列已存在，这段会报错，忽略即可（与
--    scripts/migrate-views.sql 同一处理方式）。但**下面的 UPDATE 与 CREATE INDEX 仍需执行**，
--    所以别因为「第一条报错」就整段放弃。
-- ⚠️ 新增列 + 索引之后，写入侧也要同步填 day（functions/api/guestbook.js 里 INSERT 已带上）；
--    没有这张列时，读取侧会自动退回旧查询，功能不受影响，只是慢一点。

ALTER TABLE guestbook_notes ADD COLUMN day TEXT;
UPDATE guestbook_notes SET day = substr(created_at, 1, 10) WHERE day IS NULL;
CREATE INDEX IF NOT EXISTS idx_guestbook_day ON guestbook_notes(day DESC);
