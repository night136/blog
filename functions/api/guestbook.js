// /api/guestbook
//   GET  ：列出最近 200 条便签（按 created_at desc），同时告知前端当前是否站长（用于显示删除按钮）
//   POST ：公开创建便签 —— 校验长度、按 ip_hash 限频、随机分配颜色
// 留言墙是公开功能（无需登录），但删除便签需要站长（复用 BLO_OWNER 机制）
import { json, verifyJWT, getCookie, isOwner } from "./_lib/auth.js";
import { verifyTurnstile } from "./_lib/turnstile.js";

const MAX_NAME = 20;
const MAX_CONTENT = 200;
const COLORS = ["blue", "pink", "yellow", "purple", "green", "orange", "mint"];
const LIMIT = 200;            // 兼容旧值
const PAGE_SIZE = 50;         // 分页默认页大小（优化 #6）
const MAX_PAGE_SIZE = 100;    // 单页上限，防止前端传过大
const DAILY_LIMIT = 5;        // 每天每 IP 最多 5 条

// 用 SHA-256(IP + secret) 哈希，不存原 IP（隐私）
async function hashIp(ip, secret) {
  const data = new TextEncoder().encode((ip || "") + "|" + (secret || ""));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Cloudflare 边缘一般会带 CF-Connecting-IP；X-Forwarded-For 是兜底
function getIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    ""
  );
}

async function getCurrentUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const p = await verifyJWT(token, env.JWT_SECRET || "dev-secret-change-me");
    return p.username || p.sub || p.name || null;
  } catch (_) { return null; }
}

// 在 UTC+8 时区下取"今天 0 点"的字符串（YYYY-MM-DD 00:00），用于与 D1 中 created_at 字符串比较
function todayStartUtc8() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (x) => String(x).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} 00:00`;
}

function nowUtc8() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (x) => String(x).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
}

// "YYYY-MM-DD" 加减天数
function addDays(s, n) {
  const [y, m, d] = String(s).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const pad = (x) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// 连续打卡天数（streak）：
//   今天写了 → 从今天往前数；今天还没写但昨天写了 → 从昨天往前数（今天不算断签）；
//   昨天也没写 → 已断签，返回 0。
function calcStreak(dates) {
  const set = new Set((dates || []).filter(Boolean));
  if (!set.size) return 0;
  const today = todayStartUtc8().slice(0, 10);
  let cursor = set.has(today) ? today : addDays(today, -1);
  if (!set.has(cursor)) return 0;
  let n = 0;
  while (set.has(cursor)) { n++; cursor = addDays(cursor, -1); }
  return n;
}

export async function onRequestGet({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);

  const username = await getCurrentUsername(request, env);
  const canDelete = isOwner(username, env);

  // 边缘缓存 30s（公开只读，IP 限频靠前端 short-poll 与云端错峰足够）
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch (_) {}

  try {
    // 分页参数：默认 50/页，上限 100/页（优化 #6）
    //   ?limit=N      每页条数
    //   ?before=...   created_at 游标（"YYYY-MM-DD HH:MM"）
    //   ?before_id=N  同时间戳时的 id 游标
    const url = new URL(request.url);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("limit") || PAGE_SIZE)));
    const before = url.searchParams.get("before");
    const beforeId = Math.max(0, Number(url.searchParams.get("before_id") || 0));
    const useCursor = !!(before && beforeId);

    let query, bind;
    if (useCursor) {
      // 严格小于 (created_at, id) 的元组（按 desc 取下一页）
      query = "SELECT id, name, content, color, created_at FROM guestbook_notes WHERE (created_at < ?) OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?";
      bind = [before, before, beforeId, limit + 1];
    } else {
      query = "SELECT id, name, content, color, created_at FROM guestbook_notes ORDER BY created_at DESC, id DESC LIMIT ?";
      bind = [limit + 1];
    }
    const { results } = await env.BLOG_DB.prepare(query).bind(...bind).all();
    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? { before: last.created_at, before_id: last.id } : null;

    // 顶部统计：总数 + 连续打卡天数
    let total = 0;
    let streak = 0;
    try {
      const cRow = await env.BLOG_DB.prepare("SELECT COUNT(*) AS c FROM guestbook_notes").first();
      total = (cRow && Number(cRow.c)) || 0;
      const dRes = await env.BLOG_DB.prepare(
        "SELECT DISTINCT substr(created_at, 1, 10) AS d FROM guestbook_notes ORDER BY d DESC LIMIT 400"
      ).all();
      streak = calcStreak((dRes.results || []).map((r) => r.d));
    } catch (_) { /* 统计失败不影响便签展示 */ }

    const turnstileSiteKey = env.TURNSTILE_SITE_KEY || null;
    const body = JSON.stringify({ ok: true, notes: page, canDelete, total, streak, turnstileSiteKey, hasMore, nextCursor, currentUser: username || null });
    const response = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30, s-maxage=30",
      },
    });
    try { await cache.put(cacheKey, response.clone()); } catch (_) {}
    return response;
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }

  const username = await getCurrentUsername(request, env);
  // 已登录用户：服务端强制用登录名（前端再隐藏「你的名字」栏，杜绝前端被改后伪造署名）
  const inputName = ((body.name || "").toString().trim().slice(0, MAX_NAME)) || "";
  const name = (username && username.trim().slice(0, MAX_NAME)) || inputName || "匿名";
  const contentRaw = (body.content || "").toString().trim();
  if (!contentRaw) return json({ ok: false, error: "便签内容不能为空" }, 400);
  if (contentRaw.length > MAX_CONTENT) {
    return json({ ok: false, error: `便签内容不能超过 ${MAX_CONTENT} 字` }, 400);
  }
  const content = contentRaw;

  // Turnstile 人机验证（若配置了 SECRET）
  const ts = await verifyTurnstile(
    body.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    getIp(request)
  );
  if (!ts.success) {
    return json({ ok: false, error: ts.error || "人机验证失败，请重试" }, 403);
  }

  // 随机颜色（前端也会用同样的色板作为兜底）
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  // IP 限频（每天每 IP 最多 5 条；无 IP 信息时不限制 —— 仅出现在极少数本地调试场景）
  const ip = getIp(request);
  const ipHash = ip ? await hashIp(ip, env.JWT_SECRET || "dev-secret-change-me") : null;
  if (ipHash) {
    try {
      const { results } = await env.BLOG_DB.prepare(
        "SELECT COUNT(*) AS c FROM guestbook_notes WHERE ip_hash = ? AND created_at >= ?"
      ).bind(ipHash, todayStartUtc8()).all();
      const c = (results[0] && Number(results[0].c)) || 0;
      if (c >= DAILY_LIMIT) {
        return json({ ok: false, error: `今天已经写了不少啦（每天最多 ${DAILY_LIMIT} 条），明天再来吧~` }, 429);
      }
    } catch (_) { /* 限频查询失败不阻塞提交 */ }
  }

  const createdAt = nowUtc8();

  try {
    const { meta } = await env.BLOG_DB.prepare(
      "INSERT INTO guestbook_notes (name, content, color, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(name, content, color, ipHash, createdAt).run();
    return json({
      ok: true,
      note: { id: meta.last_row_id, name, content, color, created_at: createdAt },
    });
  } catch (e) {
    return json({ ok: false, error: "写入失败：" + (e && e.message ? e.message : e) }, 500);
  }
}