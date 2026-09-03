// Cloudflare Turnstile 人机验证（服务端校验）
// 说明：未配置 TURNSTILE_SECRET_KEY 时直接放行，保证未配置的环境下功能不受影响。
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// 校验前端提交的 token；返回 { success, error }
export async function verifyTurnstile(token, secret, remoteip) {
  if (!secret) return { success: true }; // 未启用
  if (!token) return { success: false, error: "请完成人机验证" };
  const body = new URLSearchParams();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteip) body.append("remoteip", remoteip);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await res.json();
    const codes = Array.isArray(j["error-codes"]) ? j["error-codes"].join(", ") : "";
    return { success: j.success === true, error: codes || "人机验证失败，请重试" };
  } catch (_) {
    return { success: false, error: "验证服务暂时不可用，请稍后再试" };
  }
}

// 取客户端 IP（Cloudflare 边缘一般带 CF-Connecting-IP，X-Forwarded-For 兜底）
export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    ""
  );
}
