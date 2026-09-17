// functions/_middleware.js —— 给**所有函数响应**兜一层安全头。
//
// 放在 functions/ 根目录 = 覆盖全部由函数处理的路由：
//     /api/*                    （登录、注册、留言、发文…全站唯一需要防护的入口）
//     /sitemap.xml /feed.xml /robots.txt
//     /?post=<slug> 给爬虫返回的注入版首页（functions/index.js）
// 这些响应都不经过 `_headers`（那只管静态资源），所以必须在这一层补（见 _lib/security.js 顶部）。
//
// ⚠️ 这一层**只加不删**：只 set 那 6 个安全头，绝不碰 cache-control / content-type / set-cookie。
//    静态资源的 Cache-Control 来自 `_headers`，被这里改掉就是全站缓存策略崩掉。
//    守护里有对应断言：带 cache-control + 两个 set-cookie 的响应过一遍中间件后，
//    除那 6 个头之外必须逐字节不变。
//
// ⚠️ 用 onRequest（不是 onRequestGet）：写接口全是 POST/DELETE，漏了方法就等于没覆盖。
import { withSecurityHeaders } from "./_lib/security.js";

export async function onRequest(context) {
  const res = await context.next();
  try {
    return withSecurityHeaders(res);
  } catch (e) {
    // ⚠️ 不许静默：真出错时退回原始响应（站点照常工作，只是少几个头），但必须留下痕迹 ——
    //    否则「安全头集体消失」会变成看不见的故障，而这类故障正是这个站反复踩的坑。
    console.error("[security] 加安全头失败，放行原始响应：" + (e && e.message ? e.message : e));
    return res;
  }
}
