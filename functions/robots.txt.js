// /robots.txt —— 允许抓取并指向 sitemap
import { siteUrl } from "./_lib/seo.js";

export async function onRequestGet({ env }) {
  const base = siteUrl(env);
  const txt = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
  return new Response(txt, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
