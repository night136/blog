// 封面「回存构建产物路径」防护回归
//
// 事故背景（2026-09）：build.mjs 会把 data: base64 封面抽离成静态文件
// /generated/covers/<hash>.jpg，并把**构建产物路径**写进 generated/posts.json 与
// generated/posts/<slug>.json。编辑器从快照加载文章 → 封面输入框被预填成这条路径 →
// 用户只改正文点保存 → D1 里的原始 data: 封面被覆盖。而 generated/ 不入版本库、
// 每次构建还可能改名/消失 → 原图永久丢失，只能重新上传。
//
// 本脚本端到端验证三道防线：
//   ① isBuildArtifactCover 判定正确（含站内绝对 URL / 外部 CDN 不误伤）
//   ② 后端 manage.update：产物路径或不带 cover 字段 → 保持 D1 原值；合法值才写入
//   ③ 后端 posts.create：产物路径绝不入库
//   ④ 源码守护：前端「未改动就不提交 cover」的逻辑还在（防顺手改回去）
// 用法：node scripts/verify-cover-persist.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signJWT } from "../functions/api/_lib/auth.js";
import { isBuildArtifactCover } from "../functions/_lib/cover.js";
import { onRequestPost as managePost } from "../functions/api/posts/manage.js";
import { onRequestPost as createPost } from "../functions/api/posts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const ORIGIN = "https://blog-6p3.pages.dev";
const JWT_SECRET = "test-secret-for-verify";
const DATA_COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const ARTIFACT = "/generated/covers/f5bd0fbc27-e006fe57.jpg";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 内存 D1 mock ──────────────────────────────────────────────────────────────
function makeEnv(row) {
  const state = { cover: row.cover, author: row.author_username, updates: [], inserts: [] };
  const env = {
    JWT_SECRET,
    OWNER_USERNAME: "owner",
    // 故意不设 DEPLOY_HOOK_URL，避免真的对外发请求
    BLOG_DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...args) {
            return {
              first: async () => {
                if (/^SELECT author_username/i.test(s)) return { author_username: state.author };
                if (/^SELECT cover/i.test(s)) return { cover: state.cover };
                return null;
              },
              run: async () => {
                if (/^UPDATE posts/i.test(s)) {
                  state.updates.push(args);
                  state.cover = args[3] == null ? null : args[3]; // (title,tag,summary,cover,...)
                } else if (/^INSERT INTO posts/i.test(s)) {
                  state.inserts.push(args);
                }
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  return { env, state };
}

const token = await signJWT({ username: "tester" }, JWT_SECRET);
function req(body, url) {
  return {
    url: url || ORIGIN + "/api/posts/manage",
    headers: { get: (n) => (n.toLowerCase() === "cookie" ? `auth=${token}` : null) },
    json: async () => body,
  };
}
const ctxFor = (body, env, url) => ({ request: req(body, url), env, waitUntil: (p) => p && p.catch(() => {}) });

// ── [1] 判定函数 ──────────────────────────────────────────────────────────────
console.log("\n[1] isBuildArtifactCover 判定");
{
  const cases = [
    [ARTIFACT, undefined, true, "站内相对产物路径"],
    ["/generated/posts/x.json", undefined, true, "generated 下任意文件"],
    [ORIGIN + ARTIFACT, ORIGIN, true, "本站绝对 URL（与请求 origin 同源）"],
    ["https://blog.zhongfangxin682.workers.dev/generated/covers/a.jpg", undefined, true, "Cloudflare workers.dev 绝对 URL"],
    ["https://cdn.example.com/generated/x.jpg", ORIGIN, false, "外部 CDN 的 /generated/ 不误伤"],
    ["https://cdn.example.com/img/x.jpg", ORIGIN, false, "普通外链"],
    ["/uploads/products/a.jpg", ORIGIN, false, "站内普通相对路径"],
    ["data:image/png;base64,AAAA", ORIGIN, false, "data: 原图（必须允许）"],
    ["javascript:alert(1)", ORIGIN, false, "伪协议"],
    ["", ORIGIN, false, "空值"],
    [null, ORIGIN, false, "null"],
    [undefined, ORIGIN, false, "undefined"],
  ];
  for (const [input, origin, want, label] of cases) {
    const got = isBuildArtifactCover(input, origin);
    check(label + " → " + want, got === want, "实际 " + got);
  }
}

// ── [2] manage.update：产物路径/缺字段一律保留原值 ─────────────────────────────
console.log("\n[2] manage.update 不得用产物路径覆盖原始封面");
{
  const base = {
    action: "update", slug: "my-post", title: "标题", tag: "随笔", summary: "摘要",
    body: "# 标题\n\n正文内容，含一张图 ![图](https://cdn.example.com/body.jpg)",
  };

  // 2a 提交产物路径（事故复现）→ 原 data: 必须原封不动
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: DATA_COVER });
    const res = await managePost(ctxFor({ ...base, cover: ARTIFACT }, env));
    const data = await res.json();
    check("产物路径入参：D1 原 data: 封面未被覆盖", state.cover === DATA_COVER,
      "变成 " + String(state.cover).slice(0, 60));
    check("产物路径入参：响应 ok=true（不阻断正文保存）", data.ok === true, JSON.stringify(data));
    check("产物路径入参：响应带 coverIgnored 标记", data.coverIgnored === true, JSON.stringify(data));
  }

  // 2b 本站绝对 URL 形态的产物路径 → 同样保留
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: DATA_COVER });
    const res = await managePost(ctxFor({ ...base, cover: ORIGIN + ARTIFACT }, env));
    const data = await res.json();
    check("本站绝对产物 URL：保留原值", state.cover === DATA_COVER, String(state.cover).slice(0, 60));
    check("本站绝对产物 URL：coverIgnored=true", data.coverIgnored === true, JSON.stringify(data));
  }

  // 2c 完全不提交 cover 字段（新前端「未改动」路径）→ 保留
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: DATA_COVER });
    const body = { ...base };
    delete body.cover;
    const res = await managePost(ctxFor(body, env));
    const data = await res.json();
    check("未提交 cover 字段：保留原 data: 封面", state.cover === DATA_COVER, String(state.cover).slice(0, 60));
    check("未提交 cover 字段：不误报 coverIgnored", data.coverIgnored === false, JSON.stringify(data));
  }

  // 2d 合法新封面 → 正常写入
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: DATA_COVER });
    const res = await managePost(ctxFor({ ...base, cover: "https://cdn.example.com/new.jpg" }, env));
    const data = await res.json();
    check("合法 https 封面：写入成功", state.cover === "https://cdn.example.com/new.jpg", String(state.cover));
    check("合法 https 封面：coverIgnored=false", data.coverIgnored === false, JSON.stringify(data));
  }

  // 2e 显式清空（用户主动删掉）→ 回退正文首图（原有行为不变）
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: DATA_COVER });
    await managePost(ctxFor({ ...base, cover: "" }, env));
    check("显式空封面：回退正文首图", state.cover === "https://cdn.example.com/body.jpg", String(state.cover));
  }

  // 2f 原封面为空 + 产物路径 → 不写入产物路径，保持为空
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: "" });
    await managePost(ctxFor({ ...base, cover: ARTIFACT }, env));
    check("原封面为空 + 产物路径：仍为空（不写入死链）", !state.cover, String(state.cover));
  }
}

// ── [3] create：产物路径绝不入库 ─────────────────────────────────────────────
console.log("\n[3] posts.create 不得把产物路径写进 D1");
{
  // 3a 带产物路径 + 正文有图 → 用正文首图
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: "" });
    const res = await createPost(ctxFor({
      title: "新文章", tag: "随笔", summary: "", cover: ARTIFACT,
      body: "# 新\n\n![图](https://cdn.example.com/pick.jpg)",
    }, env, ORIGIN + "/api/posts"));
    const data = await res.json();
    check("create 成功", data.ok === true, JSON.stringify(data));
    check("产物路径被丢弃，改用正文首图",
      state.inserts.length === 1 && state.inserts[0][5] === "https://cdn.example.com/pick.jpg",
      JSON.stringify(state.inserts[0] && state.inserts[0][5]));
  }
  // 3b 带产物路径 + 正文无图 → null
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: "" });
    await createPost(ctxFor({ title: "新文章2", tag: "随笔", summary: "", cover: ORIGIN + ARTIFACT, body: "# 新\n\n纯文字" }, env, ORIGIN + "/api/posts"));
    check("产物路径被丢弃且无正文图 → cover 为 null",
      state.inserts.length === 1 && state.inserts[0][5] == null,
      JSON.stringify(state.inserts[0] && state.inserts[0][5]));
  }
  // 3c 合法封面 → 正常写入
  {
    const { env, state } = makeEnv({ author_username: "tester", cover: "" });
    await createPost(ctxFor({ title: "新文章3", tag: "随笔", summary: "", cover: "https://cdn.example.com/ok.jpg", body: "# 新\n\n纯文字" }, env, ORIGIN + "/api/posts"));
    check("create 合法封面正常写入",
      state.inserts.length === 1 && state.inserts[0][5] === "https://cdn.example.com/ok.jpg",
      JSON.stringify(state.inserts[0] && state.inserts[0][5]));
  }
}

// ── [4] 源码守护：前端「未改动就不提交 cover」 ────────────────────────────────
console.log("\n[4] 源码守护（防顺手改回去）");
{
  const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
  const manageSrc = fs.readFileSync(path.join(root, "functions", "api", "posts", "manage.js"), "utf8");
  const postsSrc = fs.readFileSync(path.join(root, "functions", "api", "posts.js"), "utf8");
  const coverLib = fs.readFileSync(path.join(root, "functions", "_lib", "cover.js"), "utf8");

  check("编辑器不再无条件预填 post.cover",
    !/composeCover\.value\s*=\s*post\.cover\s*\|\|\s*""/.test(appSrc),
    "发现 composeCover.value = post.cover || \"\"（会把产物路径灌进表单）");
  check("编辑器有 composeCoverDirty 状态", /composeCoverDirty/.test(appSrc), "未找到 composeCoverDirty");
  check("提交时按「未改动」省略 cover 字段",
    /if\s*\(!editingSlug\s*\|\|\s*composeCoverDirty\)\s*payload\.cover/.test(appSrc),
    "未找到省略 cover 的提交分支");
  check("前端有 isArtifactCover 判定", /function isArtifactCover/.test(appSrc), "未找到 isArtifactCover");
  check("manage.js 引入并使用 isBuildArtifactCover",
    /import\s*\{[^}]*isBuildArtifactCover[^}]*\}/.test(manageSrc) && /isBuildArtifactCover\(/.test(manageSrc),
    "manage.js 缺少产物路径防护");
  check("manage.js 会读取 D1 原封面并保留", /readCurrentCover/.test(manageSrc), "未找到 readCurrentCover");
  check("posts.js 引入并使用 isBuildArtifactCover",
    /import\s*\{[^}]*isBuildArtifactCover[^}]*\}/.test(postsSrc) && /isBuildArtifactCover\(/.test(postsSrc),
    "posts.js 缺少产物路径防护");
  check("cover.js 里判定前缀为 /generated/",
    /ARTIFACT_COVER_PREFIX\s*=\s*"\/generated\/"/.test(coverLib), "判定前缀变了");
}

console.log("\n" + "─".repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS —— 封面不会被构建产物路径覆盖，原图不再丢失");
