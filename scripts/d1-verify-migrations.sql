-- D1 迁移完成度核验（在 Cloudflare 控制台 → D1 → 你的库 → Console 逐条粘贴执行）
--
-- 为什么需要这份：本项目两条手工迁移的代码都写了**优雅降级** ——
--   · login_attempts 表不存在 ⇒ 登录照常可用，只是没有失败限频；
--   · guestbook_notes.day 列不存在 ⇒ 自动退回 substr 查询，功能不受影响，只是慢。
--   两者都只留一行 console.error。所以 **"线上没报错 / 功能正常" 证明不了迁移做了没有。**
--
-- 而且它们**从外部不可验证**（实测结论，别白费力气）：
--   · /api/login 有 Turnstile 前置 ⇒ 无 token 的请求直接 403，走不到限频逻辑，
--     那个 X-Login-Delay 响应头从外部拿不到；
--   · day 列的两条查询路径**结果逐项相同**（这正是设计目标），公开接口也不暴露天数集合。
--
-- ⚠️ 逐条执行、逐条比对。**不要把这几条拼成一条**：①③⑤ 引用不同的表/列，
--    其中任何一项不存在都会让整条语句报错，于是其余项的结论一并丢失。
--
-- 期望：①② = 1，③ 的 day_null = 0，④ 恰好 3 行，⑤ 能执行不报错。


-- ① login_attempts 表建了没有？
--    期望 login_attempts_table = 1
--    （查 sqlite_master，所以表不存在也不会报错，只返回 0 —— 这就是它适合当第一条的原因）
SELECT COUNT(*) AS login_attempts_table
FROM sqlite_master
WHERE type = 'table' AND name = 'login_attempts';


-- ② guestbook_notes 加了 day 列没有？
--    期望 guestbook_day_col = 1
--    （pragma_table_info 对不存在的表返回空集，同样不会报错）
SELECT COUNT(*) AS guestbook_day_col
FROM pragma_table_info('guestbook_notes')
WHERE name = 'day';


-- ③ day 列的历史行**回填**了没有？（这一步最容易被漏）
--    期望 rows_day_null = 0
--    报 "no such column: day"  ⇒ ② 没做（ALTER 没执行）
--    rows_day_null > 0          ⇒ ALTER 执行了但 UPDATE 漏跑
--      ⚠️ 这个疏忽不会有任何外部症状：读取侧带 WHERE day IS NOT NULL，
--         历史行会被静静过滤掉，只在"连续打卡天数"上表现为与历史对不上。
SELECT COUNT(*) AS rows_total, SUM(day IS NULL) AS rows_day_null
FROM guestbook_notes;


-- ④ 迁移配套的三个索引齐不齐？
--    期望恰好 3 行：idx_guestbook_day / idx_login_attempts_ip / idx_login_attempts_user
--    少哪行就是哪条的 CREATE INDEX 没执行（索引漏了功能正常，但优化白做）
SELECT name FROM sqlite_master
WHERE type = 'index'
  AND name IN ('idx_guestbook_day', 'idx_login_attempts_ip', 'idx_login_attempts_user')
ORDER BY name;


-- ⑤ 参考：失败计数表现状
--    能执行不报错 ⇒ 表可用。failures 长期为 0 且你确实输错过密码 ⇒ 写入路径值得看一眼。
--    报 "no such table" ⇒ ① 没做。
SELECT COUNT(*) AS attempts_total, SUM(success = 0) AS failures, SUM(success = 1) AS successes
FROM login_attempts;
