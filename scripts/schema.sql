-- 昉昕博客 D1 数据库结构
-- 数据库 ID 会在 wrangler 配置中绑定为 env.BLOG_DB

-- 会员表
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  email         TEXT,
  password_hash TEXT    NOT NULL,           -- 形如 "salt:hash" 的 PBKDF2 派生结果
  created_at    TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- 文章表
CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    UNIQUE NOT NULL,   -- 形如 "2026-08-10-some-title"
  title           TEXT    NOT NULL,
  date            TEXT    NOT NULL,           -- YYYY-MM-DD
  tag             TEXT    DEFAULT '未分类',
  summary         TEXT,
  cover           TEXT,
  author_username TEXT    NOT NULL,
  body            TEXT    NOT NULL,           -- 原始 Markdown 正文
  views           INTEGER NOT NULL DEFAULT 0,  -- 浏览量
  created_at      TEXT    DEFAULT (datetime('now')),
  updated_at      TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_username);
CREATE INDEX IF NOT EXISTS idx_posts_tag ON posts(tag);