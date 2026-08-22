-- 评论表（在 Cloudflare D1 Console 粘贴执行）
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '匿名',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(post_slug);

-- 若表已存在（之前建过、现在要加点赞数），执行下面这一句补列即可：
-- ALTER TABLE comments ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
