// /api/posts
//   GET  : 列出全部文章（按 date desc）——供前台首页/归档/会员视图直接 fetch
//   POST : 会员发文章（验证 JWT → 写入 posts 表）
import { verifyJWT, getCookie, json } from "./_lib/auth.js";
import { readingTime } from "../_lib/readingTime.js";

const MAX_TITLE = 120;
// 正文允许嵌 base64 图片：D1 单行上限 2,000,000 字节，正文留 1.9MB 余量（其他列也占空间）
const MAX_BODY = 1900000;
const MAX_TAG = 30;
const MAX_SUMMARY = 200;
// 封面可能是 base64 长串（正文首图自动当封面），放宽上限；单行总上限 2MB 由 D1 兜底
const MAX_COVER = 1900000;

function safeSlug(title) {
  return (
    title
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "untitled"
  );
}

function todayStr() {
  const n = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function publicPost(row) {
  // 列表接口读取预存的 words 列（发布/更新时已算好写入 D1），不再 SELECT body，
  // 避免把每篇文章的 base64 图片从数据库搬出来，首页加载大幅提速
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

export async function onRequestGet({ env }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  try {
    // 关键优化：列表只 SELECT 文本列，绝不 SELECT body（body 含 base64 图片，单篇可达 1.9MB，
    // 首页若读取会把所有文章的 base64 一并从 D1 搬出，严重拖慢）。字数 words 在发布/更新时已算好存入。
    // 列缺失则逐级降级，兼容未执行迁移的库（words/views 默认 0），且任何分支都不读 body。
    const COLS_FULL = "id, slug, title, date, tag, summary, cover, author_username, views, words";
    const COLS_NO_WORDS = "id, slug, title, date, tag, summary, cover, author_username, views";
    const COLS_BASE = "id, slug, title, date, tag, summary, cover, author_username";
    let results;
    try {
      ({ results } = await env.BLOG_DB.prepare(
        `SELECT ${COLS_FULL} FROM posts ORDER BY date DESC, id DESC`
      ).all());
    } catch (e) {
      const msg = (e && e.message) ? e.message : "";
      if (/no such column: words/i.test(msg)) {
        ({ results } = await env.BLOG_DB.prepare(
          `SELECT ${COLS_NO_WORDS} FROM posts ORDER BY date DESC, id DESC`
        ).all());
        results.forEach((row) => { row.words = 0; });
      } else if (/no such column: views/i.test(msg)) {
        ({ results } = await env.BLOG_DB.prepare(
          `SELECT ${COLS_BASE} FROM posts ORDER BY date DESC, id DESC`
        ).all());
        results.forEach((row) => { row.views = 0; row.words = 0; });
      } else throw e;
    }
    // 边缘缓存：列表为公开只读数据，边缘节点缓存 60s，过期后后台重新校验（stale-while-revalidate）
    return json(
      { ok: true, posts: results.map(publicPost) },
      200,
      { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" }
    );
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  // 1. 验证会话
  const token = getCookie(request, "auth");
  let username;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    username = payload.username || payload.sub || payload.name;
  } catch (e) {
    return json({ ok: false, error: "请先登录" }, 401);
  }
  if (!username) return json({ ok: false, error: "会话无效" }, 401);
  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  // 2. 解析与校验
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const title = (body.title || "").trim();
  const tag = (body.tag || "未分类").trim().slice(0, MAX_TAG) || "未分类";
  const summary = (body.summary || "").trim().slice(0, MAX_SUMMARY);
  const coverInput = (body.cover || "").trim().slice(0, MAX_COVER);
  const mdBody = (body.body || "").trim();

  if (!title) return json({ ok: false, error: "标题不能为空" }, 400);
  if (title.length > MAX_TITLE) return json({ ok: false, error: "标题过长（最多 120 字）" }, 400);
  if (!mdBody) return json({ ok: false, error: "正文不能为空" }, 400);
  if (mdBody.length > MAX_BODY) return json({ ok: false, error: "正文过长（图片较多时请减少，单篇上限约 1.9MB）" }, 400);

  // 未手动填封面 → 从正文抽第一张图当封面（支持 data: 与 http(s) 链接）
  let cover = coverInput;
  if (!cover) {
    const m = mdBody.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
    if (m) cover = m[1].slice(0, MAX_COVER);
  }

  // 3. 生成 slug（日期 - 标题 - 短哈希防重名）
  const date = todayStr();
  const slug = `${date}-${safeSlug(title)}-${parseInt(String(Date.now() % 1000000)).toString(36)}`;

  // 4. 写入 D1
  try {
    const { words } = readingTime(mdBody);
    await env.BLOG_DB.prepare(
      `INSERT INTO posts (slug, title, date, tag, summary, cover, author_username, body, words)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        title,
        date,
        tag,
        summary || null,
        cover || null,
        username,
        mdBody,
        words
      )
      .run();
  } catch (e) {
    return json({ ok: false, error: "写入失败：" + (e && e.message ? e.message : e) }, 500);
  }

  return json({ ok: true, slug, message: "文章已发布！刷新首页即可看到。" });
}