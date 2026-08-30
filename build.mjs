// build.mjs — 静态预渲染
// 构建时用 Cloudflare D1 REST API 拉全部文章，生成静态 JSON，供前端经 CDN 直读：
//   generated/posts.json              → 列表（不含 body）
//   generated/posts/<slug>.json       → 单篇详情（含 body）
// 容错：任何异常都不抛出，保证 Pages 部署不因构建失败而中断；前端在静态缺失时降级到 Function。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "generated");
const LIST_FILE = join(OUT_DIR, "posts.json");
const POST_DIR = join(OUT_DIR, "posts");

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DB = process.env.CF_DATABASE_ID;
const TOKEN = process.env.CF_API_TOKEN;

// 与 functions/_lib/readingTime.js 完全一致的字数算法
function countWords(md) {
  const text = (md || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/[#*`\[\](){}|>\-]/g, "");
  const cjkChars = (text.match(/[一-龥]/g) || []).length;
  const nonCjkWords = text
    .replace(/[一-龥]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((x) => x).length;
  return cjkChars + nonCjkWords;
}

function publicList(row) {
  const words = row.words || 0;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: row.cover || "",
    author: row.author_username || "昉昕",
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    views: row.views || 0,
  };
}

function publicDetail(row) {
  const words = countWords(row.body);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: row.cover || "",
    author: row.author_username || "昉昕",
    isAuthor: false, // 静态无法判断当前用户，前端打开时按会话修正
    views: row.views || 0,
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    body: row.body,
  };
}

async function main() {
  if (!ACCOUNT || !DB || !TOKEN) {
    console.warn("[build] 未配置 CF_ACCOUNT_ID / CF_DATABASE_ID / CF_API_TOKEN，跳过静态生成；前端将降级到 Function。");
    return;
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  async function d1(sql) {
    const r = await fetch(api, { method: "POST", headers: auth, body: JSON.stringify({ sql }) });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    return j.result;
  }
  const res = await d1(
    "SELECT id, slug, title, date, tag, summary, cover, author_username, views, body, words FROM posts ORDER BY date DESC, id DESC"
  );
  const rows = res[0].results;
  mkdirSync(POST_DIR, { recursive: true });
  // 列表附带新鲜度元信息：静态快照无法感知数据库后续新增，前端据此校验是否过期
  // （Deploy Hook 未生效 / 部署延迟时，前端自动回退动态接口，保证发布后一定能看到）
  writeFileSync(
    LIST_FILE,
    JSON.stringify({
      ok: true,
      count: rows.length,
      latest: rows.length ? rows[0].slug : "",
      generatedAt: new Date().toISOString(),
      posts: rows.map(publicList),
    })
  );
  for (const row of rows) {
    writeFileSync(join(POST_DIR, `${row.slug}.json`), JSON.stringify({ ok: true, post: publicDetail(row) }));
  }
  console.log(`[build] 已生成 ${rows.length} 篇文章静态 JSON → generated/`);
}

main().catch((e) => {
  // 构建失败不应中断部署：前端会降级到 Function
  console.warn("[build] 静态生成失败，已忽略（前端降级到 Function）：", e && e.message ? e.message : e);
});
