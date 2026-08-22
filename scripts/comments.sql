-- 评论表（在 Cloudflare D1 Console 粘贴执行）
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '匿名',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parent_id INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(post_slug);

-- 若表已存在（之前建过、现在要加点赞数与楼中楼），分别执行下面两句补列：
-- ALTER TABLE comments ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE comments ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0;
