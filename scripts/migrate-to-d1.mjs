#!/usr/bin/env node
// 把现有 content/posts/*.md 导入 D1 的迁移脚本。
// 用法：
//   1) 本地生成 SQL：node scripts/migrate-to-d1.mjs > scripts/migrate-data.sql
//   2) 上传 D1（需 wrangler 或在 Cloudflare 控制台 Web 界面粘贴执行）

import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

const POSTS_DIR = resolve("content/posts");

function sqlEscape(s) {
  return String(s ?? "")
    .replace(/'/g, "''")
    .replace(/\r\n/g, "\n");
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split("\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > -1) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      meta[k] = v;
    }
  });
  return { meta, body: m[2] || "" };
}

// 解析日期：文件名里 2026-08-09 开头 → date，否则用 frontmatter.date，最后兜底 1970-01-01
function deriveDate(filename, meta) {
  if (meta.date && /^\d{4}-\d{2}-\d{2}$/.test(meta.date)) return meta.date;
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return "1970-01-01";
}

// 解析 slug：从文件名去掉日期前缀和 .md，再把非安全字符换成 -
function deriveSlug(filename) {
  let s = basename(filename, ".md");
  s = s.replace(/^\d{4}-\d{2}-\d{2}-?/, "");
  s = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || "untitled";
}

const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md"));
console.log("-- 由 scripts/migrate-to-d1.mjs 自动生成");
console.log("-- 共 " + files.length + " 篇文章\n");

for (const f of files) {
  const raw = readFileSync(resolve(POSTS_DIR, f), "utf8");
  const { meta, body } = parseFrontmatter(raw);

  const title = meta.title || deriveSlug(f);
  const date = deriveDate(f, meta);
  const slug = deriveSlug(f);
  const tag = meta.tag || "未分类";
  const summary = meta.summary || body.replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim();
  const cover = meta.cover || "";
  const author = meta.author || "昉昕";

  console.log(`-- 来源：${f}`);
  console.log(
    `INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES (` +
      `'${sqlEscape(slug)}', ` +
      `'${sqlEscape(title)}', ` +
      `'${sqlEscape(date)}', ` +
      `'${sqlEscape(tag)}', ` +
      `${summary ? `'${sqlEscape(summary)}'` : "NULL"}, ` +
      `${cover ? `'${sqlEscape(cover)}'` : "NULL"}, ` +
      `'${sqlEscape(author)}', ` +
      `'${sqlEscape(body)}');`
  );
  console.log();
}