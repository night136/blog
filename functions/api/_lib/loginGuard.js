// 登录失败计数 + 递增延迟（audit §五 第 2 件）
//
// 背景：`/api/login` 曾是全站唯一**没有任何失败限制**的入口。注册要过人机验证、留言要过
// 人机验证 + 每日 5 条限频，而登录只要用户名密码 —— 攻击者不需要注册，对着它无限试即可。
//
// 设计取舍（这一条最值得说清）：
//   · **递增延迟，不做硬锁。** 硬锁（「失败 N 次后拒绝该账号 N 分钟」）看起来更"安全"，
//     但它把一把**远程 DoS 的扳机**交给了任何人：知道你的用户名就能每天把你锁在门外。
//     递增延迟只让攻击者的**每次猜测更贵**，而真主人输错几次后最多等几秒就能照常登录。
//   · 计数维度是「用户名」与「IP」两个，取**较大**的那个决定延迟 ——
//     只按 IP 计，分布式换 IP 就绕过了；只按用户名计，撞库（一个密码试很多账号）就绕过了。
//   · ⚠️ 表**不存在**时必须优雅降级（新表由运维在 D1 控制台手工建，见
//     scripts/migrate-login-attempts.sql）。降级的代价是"暂时没有限频"，
//     若改成让登录 500，就等于「迁移没做 ⇒ 全站登不进去」——那是把加固做成了故障。
//     但降级**必须留痕**（console.error 只报一次），不许静默。

import { hashIp } from "./auth.js";

export const WINDOW_MINUTES = 15;   // 统计窗口
export const FAIL_THRESHOLD = 5;    // 窗口内失败达到这个数才开始延迟
export const BASE_DELAY_MS = 400;   // 起始延迟
export const MAX_DELAY_MS = 5000;   // 延迟上限（再往上只会拖住真主人，对攻击者的边际收益很低）
const PRUNE_AFTER_HOURS = 48;       // 超过这个年龄的记录会被顺手清掉
const PRUNE_EVERY = 50;             // 约每 50 次尝试清一次（不必每次都清）

// 表缺失时只报一次，避免日志被刷爆（同时保证"不是静默失败"）
let missingTableLogged = false;

function pad(x) { return String(x).padStart(2, "0"); }

function fmtUtc8(msOffset = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + msOffset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function isMissingTable(e) {
  return /no such table/i.test(String((e && e.message) || e));
}

// 归一化登录名：登录允许用「用户名」或「邮箱」，两者大小写/空白差异不该被当成不同身份来计数
export function normalizeLoginId(id) {
  return String(id == null ? "" : id).trim().toLowerCase().slice(0, 128);
}

// 根据窗口内失败次数算延迟（纯函数，便于单测）
export function delayForFails(fails) {
  if (!Number.isFinite(fails) || fails < FAIL_THRESHOLD) return 0;
  const steps = Math.min(fails - FAIL_THRESHOLD, 10); // 2^10 足够到上限，避免溢出
  return Math.min(BASE_DELAY_MS * Math.pow(2, steps), MAX_DELAY_MS);
}

// 评估当前该等多久。返回 { delayMs, usernameFails, ipFails, degraded }
export async function evaluateThrottle(env, { username, ipHash }) {
  const out = { delayMs: 0, usernameFails: 0, ipFails: 0, degraded: false };
  if (!env || !env.BLOG_DB) { out.degraded = true; return out; }
  const since = fmtUtc8(-WINDOW_MINUTES * 60 * 1000);
  const id = normalizeLoginId(username);
  try {
    if (id) {
      const r = await env.BLOG_DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE success = 0 AND created_at >= ? AND username = ?"
      ).bind(since, id).first();
      out.usernameFails = Number((r && r.c) || 0);
    }
    if (ipHash) {
      const r = await env.BLOG_DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE success = 0 AND created_at >= ? AND ip_hash = ?"
      ).bind(since, ipHash).first();
      out.ipFails = Number((r && r.c) || 0);
    }
    out.delayMs = delayForFails(Math.max(out.usernameFails, out.ipFails));
  } catch (e) {
    if (isMissingTable(e)) {
      if (!missingTableLogged) {
        missingTableLogged = true;
        console.error("[loginGuard] login_attempts 表不存在：登录限频未生效。" +
          "请在 D1 执行 scripts/migrate-login-attempts.sql（登录本身不受影响）。");
      }
    } else {
      console.error("[loginGuard] 读取失败计数出错（本次不限频）：", e && e.stack ? e.stack : e);
    }
    out.degraded = true;
    out.delayMs = 0;
  }
  return out;
}

// 记一次尝试。成功时顺手把该身份的历史失败清掉（真主人输错几次后成功了，不该继续背着延迟）。
// 任何异常都只记日志、绝不上抛 —— 限频是加固，不能反过来变成登录的单点故障。
export async function recordAttempt(env, { username, ipHash, success }) {
  if (!env || !env.BLOG_DB) return;
  const id = normalizeLoginId(username);
  const now = fmtUtc8();
  try {
    await env.BLOG_DB.prepare(
      "INSERT INTO login_attempts (ip_hash, username, success, created_at) VALUES (?, ?, ?, ?)"
    ).bind(ipHash || null, id || "", success ? 1 : 0, now).run();

    if (success) {
      await env.BLOG_DB.prepare(
        "DELETE FROM login_attempts WHERE success = 0 AND username = ?"
      ).bind(id || "").run();
    } else if (Math.random() < 1 / PRUNE_EVERY) {
      await env.BLOG_DB.prepare(
        "DELETE FROM login_attempts WHERE created_at < ?"
      ).bind(fmtUtc8(-PRUNE_AFTER_HOURS * 3600 * 1000)).run();
    }
  } catch (e) {
    if (isMissingTable(e)) {
      if (!missingTableLogged) {
        missingTableLogged = true;
        console.error("[loginGuard] login_attempts 表不存在，失败计数未落库（不影响登录）。");
      }
    } else {
      console.error("[loginGuard] 写入失败计数出错（不影响本次登录）：", e && e.stack ? e.stack : e);
    }
  }
}

// 取 IP 的不可逆哈希（隐私：不存原 IP）
export async function ipHashOf(ip, secret) {
  if (!ip) return null;
  try { return await hashIp(ip, secret); } catch (_) { return null; }
}

// 等够延迟。Workers 按 CPU 计费，async sleep 期间不烧 CPU，所以延迟是"便宜"的惩罚。
export function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}
