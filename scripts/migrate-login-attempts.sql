-- 登录失败计数表（audit §五 第 2 件：登录失败限频）
-- 在 Cloudflare D1 Console 粘贴执行（每次只需执行一次；重复执行因 IF NOT EXISTS 而安全）
--
-- 为什么单独一张表而不是塞进 users：
--   · 计数维度是两个（用户名 + IP），一个用户会有多行；
--   · 失败记录里绝大多数对应的**根本不存在**的用户名，塞进 users 等于凭空造用户；
--   · 这张表可以随时整表清空（不影响任何账号数据）。
--
-- 隐私：只存 IP 的 SHA-256(IP + JWT_SECRET)，不存原 IP（与 guestbook_notes.ip_hash 同一套做法）。
--
-- ⚠️ 没有这张表时，登录**照常可用**，只是暂时没有失败限频（代码会优雅降级并打日志）。
--    所以这个迁移不是"必须马上做"，但做了才真正堵住暴力破解。

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash    TEXT,                              -- SHA-256(IP + JWT_SECRET)；取不到 IP 时为 NULL
  username   TEXT    NOT NULL DEFAULT '',       -- 归一化（小写去空白）后的登录名/邮箱
  success    INTEGER NOT NULL DEFAULT 0,        -- 1 = 成功，0 = 失败
  created_at TEXT    NOT NULL                   -- 形如 "2026-09-17 10:30:00"（UTC+8，与 guestbook 一致）
);

-- 计数只有两种查法，索引照着它们建（都带 success = 0 与 created_at >= 的条件）
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, success, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip   ON login_attempts(ip_hash, success, created_at DESC);
