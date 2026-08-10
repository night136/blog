// /api/posts
//   GET  : 列出全部文章（按 date desc）——供前台首页/归档/会员视图直接 fetch
//   POST : 会员发文章（验证 JWT → 写入 posts 表）
import { verifyJWT, getCookie, json } from "./_lib/auth.js";

const MAX_TITLE = 120;
const MAX_BODY = 50000;
const MAX_TAG = 30;
const MAX_SUMMARY = 200;
const MAX_COVER = 500;

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
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: row.cover || "",
    author: row.author_username || "昉昕",
    body: row.body,
  };
}

export async function onRequestGet({ env }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  try {
    const { results } = await env.BLOG_DB.prepare(
      "SELECT id, slug, title, date, tag, summary, cover, author_username, body FROM posts ORDER BY date DESC, id DESC"
    ).all();
    return json({ ok: true, posts: results.map(publicPost) });
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
  const cover = (body.cover || "").trim().slice(0, MAX_COVER);
  const mdBody = (body.body || "").trim();

  if (!title) return json({ ok: false, error: "标题不能为空" }, 400);
  if (title.length > MAX_TITLE) return json({ ok: false, error: "标题过长（最多 120 字）" }, 400);
  if (!mdBody) return json({ ok: false, error: "正文不能为空" }, 400);
  if (mdBody.length > MAX_BODY) return json({ ok: false, error: "正文过长（最多 50000 字）" }, 400);

  // 3. 生成 slug（日期 - 标题 - 短哈希防重名）
  const date = todayStr();
  const slug = `${date}-${safeSlug(title)}-${parseInt(String(Date.now() % 1000000)).toString(36)}`;

  // 4. 写入 D1
  try {
    await env.BLOG_DB.prepare(
      `INSERT INTO posts (slug, title, date, tag, summary, cover, author_username, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        title,
        date,
        tag,
        summary || null,
        cover || null,
        username,
        mdBody
      )
      .run();
  } catch (e) {
    return json({ ok: false, error: "写入失败：" + (e && e.message ? e.message : e) }, 500);
  }

  return json({ ok: true, slug, message: "文章已发布！刷新首页即可看到。" });
}