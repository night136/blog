// a11y / 键盘体验守护（audit §七 #15 #16 #19 #20）
//
// 这四条共同的特征是：**坏了不会有任何报错**。
//   #15 灯箱没焦点管理 → 键盘用户 Tab 到背后的页面里，读屏软件继续念被遮住的内容；
//   #16 没有 skip link / aria-current → 每次翻页都要 Tab 过全部导航；读屏念不出"当前在哪一页"；
//   #19 滚动监听未节流 → 不是"错"，是每帧白算 4~8 次（读 scrollY 会强制同步布局）；
//   #20 返回列表跳回顶部 → 读者刚看到第 8 张卡片，点进去看一眼，回来从头滚。
// 都只能靠断言钉住，所以这里把每条拆成"可判定的不变量"，再各配一条**负向自证**。
//
// ⚠️ 断言只盯**目标**，不盯实现字符串：
//    上一轮 verify-no-tdz 里「假哈希必须是 salt:hash 格式」就是反面教材 —— 哈希格式一升级
//    断言就变红，而代码完全正确。所以这里的每条都问"这件事还能发生吗"，而不是"这句话还在吗"。
//
// 用法：node scripts/verify-a11y.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 取一段花括号配对的函数体（够用即可：待检查的函数体里没有"字符串里带花括号"的情况） ──
function bodyOf(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ── HTML 标签扫描：用于"第一个可聚焦元素是谁"这类顺序判定 ──
function scanTags(html) {
  const tags = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    tags.push({ name: m[1].toLowerCase(), attrs: m[2], at: m.index });
  }
  return tags;
}
const attrOf = (t, k) => {
  const m = t.attrs.match(new RegExp(`(?:^|\\s)${k}(?:="([^"]*)")?(?=\\s|$)`));
  return m ? (m[1] === undefined ? "" : m[1]) : null;
};

// ══ 判据集做成纯函数：负向自证复用同一套判据，而不是另写一套 ══
function audit({ html, js, css }) {
  const r = [];
  const add = (name, ok, detail = "") => r.push({ name, ok, detail });
  const tags = scanTags(html);
  const bodyAt = html.indexOf("<body");

  // ── #15 灯箱焦点管理 ──
  {
    const lb = tags.find((t) => attrOf(t, "id") === "lightbox");
    add("#15 灯箱声明为对话层（role=dialog）", !!lb && attrOf(lb, "role") === "dialog",
      lb ? lb.attrs.trim().slice(0, 120) : "找不到 #lightbox");
    add("#15 灯箱是模态的（aria-modal=true）", !!lb && String(attrOf(lb, "aria-modal")) === "true");
    add("#15 灯箱有可读名字（aria-label / aria-labelledby）",
      !!lb && (attrOf(lb, "aria-label") || attrOf(lb, "aria-labelledby")),
      "没有可访问名时读屏只念得出一个「×」");

    const openBody = bodyOf(js, "function openLightbox(") || "";
    const showAt = openBody.indexOf(".hidden = false");
    const focusAt = openBody.indexOf(".focus()");
    add("#15 打开灯箱后把焦点移进灯箱（显示之后才 focus）",
      showAt >= 0 && focusAt > showAt,
      `hidden=false@${showAt} focus@${focusAt}（-1 表示没找到）`);

    const closeBody = bodyOf(js, "function closeLightbox(") || "";
    add("#15 关闭灯箱时把焦点还给触发元素",
      /lightboxReturnFocus/.test(closeBody) && /\.focus\(\)/.test(closeBody),
      "closeLightbox 里没有「把焦点还给打开它的那个元素」的逻辑");

    add("#15 灯箱内 Tab 会回卷（keydown 绑定了焦点锁）",
      /lightbox\.addEventListener\("keydown",\s*trapLightboxFocus\)/.test(js)
      && /function trapLightboxFocus\(/.test(js)
      && /preventDefault\(\)/.test(bodyOf(js, "function trapLightboxFocus(") || ""),
      "aria-modal 只是声明，不加回卷 Tab 会跑到被遮住的页面上去");

    // 灯箱由"点击正文图"触发 —— 图不能聚焦，键盘用户就永远打不开它，前面三条全白做
    const zoomable = /tabindex="0"[^\n]{0,80}aria-haspopup="dialog"|aria-haspopup="dialog"[^\n]{0,80}tabindex="0"/.test(js);
    add("#15 正文图片可聚焦（否则键盘用户打不开灯箱）", zoomable,
      "mdToHtml 的 <img> 上没有 tabindex/aria-haspopup ⇒ 灯箱只有鼠标能用");
    add("#15 键盘能打开灯箱（Enter / 空格与点击等效）",
      /postDetail\.addEventListener\("keydown"/.test(js) && /e\.key !== "Enter"/.test(js),
      "只绑了 click，键盘用户没有等价操作");
  }

  // ── #16 skip link + aria-current ──
  {
    const isFocusable = (t) => {
      if (t.at < bodyAt) return false;
      if (t.name === "a") return !!attrOf(t, "href");
      if (["button", "input", "select", "textarea"].includes(t.name)) {
        return attrOf(t, "type") !== "hidden" && attrOf(t, "disabled") === null;
      }
      const ti = attrOf(t, "tabindex");
      return ti !== null && Number(ti) >= 0;
    };
    const firstFocusable = tags.find(isFocusable);
    const skip = tags.find((t) => (attrOf(t, "class") || "").includes("skip-link"));
    add("#16 存在 skip link", !!skip, "找不到 class 含 skip-link 的元素");
    add("#16 skip link 是文档里**第一个**可聚焦元素",
      !!skip && !!firstFocusable && skip.at === firstFocusable.at,
      firstFocusable ? `第一个可聚焦元素是 <${firstFocusable.name}>${firstFocusable.attrs.trim().slice(0, 80)}` : "没有可聚焦元素？");
    const href = skip ? String(attrOf(skip, "href") || "") : "";
    const targetId = href.startsWith("#") ? href.slice(1) : "";
    const target = targetId ? tags.find((t) => attrOf(t, "id") === targetId) : null;
    add("#16 skip link 指向站内一个真实存在的锚点", !!target, `href=${href || "(空)"}`);
    add("#16 落点可被脚本聚焦（tabindex=-1）",
      !!target && Number(attrOf(target, "tabindex")) === -1,
      "锚点跳转默认只滚动、不移焦点；少了 tabindex=-1，下一个 Tab 仍从顶栏继续");

    // 视觉隐藏不能把可聚焦性一起隐藏掉
    const skipRules = (css.match(/\.skip-link[^{]*\{[^}]*\}/g) || []).join("\n");
    add("#16 skip link 的视觉隐藏没有破坏可聚焦性",
      skipRules.length > 0
      && !/display\s*:\s*none/.test(skipRules)
      && !/visibility\s*:\s*hidden/.test(skipRules)
      && !/clip\s*:\s*rect\(0/.test(skipRules.replace(/clip-path[^;]*;/g, ""))
      && /:focus/.test(skipRules),
      skipRules ? skipRules.replace(/\s+/g, " ").slice(0, 160) : "找不到 .skip-link 规则");

    // aria-current 必须与 .active 同源同步
    const sv = bodyOf(js, "function showView(") || "";
    add("#16 切换视图时同步设置 aria-current（光有 .active 只有视觉）",
      /setAttribute\("aria-current"/.test(sv) && /removeAttribute\("aria-current"\)/.test(sv),
      "showView 里没有 aria-current 的增删");
  }

  // ── #19 顶栏滚动监听节流 ──
  {
    // 文件里有**多处** scroll 监听（还有阅读进度、目录高亮等各自一个）。
    // 认"哪一个是顶栏那个"不能靠出现顺序 —— 得认它引用了 rAF 的状态变量 scrollRaf，
    // 否则拿到的是别的监听，判出「没有 rAF」的假故障（第一次跑就踩了）。
    const anchor = js.indexOf("scrollRaf = requestAnimationFrame(applyScrollState)");
    const at = anchor < 0 ? -1 : js.lastIndexOf('window.addEventListener("scroll"', anchor);
    const seg = at >= 0 ? js.slice(at, at + 400) : "";
    add("#19 滚动监听用 requestAnimationFrame 节流",
      /requestAnimationFrame\(/.test(seg) && /if \(scrollRaf\) return;/.test(seg),
      at < 0 ? "找不到 scroll 监听" : seg.replace(/\s+/g, " ").slice(0, 160));
    add("#19 滚动监听标记 passive（不阻塞滚动）", /passive:\s*true/.test(seg));
    add("#19 滚动监听体内不再直接做 class 切换（只有排队，没有计算）",
      !/classList\.toggle/.test(seg),
      "监听回调里仍有 classList.toggle ⇒ 每帧会被算多次");
    add("#19 注册之后立刻同步跑一次状态（刷新在页面中部时状态立刻正确）",
      /window\.addEventListener\("scroll",[\s\S]{0,300}?\}, \{ passive: true \}\);[\s\S]{0,200}?applyScrollState\(\);/.test(js),
      "同步首跑必须发生在监听注册**之后**，否则相当于没注册就被覆盖成坏状态");
  }

  // ── #20 返回列表恢复滚动位置 ──
  {
    const sv = bodyOf(js, "function showView(") || "";
    add("#20 离开视图时记下滚动位置",
      /viewScroll\[leaving\]\s*=\s*window\.scrollY/.test(sv),
      "showView 没有记录 scrollY");
    add("#20 回到访问过的视图时还原滚动位置",
      /viewScroll\[name\]/.test(sv) && /window\.scrollTo\(\{\s*top:\s*back/.test(sv),
      "showView 没有读取/使用记录下来的位置");
    // ⚠️ 还原那一次必须写 behavior:"instant"。写成 "auto" 是**看起来对、实则不生效**的写法：
    //    "auto" 的语义是"听 CSS 的 scroll-behavior"，而 style.css:82 给 html 设了 smooth，
    //    于是"回到原处"变成一段横跨整个列表的滚动动画（真浏览器实测：同一帧读回 scrollY 只有 2）。
    //    这个坑是 .diag/a11y-audit.mjs 在真浏览器里量出来的，静态断言看不出来，所以在这里钉死。
    add("#20 还原是瞬时跳转（behavior:instant），不是被 CSS 的 smooth 接管成动画",
      /window\.scrollTo\(\{\s*top:\s*back,\s*behavior:\s*"instant"\s*\}\)/.test(sv),
      "还原那一句没写 behavior:\"instant\" ⇒ 会被 html{scroll-behavior:smooth} 变成动画");
    add("#20 文章视图永远从顶部开始（不还原半截位置）",
      /name === "post"/.test(sv),
      "没有排除 post ⇒ 上一篇滚到 5000px 时下一篇也会从 5000px 打开");
    add("#20 存储的键只可能是已存在的视图（不会污染 Object 原型）",
      /Object\.create\(null\)/.test(js) && /views\[leaving\]/.test(sv));
    // 导航点击若自己再 scrollTo(0)，会把刚还原的位置立刻覆盖掉 —— 两处互相打架
    const navLine = (js.match(/navLinks\.forEach\(\(link\)[\s\S]{0,300}?\}\)\);/g) || []).join("\n");
    add("#20 导航点击不再自行 scrollTo(0)（否则覆盖刚还原的位置）",
      navLine.length > 0 && !/window\.scrollTo/.test(navLine),
      navLine.replace(/\s+/g, " ").slice(0, 160));
  }
  return r;
}

// ⚠️ 这三个文件在 Windows 工作区里是 **CRLF**。判据与"造故障"里到处是跨行正则，
//    混着 \r 写会得到「明明有这段代码却匹配不到」的假故障 —— 统一归一成 LF 再做文本判定。
//    （只影响本脚本内存里的副本，不写回磁盘。）
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const FILES = { html: read("index.html"), js: read("assets/app.js"), css: read("assets/style.css") };

console.log("\n[1] 四条 a11y/体验判据");
const results = audit(FILES);
for (const a of results) check(a.name, a.ok, a.detail);

// ── 负向自证：每条判据都得能被打红，否则它只是恒真的摆设 ──
// 手法统一为「在生产码上做一次外科式替换 → 用**同一套**判据重跑 → 确认对应那条报红」。
// ⚠️ 替换一律用**正则**而不是整行字符串：行内注释/对齐空格一改，字符串匹配就落空，
//    而"没替换成功"会被误读成"判据没问题"（这个坑在 verify-inline-css 里已经踩过一次）。
// ⚠️ 每条都把「替换是否真的命中」单独判一次 —— 造故障失败 ≠ 判据通过。
console.log("\n[2] 负向自证（造故障必须让对应判据变红）");
{
  const mutations = [
    {
      label: "#15 去掉「打开灯箱时移入焦点」",
      file: "js",
      apply: (s) => s.replace(/if \(lightboxClose\) lightboxClose\.focus\(\);[^\n]*\n/, ""),
      expect: /#15 打开灯箱后把焦点移进灯箱/,
    },
    {
      label: "#15 去掉正文图的 tabindex（灯箱只剩鼠标可用）",
      file: "js",
      apply: (s) => s.replace(/const zoomable = alt \? '[^']*' : "";/, 'const zoomable = "";'),
      expect: /#15 正文图片可聚焦/,
    },
    {
      label: "#15 去掉点遮罩/Escape 之外的返回焦点逻辑",
      file: "js",
      apply: (s) => s.replace(/if \(back && back\.isConnected && typeof back\.focus === "function"\) back\.focus\(\);/,
        "/* 焦点不还回去了 */"),
      expect: /#15 关闭灯箱时把焦点还给触发元素/,
    },
    {
      label: "#16 把 skip link 挪到顶栏之后（不再是第一个 Tab 停靠点）",
      file: "html",
      apply: (s) => {
        const m = s.match(/[ \t]*<a class="skip-link" href="#main-content">跳到正文<\/a>\n/);
        if (!m) return s;
        return s.replace(m[0], "").replace('<main class="content"', m[0] + '    <main class="content"');
      },
      expect: /#16 skip link 是文档里\*\*第一个\*\*可聚焦元素/,
    },
    {
      label: "#16 落点去掉 tabindex=-1",
      file: "html",
      apply: (s) => s.replace('<main class="content" id="main-content" tabindex="-1">', '<main class="content" id="main-content">'),
      expect: /#16 落点可被脚本聚焦/,
    },
    {
      label: "#16 去掉 aria-current 的同步（只剩视觉 .active）",
      file: "js",
      apply: (s) => s.replace(/if \(on\) l\.setAttribute\("aria-current", "page"\);\s*\n\s*else l\.removeAttribute\("aria-current"\);/, ""),
      expect: /#16 切换视图时同步设置 aria-current/,
    },
    {
      label: "#19 滚动监听退回未节流",
      file: "js",
      apply: (s) => s.replace(
        /window\.addEventListener\("scroll",[\s\S]*?\n  \}, \{ passive: true \}\);/,
        'window.addEventListener("scroll", () => {\n    if (backTop) backTop.classList.toggle("show", window.scrollY > 400);\n  }, { passive: true });'),
      expect: /#19 滚动监听用 requestAnimationFrame 节流/,
    },
    {
      label: "#20 去掉还原滚动位置",
      file: "js",
      apply: (s) => s.replace(
        /const back = \(name === leaving[\s\S]*?\n    else window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\);/,
        'window.scrollTo({ top: 0, behavior: "smooth" });'),
      expect: /#20 回到访问过的视图时还原滚动位置/,
    },
    {
      label: "#20 还原写回 behavior:auto（被 CSS smooth 接管成动画）",
      file: "js",
      apply: (s) => s.replace('window.scrollTo({ top: back, behavior: "instant" })', 'window.scrollTo({ top: back, behavior: "auto" })'),
      expect: /#20 还原是瞬时跳转/,
    },
    {
      label: "#20 导航点击自己再 scrollTo(0)（两处互相打架）",
      file: "js",
      apply: (s) => s.replace(
        'navLinks.forEach((link) => link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); }));',
        'navLinks.forEach((link) => link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); window.scrollTo({ top: 0 }); }));'),
      expect: /#20 导航点击不再自行 scrollTo\(0\)/,
    },
  ];

  for (const mu of mutations) {
    const mutated = mu.apply(FILES[mu.file]);
    if (mutated === FILES[mu.file]) {
      check(`负向自证：${mu.label}（造故障这一步本身必须成功）`, false,
        "替换没命中任何内容 —— 造故障失败不等于判据通过，请检查选择串是否已随代码漂移");
      continue;
    }
    const reds = audit({ ...FILES, [mu.file]: mutated }).filter((a) => !a.ok);
    const hit = reds.some((a) => mu.expect.test(a.name));
    check(`负向自证：${mu.label} ⇒ 判据变红`, hit,
      hit ? "" : `报红的是：${reds.map((a) => a.name).join(" / ") || "（一条都没红）"}`);
  }
}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS —— 四条静默失效（灯箱焦点/跳转链接/滚动节流/返回位置）都有断言钉住");
