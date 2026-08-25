-- 给 posts 表新增 words 列：存储文章字数（发布/更新时由后端计算并写入）。
-- 列表接口据此计算「约 N 分钟」阅读时长，从而无需 SELECT body
-- （body 含 base64 图片，单篇可达 1.9MB，首页若读取会把所有文章图片一并从 D1 搬出，严重拖慢）。
-- 执行方式（Cloudflare D1 控制台 或 wrangler）：
--   D1 控制台 → 选中 blog 数据库 → 粘贴下面这行执行即可。
ALTER TABLE posts ADD COLUMN words INTEGER NOT NULL DEFAULT 0;
