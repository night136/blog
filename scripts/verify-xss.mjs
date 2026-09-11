// XSS 回归测试：验证正文 Markdown 渲染（mdToHtml）与 URL 白名单（safeUrl）
// 背景：正文由任何注册用户撰写，之前 esc() 不转义引号、URL 不做协议白名单，
// 可闭合 href/src 属性注入 onerror 等事件处理器（存储型 XSS）。
// 用法：node scripts/verify-xss.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, "..", "assets", "app.js");
const code = fs.readFileSync(appPath, "utf8");

// 从 IIFE 中按大括号配平抽取函数源码（函数内 ${} 模板插值成对，不影响配平）
function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("未找到函数：" + name);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error("大括号不配平：" + name);
}

const bundle =
  extractFn(code, "safeUrl") + "\n" +
  extractFn(code, "escapeHtml") + "\n" +
  extractFn(code, "mdToHtml") + "\n" +
  "globalThis.__md = mdToHtml; globalThis.__safe = safeUrl; globalThis.__esc = escapeHtml;";

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: "md-extract.js" });
const mdToHtml = sandbox.__md;
const escapeHtml = sandbox.__esc;

// 从一段 HTML 里抽取所有开始标签的属性名。
// 关键：属性值一律是双引号包裹、且内容里的引号已被转义成 &quot;，
// 因此用 "[^"]*" 匹配属性值，位于值内部的 "onxxx=" 文本不会被误认成属性。
function attrNames(html) {
  const names = [];
  for (const m of html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gi)) {
    for (const a of m[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"[^"]*"/g)) names.push(a[1].toLowerCase());
  }
  return names;
}
function hasEventHandler(html) {
  return attrNames(html).some((n) => n.startsWith("on"));
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

console.log("\n[1] 原始 HTML 注入");
{
  const out = mdToHtml('<script>alert(1)</script>');
  check("script 标签被转义为实体", !/<script/i.test(out) && /&lt;script&gt;/.test(out), out);
  const out2 = mdToHtml('<img src=x onerror=alert(1)>');
  check("img onerror 原文不产生事件属性", !hasEventHandler(out2), out2);
}

console.log("\n[2] 链接协议白名单");
{
  const js = mdToHtml('[点我](javascript:alert(1))');
  check("javascript: 链接被拦截，降级为纯文本", !/<a\s/i.test(js) && /点我/.test(js) && !/javascript:/i.test(js), js);

  const vb = mdToHtml('[x](vbscript:msgbox(1))');
  check("vbscript: 链接被拦截", !/<a\s/i.test(vb), vb);

  const dataHtml = mdToHtml('[x](data:text/html;base64,PHNjcmlwdD4=)');
  check("data:text/html 链接被拦截", !/<a\s/i.test(dataHtml), dataHtml);

  const ok = mdToHtml('[官网](https://example.com/a?b=1&c=2)');
  check("https 链接放行且补 noopener nofollow", /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/.test(ok) && /rel="noopener nofollow"/.test(ok), ok);

  const rel = mdToHtml('[站内](/posts/hello)');
  check("站内相对路径放行", /<a href="\/posts\/hello"/.test(rel), rel);

  const mail = mdToHtml('[邮件](mailto:a@b.com)');
  check("mailto 放行", /<a href="mailto:a@b\.com"/.test(mail), mail);
}

console.log("\n[3] 图片协议白名单");
{
  const js = mdToHtml('![x](javascript:alert(1))');
  check("javascript: 图片被拦截", !/<img/i.test(js), js);

  const svg = mdToHtml('![x](data:image/svg+xml;base64,PHN2Zz4=)');
  check("data:image/svg+xml 被拦截（防 SVG 脚本）", !/<img/i.test(svg), svg);

  const png = mdToHtml('![x](data:image/png;base64,iVBORw0KGgo=)');
  check("data:image/png 放行（站内 base64 封面）", /<img src="data:image\/png;base64,iVBORw0KGgo="/.test(png), png);

  const rel = mdToHtml('![x](/generated/covers/abc.png)');
  check("相对路径图片放行", /<img src="\/generated\/covers\/abc\.png"/.test(rel), rel);
}

console.log("\n[4] 属性闭合注入");
{
  const out = mdToHtml('[x](https://a.com" onmouseover="alert(1))');
  check("URL 内引号无法闭合 href、不产生 on* 属性", !hasEventHandler(out), out);

  const out2 = mdToHtml('![a](https://a.com"onerror="alert(1))');
  check("URL 内引号无法闭合 img src、不产生 on* 属性", !hasEventHandler(out2), out2);

  const out3 = mdToHtml('" onmouseover="alert(1)');
  check("正文文本中的引号被转义", /&quot;/.test(out3) && !hasEventHandler(out3), out3);
}

console.log("\n[5] 正常 Markdown 能力未被破坏");
{
  check("标题 ##", /<h2 id="sec-1">标题<\/h2>/.test(mdToHtml("## 标题")), mdToHtml("## 标题"));
  check("加粗 **b**", /<strong>b<\/strong>/.test(mdToHtml("**b**")), mdToHtml("**b**"));
  check("行内代码 `c`", /<code>c<\/code>/.test(mdToHtml("`c`")), mdToHtml("`c`"));
  check("列表 - a", /<ul><li>a<\/li><\/ul>/.test(mdToHtml("- a")), mdToHtml("- a"));
  const fence = mdToHtml("```js\nif (a < b) x=\"1\";\n```");
  check("代码块保留代码并转义 < 与引号",
    /<pre><code class="language-js">if \(a &lt; b\) x=&quot;1&quot;;<\/code><\/pre>/.test(fence), fence);
  check("引用 > q", /<blockquote><p>q<\/p><\/blockquote>/.test(mdToHtml("> q")), mdToHtml("> q"));
}

console.log("\n[6] escapeHtml 覆盖单引号");
{
  check("单引号转义为 &#39;", escapeHtml("it's") === "it&#39;s", escapeHtml("it's"));
  check("双引号转义为 &quot;", escapeHtml('a"b') === "a&quot;b", escapeHtml('a"b'));
}

console.log("\n" + (fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`));
process.exitCode = fail === 0 ? 0 : 1;
