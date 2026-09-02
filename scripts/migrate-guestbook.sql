-- 留言墙（便签墙 / 感恩日记）—— 在 Cloudflare D1 Console 粘贴执行
-- 用于公开留言墙功能：游客可写、可选名字、随机颜色卡片，无需登录。
CREATE TABLE IF NOT EXISTS guestbook_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT '匿名',
  content    TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT 'blue',
  ip_hash    TEXT,                              -- SHA-256(IP + JWT_SECRET)，用于限频；不存原 IP
  created_at TEXT    NOT NULL                   -- 形如 "2026-09-02 18:30"（UTC+8）
);
CREATE INDEX IF NOT EXISTS idx_guestbook_created ON guestbook_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guestbook_ip      ON guestbook_notes(ip_hash, created_at);