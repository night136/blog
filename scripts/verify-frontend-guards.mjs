// 前端行为约定守护：这几条都是踩过线上事故后定下来的，改动容易"顺手改回去"，用断言钉住。
// 用法：node scripts/verify-frontend-guards.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
const headersSrc = fs.readFileSync(path.join(root, "_headers"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

console.log("\n[1] 构建产物快照不得使用 force-cache");
{
  // 事故（2026-09-12）：force-cache = 无条件用本地缓存、永不校验。
  // 构建会更换封面文件名，旧快照里的封面全是死链 → 列表图集体消失且刷新也修不回来。
  check("app.js 里没有 cache:\"force-cache\"（改用 default / no-store）",
    !/cache\s*:\s*["'`]force-cache["'`]/.test(appSrc),
    "发现 cache:\"force-cache\"，会让快照永久停在被改名前的那一版");

  check("读 generated/posts.json 用 cache:\"default\"",
    /generated\/posts\.json"\s*,\s*\{\s*cache:\s*"default"/.test(appSrc),
    "未找到 cache:\"default\"");

  check("读 generated/posts/<slug>.json 用 cache:\"default\"",
    /generated\/posts\/\$\{encodeURIComponent\(slug\)\}\.json`\s*,\s*\{\s*cache:\s*"default"/.test(appSrc),
    "详情快照未使用 cache:\"default\"");

  check("_headers 给 posts.json 配了 SWR（default 才有意义）",
    /\/generated\/posts\.json[\s\S]{0,200}stale-while-revalidate/.test(headersSrc),
    "缺少 SWR 头");
}

console.log("\n[2] 封面加载失败必须能自愈，不能一次失败就永久隐藏");
{
  check("破图兜底带 cache-buster 重试（retry=）",
    /retry=/.test(appSrc), "未找到 retry cache-buster");
  check("卡片封面失败会尝试刷新快照（tryRefreshSnapshotForCovers）",
    /tryRefreshSnapshotForCovers/.test(appSrc), "未找到快照自愈逻辑");
  check("自愈用 cache:\"reload\" 绕过本地缓存",
    /cache:\s*"reload"/.test(appSrc), "未找到 cache:\"reload\"");
  check("重试上限为 2 次（不是 1 次就放弃）",
    /tries\s*<\s*2/.test(appSrc), "未找到 tries < 2");
}

console.log("\n[3] 详情页封面与列表缩略图保持同一种观感：固定画幅 + 裁剪");
{
  // 约定（用户 2026-09-12 明确）：详情页封面要跟列表封面一致 —— 都是固定画幅、object-fit:cover 裁掉上下。
  // 不要改成 contain / height:auto（宽高随图浮动、排版跳动，且与列表不一致）。
  const postCoverRules = cssSrc.match(/\.post-cover\s*\{[^}]*\}/g) || [];
  const hasCoverCrop = postCoverRules.some((r) => /object-fit:\s*cover/.test(r));
  const hasContain = postCoverRules.some((r) => /object-fit:\s*contain/.test(r));
  const hasFixedFrame = postCoverRules.some((r) => /aspect-ratio\s*:/.test(r) || /(^|[^-])height:\s*\d/.test(r));
  const hasAutoHeight = postCoverRules.some((r) => /height:\s*auto/.test(r));

  check("存在 .post-cover 规则且用 object-fit: cover", hasCoverCrop, postCoverRules.join(" ") || "未找到 .post-cover 规则");
  check("没有任何 .post-cover 规则用 object-fit: contain（会完整展示、与列表不一致）", !hasContain, postCoverRules.join(" "));
  check("详情页封面是固定画幅（aspect-ratio 或固定 height），裁剪可预期", hasFixedFrame, postCoverRules.join(" "));
  check("详情页封面不再用 height: auto（会让宽高随图浮动）", !hasAutoHeight, postCoverRules.join(" "));

  const cardCover = cssSrc.match(/\.card-cover-img\s*\{[^}]*\}/);
  check("列表卡片封面同为 object-fit: cover（两者观感一致）",
    !!cardCover && /object-fit:\s*cover/.test(cardCover[0]),
    cardCover ? cardCover[0] : "未找到 .card-cover-img 规则");
}

console.log("\n[4] 封面 URL 必须过安全函数");
{
  // 封面 URL 统一出口：coverUrl(p) = safeUrl + 剥离能在 url('…') 里提前闭合的字符。
  // 断言按「出口」而不是按「某个模板的字面写法」——写成字面量匹配时，任何一次重构
  // （比如这次给卡片封面加 data-cover 延迟下载）都会让守护失效或误报。
  const coverUrlFn = (appSrc.match(/function coverUrl\(p\)\s*\{[\s\S]{0,260}?\n  \}/) || [])[0] || "";
  check("存在封面 URL 统一出口 coverUrl()", !!coverUrlFn, "未找到 function coverUrl(p)");
  check("coverUrl 内部走 safeUrl", /safeUrl\(p\.cover, true\)/.test(coverUrlFn), "coverUrl 未调用 safeUrl");
  check("coverUrl 剥离引号/括号/反斜杠/空白（防 url('…') 里提前闭合注入 CSS）",
    /replace\(\/\[\x27"\(\)\\\\\\s\]\/g, ""\)/.test(coverUrlFn), "未做字符剥离：" + coverUrlFn.slice(0, 120));

  check("卡片封面走 coverUrl", /const coverSrc = coverUrl\(p\)/.test(appSrc) && /escapeHtml\(coverSrc\)/.test(appSrc),
    "卡片封面未走 coverUrl + escapeHtml");
  check("卡片封面不得直接拼 p.cover", !/card-cover-img[^`]{0,120}safeUrl\(p\.cover/.test(appSrc),
    "卡片封面仍在模板里直接拼 p.cover");
  check("轮播封面走 coverUrl", /const url = coverUrl\(p\)/.test(appSrc), "轮播封面未走 coverUrl");
  check("详情封面走 safeUrl", /const heroCover = post\.cover \? safeUrl\(post\.cover, true\)/.test(appSrc),
    "详情封面未走 safeUrl");
}

console.log("\n[5] 缓存边界：公开只读接口可缓存，含登录态/权限态的接口一律不许");
{
  // 背景（2026-09-15）：服务端早就在发 public, max-age=60/300，前端却一律写 cache:"no-store"，
  // 把这些头全废掉了 —— 浏览器每次都跨境去边缘取。真浏览器实测（.diag/cache-behavior.mjs，
  // 判据 fromDiskCache）：/api/config 239ms → 3ms、/api/posts 199ms → 2ms。
  //
  // 但 no-store 在另几个接口上是**安全边界**，不是性能旋钮：
  // 这些响应含「谁在登录 / 能不能删」，一旦落进浏览器缓存，
  // 同浏览器换账号、或登出后重进，就会看到上一个身份的界面。
  const readSrc = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
  const meFn = readSrc("functions/api/me.js");
  const gbFn = readSrc("functions/api/guestbook.js");
  const searchFn = readSrc("functions/api/posts/search.js");

  // ── 可以缓存的：响应体全是公开数据 ──
  check('/api/config 用 cache:"default"（只有公开 Site Key，服务端 max-age=300）',
    /api\/config"\s*,\s*\{\s*credentials:\s*"same-origin",\s*cache:\s*"default"/.test(appSrc),
    '仍是 no-store —— 每次访问都要跨境取一个几乎不变的字符串');
  check('/api/posts 用 cache:"default"（列表字段全公开，服务端 max-age=60）',
    /fetchJSON\("\/api\/posts"\s*,\s*\{\s*cache:\s*"default"/.test(appSrc),
    "仍是 no-store");

  // ── 不许缓存的：含身份 / 权限 / 会失效的结果 ──
  check('/api/me 仍用 cache:"no-store"（它回答「谁在登录」）',
    /fetch\("\/api\/me"[^)]{0,80}cache:\s*"no-store"/.test(appSrc),
    "会话接口被改成可缓存 —— 换账号/登出后会看到上一个身份的界面");
  check('/api/guestbook 仍用 cache:"no-store"（含 canDelete / currentUser）',
    /fetch\("\/api\/guestbook"[^)]{0,80}cache:\s*"no-store"/.test(appSrc),
    "权限态接口被改成可缓存 —— 登出后 30s 内仍会显示删除按钮");
  check('/api/posts/search 仍用 cache:"no-store"（结果会因文章增删而失效）',
    /posts\/search\?q=\$\{[^}]*\}[^)]{0,90}cache:\s*"no-store"/.test(appSrc),
    "搜索被改成可缓存 —— 删掉的文章会在结果里残留，点进去 404");
  check('/api/posts/meta 仍用 cache:"no-store"（它是新鲜度探针，缓存它＝自废武功）',
    /api\/posts\/meta"\s*,\s*\{\s*cache:\s*"no-store"/.test(appSrc),
    "探针被缓存 —— 发布后 60s 内自检会拿到旧 count，误判快照是新的");
  check("粗粒度兜底：app.js 里 no-store 至少 5 处（会话/留言墙/分页/搜索/探针）",
    (appSrc.match(/cache:\s*"no-store"/g) || []).length >= 5,
    "no-store 被批量删过，逐条断言可能有漏网的");

  // ── 服务端第二道防线（前端万一被改错也兜得住）──
  check("服务端 /api/me 显式声明 no-store（不再交给浏览器的启发式规则）",
    /Cache-Control":\s*"no-store"/.test(meFn),
    "me.js 未声明缓存策略");
  check("服务端 guestbook 登录态不标 public（只有访客版本可被缓存）",
    /username\s*\?\s*"private, no-store"\s*:\s*"public/.test(gbFn),
    "含 canDelete 的响应仍标 public —— 前端一旦改 default 就会把权限态缓存下来");
  check("服务端 search 显式声明 no-store",
    /"Cache-Control":\s*"no-store"/.test(searchFn),
    "search.js 未声明缓存策略");

  // ── 负向变异：这条断言本身有效吗 ──
  const mutated = appSrc.replace(
    /fetch\("\/api\/guestbook",\s*\{\s*credentials:\s*"same-origin",\s*cache:\s*"no-store"\s*\}\)/,
    'fetch("/api/guestbook", { credentials: "same-origin", cache: "default" })'
  );
  check("变异（把 /api/guestbook 改成 default）会被判红",
    mutated !== appSrc && !/fetch\("\/api\/guestbook"[^)]{0,80}cache:\s*"no-store"/.test(mutated),
    "变异未生效或未被识破 —— 这条断言等于没测");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
