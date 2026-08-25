// SEO 共享工具：站点地址、XML 转义、文章链接
export function siteUrl(env) {
  const raw = (env && env.SITE_URL) || "https://blog-6p3.pages.dev";
  return raw.replace(/\/+$/, "");
}

export function xesc(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function postUrl(env, slug) {
  return `${siteUrl(env)}/?post=${encodeURIComponent(slug)}`;
}
