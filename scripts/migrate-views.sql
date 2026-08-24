-- 为已存在的 posts 表增加「浏览量」列（在 Cloudflare D1 Console 粘贴执行）
-- 只需执行一次；若已执行过，再次执行会报错（列已存在），可忽略。
ALTER TABLE posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
