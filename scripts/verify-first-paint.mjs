// 首绘/打开文章的关键路径守护。
//
// 为什么需要这个脚本：这一轮的三个问题（打开文章要等装饰请求、字体阻塞首绘、
// 正文内嵌图把详情撑到 1MB）都属于**「代码看起来没坏、只是慢」**的类型 ——
// 没有任何语法错误、没有任何报错、功能全对，只是用户要多等几秒。
// 这类退化最容易在后续重构里被悄悄改回去（比如为了省事把 `await checkSession()`
// 挪回渲染之前），所以必须把「顺序」和「不要在 <head> 放跨站阻塞样式表」钉死。
//
// 用法：node scripts/verify-first-paint.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBuildArtifactBody } from "../functions/_lib/cover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
const htmlSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");
const buildSrc = fs.readFileSync(path.join(root, "build.mjs"), "utf8");
const manageSrc = fs.readFileSync(path.join(root, "functions", "api", "posts", "manage.js"), "utf8");
const coverLibSrc = fs.readFileSync(path.join(root, "functions", "_lib", "cover.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}
// 剥掉注释再比对：改动说明里会大量**提到**被禁的东西（解释为什么禁），
// 全文匹配会把注释误判成代码。这个坑在 verify-lunar-core 里踩过一次。
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const appCode = strip(appSrc);
const buildCode = strip(buildSrc);
const manageCode = strip(manageSrc);

// openPost 的函数体切片。
// ⚠️ 结束标记必须用**代码**而不是注释：本脚本的 appCode 已经剥掉注释，
// 拿注释当边界会切出空串 —— 而空串会让后续断言全部「看似通过」，是典型的假绿。
function openPostBody(src) {
  const start = src.indexOf("async function openPost(slug) {");
  const end = src.indexOf("function renderReadTime(post) {", start);
  if (start < 0) return "";
  return src.slice(start, end > start ? end : start + 6000);
}

console.log("\n[1] 打开文章：正文渲染不等装饰性请求");
{
  const body = openPostBody(appCode);
  check("能定位到 openPost 函数体", body.length > 500, "切片长度=" + body.length);

  const iRender = body.indexOf("postDetail.innerHTML =");
  // 装饰性请求：会话（决定编辑/删除按钮）与阅读数 +1。两者都是 no-store，永不缓存，
  // 原先串行挡在渲染之前 —— 线上实测（暖缓存）静态正文 563ms 就到、正文却 1171ms 才出现。
  const deco = body.search(/await ensureSession\(|await checkSession\(|\/api\/posts\/view/);
  check("正文渲染发生在装饰性请求之前",
    iRender > 0 && (deco < 0 || deco > iRender),
    "innerHTML 位置=" + iRender + "，装饰请求位置=" + deco);

  const iPatch = body.indexOf("patchPostMeta(slug, seq, fromStatic)");
  check("渲染之后才调用 patchPostMeta 补齐装饰信息",
    iPatch > iRender && iPatch > 0,
    "patchPostMeta 位置=" + iPatch);

  check("patchPostMeta 每个 await 之后都复查 stale()（快速切文章不串内容）",
    /async function patchPostMeta[\s\S]{0,2200}?const stale = \(\) => seq !== openSeq[\s\S]{0,2200}?if \(stale\(\)\) return;/.test(appCode),
    "未找到 stale() 复查");

  check("阅读数只在静态加载时补 +1（动态接口已 +1，不能重复计数）",
    /if \(!fromStatic\) return;[\s\S]{0,400}?\/api\/posts\/view/.test(appCode),
    "缺少 fromStatic 判定，可能出现重复计数");

  // 编辑/删除按钮是用事件委托绑定的，所以「渲染后再异步插入」才成立 ——
  // 若哪天改成逐次 addEventListener，patchPostMeta 后插的按钮就会变成死按钮。
  check("编辑/删除按钮走事件委托（后插入的按钮同样可点）",
    /e\.target\.closest\("\.post-edit"\)/.test(appCode) && /e\.target\.closest\("\.post-del"\)/.test(appCode),
    "按钮不再是事件委托，后插入的按钮会失效");

  check("详情页阅读时长只有一处格式化入口（模板留空，统一走 renderReadTime）",
    /<span class="read-time"><\/span>/.test(appCode) &&
    /renderReadTime\(post\);/.test(body) &&
    /function renderReadTime\(post\)/.test(appCode),
    "详情模板仍内联格式化，或未调用 renderReadTime");

  check("openPost 的兜底 catch 会记日志（不再静默吞异常）",
    /console\.error\("\[post\] 打开文章失败"/.test(appCode),
    "catch 仍未记录日志");
}

console.log("\n[2] 会话校验去重（同一页面不再发两次 /api/me）");
{
  const calls = (appCode.match(/checkSession\(\)/g) || []).length;
  check("ensureSession 存在且复用同一个 promise",
    /function ensureSession\(\)[\s\S]{0,600}?if \(!sessionPromise\)/.test(appCode),
    "未找到 ensureSession 去重逻辑");
  check("checkSession() 只被定义处和 ensureSession 引用（共 2 处）",
    calls === 2, "实际出现 " + calls + " 次");
  check("启动段用 ensureSession()，不再直接 checkSession()",
    /^\s*ensureSession\(\);\s*$/m.test(appCode) && !/^\s*checkSession\(\);\s*$/m.test(appCode),
    "启动段仍是 checkSession()");
  check("会话失败后允许下次重试（不把一次抖动永久钉死）",
    /catch\(\(\) => \{ sessionPromise = null; sessionReady = false; return null; \}\)/.test(appCode),
    "失败分支未清空 sessionPromise");
}

console.log("\n[3] 网页字体不再阻塞首绘");
{
  // 比对前剥掉 HTML 注释：改动说明里**必须**提到「不要用 media=print onload」这件事，
  // 拿原文全文匹配会把那句解释当成违规实现（这个坑在本脚本里已经出现两次了）。
  // ⚠️ 声明必须在本块最前：放在使用之后会踩 TDZ（本脚本第一版就是这么挂的）。
  const htmlCode = htmlSrc.replace(/<!--[\s\S]*?-->/g, "");
  const blocking = /<link[^>]+fonts\.font\.im[^>]*rel=["']?stylesheet/i.test(htmlCode) ||
    /<link[^>]+rel=["']?stylesheet[^>]+fonts\.font\.im/i.test(htmlCode);
  check("index.html 里没有跨站阻塞的字体样式表",
    !blocking, "仍存在 <link rel=stylesheet href=fonts.font.im…>");
  check("保留 preconnect（注入虽晚，握手可提前）",
    /<link rel="preconnect" href="https:\/\/fonts\.font\.im"/.test(htmlSrc),
    "preconnect 缺失");
  check("app.js 在首绘之后注入字体（两层 rAF）",
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(loadWebFont\)\)/.test(appCode),
    "未找到首绘后注入");
  check("注入的 link 标了 data-optional（失败不弹「资源加载失败」横幅）",
    /link\.setAttribute\("data-optional", "1"\)/.test(appCode),
    "缺少 data-optional");
  check("index.html 的全局错误监听会过滤 data-optional",
    /getAttribute\('data-optional'\)/.test(htmlSrc.replace(/\s+/g, " ")),
    "全局错误监听未过滤可选资源，字体失败会弹假告警");
  // 比对前剥掉 HTML 注释（理由见块首）
  check("没有用 media=print + onload 切换（小米/360 兼容模式会永久失效）",
    !/media=["']print["'][^>]*onload/i.test(htmlCode) && !/onload="this\.media/i.test(appCode),
    "又出现了 media=print onload 切换");
  check("字体 URL 只请求 400/700/900 三档",
    /wght@400;700;900/.test(appCode) && !/;600\b/.test(appCode),
    "字重档位变了");
}

console.log("\n[4] 正文内嵌图不再进入详情快照");
{
  // 详情写入必须在图片抽离之后 —— 否则详情里还是原始 markdown（含 base64）。
  const iMat = buildCode.indexOf("materializeBodyImages(row.body");
  const iWrite = buildCode.indexOf("writeFileSync(join(POST_DIR");
  check("正文图片抽离发生在写详情 JSON 之前",
    iMat > 0 && iWrite > iMat, "抽离位置=" + iMat + "，写详情位置=" + iWrite);
  check("详情用的是抽离后的正文（markdown），不是 row.body",
    /publicDetail\(row, cover, words, markdown\)/.test(buildCode), "publicDetail 未传入 markdown");
  check("publicDetail 的 body 字段来自入参而非 row.body",
    /function publicDetail\([\s\S]{0,900}?body: bodyMd,/.test(buildCode),
    "publicDetail 仍写 body: row.body");
  check("字数按发布出去的正文统计",
    /const words = countWords\(markdown\)/.test(buildCode), "仍按 row.body 统计字数");
  check("爬虫片段仍用抽离后的正文",
    /bodyHtml: renderMarkdown\(markdown\)/.test(buildCode), "爬虫片段未使用 markdown");
}

console.log("\n[5] 正文构建产物绊线（防止把 /generated/body-images/ 写回 D1）");
{
  check("cover.js 导出 isBuildArtifactBody", /export function isBuildArtifactBody\(/.test(coverLibSrc));
  check("manage.js 引入并使用了该守卫",
    /import \{[^}]*isBuildArtifactBody[^}]*\}/.test(manageSrc) &&
    /if \(isBuildArtifactBody\(mdBody\)\)/.test(manageCode),
    "manage.js 未使用 isBuildArtifactBody");
  check("绊线在 UPDATE 之前返回（不能先写库再报错）",
    manageCode.indexOf("isBuildArtifactBody(mdBody)") < manageCode.indexOf("UPDATE posts SET"),
    "守卫位置晚于 UPDATE");
  check("绊线返回 400 而不是静默保留（正文改动必须让用户知道）",
    /artifact_body[\s\S]{0,120}?400\)/.test(manageCode),
    "未返回 400/code:artifact_body");

  // 正/负样本：这条守卫既要拦住事故，又不能误伤「正文里引用该路径的技术文章」
  const must = [
    ["markdown 站内路径", "![图](/generated/body-images/ab12cd34.jpg)"],
    ["markdown 绝对 URL", "![图](https://blog-6p3.pages.dev/generated/body-images/ab12cd34.jpg)"],
    ["HTML <img> 写法", '<p><img src="/generated/body-images/ab12cd34.png" alt=""></p>'],
    ["带空格的 markdown", "![a b](/generated/body-images/x.webp)"],
  ];
  const mustNot = [
    ["原始 base64（正常正文）", "![图](data:image/jpeg;base64,AAAA)"],
    ["站内普通图片", "![图](/assets/logo-hero.png)"],
    ["正文提到该路径（代码示例）", "产物路径形如 /generated/body-images/abcdef01.jpg 的文件"],
    ["封面产物路径", "![图](/generated/covers/ab12cd34-deadbeef.jpg)"],
    ["空正文", ""],
    ["null", null],
  ];
  let ok = true, bad = "";
  for (const [n, s] of must) if (!isBuildArtifactBody(s)) { ok = false; bad += `漏判「${n}」;`; }
  for (const [n, s] of mustNot) if (isBuildArtifactBody(s)) { ok = false; bad += `误判「${n}」;`; }
  check("正负样本全部正确（含「技术文章里引用该路径」不得误伤）", ok, bad);
}

console.log("\n[6] 编辑器不拿快照正文预填（否则保存即丢原图）");
{
  const iEdit = appCode.indexOf('e.target.closest(".post-edit")');
  const handler = iEdit >= 0 ? appCode.slice(iEdit, iEdit + 1600) : "";
  check("「编辑」按钮一律从动态接口取原始正文",
    /\/api\/posts\/detail/.test(handler), "edit 分支未请求 /api/posts/detail");
  check("不再直接把 currentPost（静态快照）交给 openCompose",
    !/openCompose\(currentPost\)/.test(appCode), "又出现了 openCompose(currentPost)");
  check("取不到原文时不进编辑器（宁可重试也不拿快照顶替）",
    /载入原始正文失败[\s\S]{0,300}?toast\(/.test(appCode),
    "失败分支可能仍进入编辑器");
  // 调用点只有两处带括号：函数定义 + 「拿到动态原文后」的那一次。
  // 两个按钮是直接 addEventListener("click", openCompose) 传函数引用（不带括号），
  // 它们触发的入参是 Event 对象（没有 .slug）→ 走「新建文章」分支，不会带进快照正文。
  const calls = appCode.match(/openCompose\([^)]*\)/g) || [];
  check("openCompose 的两处调用都只可能是「新建」或「拿到原文后」",
    calls.length === 2 && calls.every((c) => c === "openCompose(post)" || c === "openCompose(data.post)"),
    "实际调用：" + calls.join(" | "));
}

console.log("\n[7] 骨架屏不再做「整块重绘」型动画");
{
  const rule = (cssSrc.match(/\.skeleton \{[^}]*\}/) || [])[0] || "";
  check("能定位到 .skeleton 规则", rule.length > 0);
  check(".skeleton 不再动 background-position / background-size",
    !/background-position|background-size/.test(rule), "规则：" + rule);
  const kf = (cssSrc.match(/@keyframes shimmer \{[^}]*\}/) || [])[0] || "";
  check("shimmer 改为 transform 位移（只走合成器）",
    /transform\s*:\s*translateX/.test(kf) && !/background-position/.test(kf), "关键帧：" + kf);
  check("覆盖层不拦指针事件",
    /\.skeleton::after \{[^}]*pointer-events: none/.test(cssSrc),
    "::after 可能挡住卡片点击");
}

console.log("\n[8] 负向自检：把上面的判定逻辑作用在「改坏的源码」上，必须变红");
{
  // 没有这一节，前面所有断言都可能是「永远为真」的摆设（项目里踩过：函数名写错导致负向测试静默失效）
  const looksRearranged = (src) => {
    const b = openPostBody(strip(src));
    const iRender = b.indexOf("postDetail.innerHTML =");
    const deco = b.search(/await ensureSession\(|await checkSession\(|\/api\/posts\/view/);
    return iRender > 0 && (deco < 0 || deco > iRender);
  };
  const good = openPostBody(appCode);
  const movedUp = "async function openPost(slug) {\n  await ensureSession();\n  postDetail.innerHTML = \"x\";\n}\n// 阅读时长/字数/阅读数这一行的唯一格式化入口";
  check("变异①（把会话请求挪回渲染前）会被判红", looksRearranged(movedUp) === false);
  check("原实现仍判绿（说明判定不是永远为假）", looksRearranged(appSrc) === true);

  const skeletonOk = (src) => {
    const r = (src.match(/\.skeleton \{[^}]*\}/) || [])[0] || "";
    const k = (src.match(/@keyframes shimmer \{[^}]*\}/) || [])[0] || "";
    return !/background-position|background-size/.test(r) && /transform\s*:\s*translateX/.test(k);
  };
  const brokenCss = cssSrc.replace(/@keyframes shimmer \{[^}]*\}/, "@keyframes shimmer { to { background-position: -100% 0 } }");
  check("变异②（shimmer 改回 background-position）会被判红", skeletonOk(brokenCss) === false);
  check("原样式仍判绿", skeletonOk(cssSrc) === true);

  const detailUsesExtracted = (src) => {
    const s = strip(src);
    return s.indexOf("materializeBodyImages(row.body") > 0 &&
      s.indexOf("materializeBodyImages(row.body") < s.indexOf("writeFileSync(join(POST_DIR") &&
      /publicDetail\(row, cover, words, markdown\)/.test(s);
  };
  const brokenBuild = buildSrc.replace("publicDetail(row, cover, words, markdown)", "publicDetail(row, cover, words, row.body)");
  check("变异③（详情改回用 row.body）会被判红", detailUsesExtracted(brokenBuild) === false);
  check("原 build 仍判绿", detailUsesExtracted(buildSrc) === true);

  check("变异④（守卫放行产物图片）会被单测抓到",
    isBuildArtifactBody("![图](/generated/body-images/ab12cd34.jpg)") === true &&
    isBuildArtifactBody("正文提到 /generated/body-images/ 目录") === false);
}

console.log("\n[9] 台账（记录本轮线上实测，供以后对比）");
{
  // 2026-09-15 用真实浏览器（本机 Edge + CDP，scripts/perf-probe.mjs）实测，非估算：
  console.log("  暖缓存：首页列表/侧栏 368ms · 文章正文 1171ms（其中 ~608ms 花在装饰请求上）");
  console.log("  冷缓存：FCP 1296ms（字体阻塞 ~400ms）· 首页列表 1425ms");
  console.log("  详情快照：16 篇里 7 篇含内嵌图，含图平均 530KB，最大 1,148,543 字节；不含图仅 0.8KB");
  console.log("  字体：CSS 未压缩 339KB / gzip 91KB / 303 条 @font-face / 101 个子集");
  check("探针脚本仍在（以后要复测就用它）",
    fs.existsSync(path.join(here, "perf-probe.mjs")) || fs.existsSync(path.join(root, ".diag", "perf-probe.mjs")),
    "没有找到真实浏览器性能探针");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
