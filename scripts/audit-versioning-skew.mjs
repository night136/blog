// 只读探针：旧壳引用的 app.js?v=<旧哈希> 现在返回的是什么内容？（docs §二十）
// 为什么不能带 ?cb=：本次要观测的**就是那个缓存键本身**，加 cb 等于换了另一个键，观测无效。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.join(import.meta.dirname, "..");
const OUT = path.join(root, ".diag", "out", "versioning");
fs.mkdirSync(OUT, { recursive: true });

const sha = (s) => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex").slice(0, 10);

// 1) 从 git 里取出「上一版」的 app.js —— 也就是陈旧外壳里写死的那个版本号。
//    ⚠️ 别硬编码提交号（下次部署就过时）：自动取"最近两次改动 app.js 的提交"里的前一个。
const revs = execFileSync("git", ["log", "-2", "--format=%H", "--", "assets/app.js"],
  { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const PREV_COMMIT = revs[1] || revs[0];
const oldSrc = execFileSync("git", ["show", `${PREV_COMMIT}:assets/app.js`], { cwd: root, encoding: "utf8" });
const oldVer = sha(oldSrc);
const curSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const curVer = sha(curSrc);
console.log(`上一版 app.js 来自提交 ${PREV_COMMIT.slice(0, 7)}，版本号 = ${oldVer}`);
console.log(`当前   app.js 版本号 = ${curVer}`);
console.log(`上一版含旧写法 fd.get("password2")：${/fd\.get\("password2"\)/.test(oldSrc)}`);
console.log(`当前版含护栏 if (!p2El)         ：${/if \(!p2El\)/.test(curSrc)}\n`);

async function probe(label, url) {
  const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const body = await r.text();
  const age = r.headers.get("age");
  const out = path.join(OUT, `${label}.js`);
  fs.writeFileSync(out, body);
  const isOld = /fd\.get\("password2"\)/.test(body);
  const isNew = /if \(!p2El\)/.test(body);
  console.log(`【${label}】`);
  console.log(`  URL      : ${url}`);
  console.log(`  HTTP     : ${r.status}  字节 ${body.length}  age=${age ?? "(无)"}  内容哈希 ${sha(body)}`);
  console.log(`  含旧写法 : ${isOld}    含新护栏 : ${isNew}`);
  console.log(`  ⇒ 返回的是：${isOld && !isNew ? "旧代码" : isNew && !isOld ? "新代码" : "无法判定"}\n`);
  return { isOld, isNew, ver: sha(body) };
}

const BASE = "https://blog-6p3.pages.dev";
// 2) 旧壳里写死的那个键（= 旧版内容哈希）。故意不带任何防缓存参数。
const a = await probe(`old-key-${oldVer}`, `${BASE}/assets/app.js?v=${oldVer}`);
// 3) 对照：当前 HTML 真正引用的键
const b = await probe(`cur-key-${curVer}`, `${BASE}/assets/app.js?v=${curVer}`);

console.log("─".repeat(60));
if (a.isNew) {
  console.log("结论：旧缓存键现在返回**新内容** ⇒ 「旧 HTML + 新 app.js」在缓存层失效后必然发生，");
  console.log("      方向 A 是真实路径，元素存在性护栏不是白加的。");
} else if (a.isOld) {
  console.log("结论：旧缓存键仍返回**旧内容** ⇒ 边缘把该键的旧条目留住了（swr=604800），");
  console.log("      方向 A 在边缘层被缓释；但浏览器侧该键缓存过期回源时仍会拿到新内容 ⇒ 护栏仍必要。");
} else {
  console.log("结论：无法判定（两个标记都没出现或都出现）");
}
if (!b.isNew) console.log("⚠️ 当前键居然不是新内容 —— 版本化机制没生效，需要排查");
