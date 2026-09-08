// 端到端验证 manage.js 的 update 分支（重点是 readingTime 已正确引入，不再 ReferenceError）
// 模拟 Cloudflare Pages Functions 的 ctx / env / request，D1 用内存 mock。
import { signJWT } from "../functions/api/_lib/auth.js";
import { onRequestPost } from "../functions/api/posts/manage.js";

const username = "tester";
const jwtSecretVal = "test-secret-for-verify";

const calls = [];
const env = {
  JWT_SECRET: jwtSecretVal,
  OWNER_USERNAME: "owner",
  // DEPLOY_HOOK_URL 故意不设置，避免真的触发外部请求
  BLOG_DB: {
    prepare(sql) {
      calls.push(sql.replace(/\s+/g, " ").trim());
      return {
        bind(...args) {
          return {
            first: async () => {
              // SELECT author_username FROM posts WHERE slug = ?
              return { author_username: username };
            },
            run: async () => ({ success: true }),
          };
        },
      };
    },
  },
};

const token = await signJWT({ username }, jwtSecretVal);
const request = {
  headers: { get: (n) => (n.toLowerCase() === "cookie" ? `auth=${token}` : null) },
  json: async () => ({
    action: "update",
    slug: "my-post",
    title: "测试标题",
    tag: "随笔",
    summary: "摘要",
    cover: "",
    body: "# 标题\n\n这是一段正文内容，用来统计字数。Hello world here.",
  }),
};

const ctx = { request, env, waitUntil: (p) => p.catch(() => {}) };
const res = await onRequestPost(ctx);
const data = await res.json();

console.log("HTTP status:", res.status);
console.log("response   :", JSON.stringify(data));
console.log("SQL calls  :", calls);

if (data.ok === true) {
  console.log("\nRESULT: PASS  —— update 分支执行成功，readingTime 已可用");
} else {
  console.log("\nRESULT: FAIL  —— " + (data.error || JSON.stringify(data)));
  process.exit(1);
}
