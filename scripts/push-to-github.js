// 用 GitHub Git Database API 把当前工作区文件直接提交到仓库
// 用法：node scripts/push-to-github.js <TOKEN> [branch]
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.argv[2];
const BRANCH = process.argv[3] || 'main';
const REPO = 'night136/blog';
const BASE_DIR = path.join(__dirname, '..');

if (!TOKEN) {
  console.error('用法: node scripts/push-to-github.js <TOKEN> [branch]');
  process.exit(1);
}

const FILES_TO_PUSH = [
  'README.md',
  'assets/app.js',
  'admin/config.yml',
  'CMS-OAUTH.md',
  'content/posts/index.json',
  'scripts/build-index.js',
];

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'blog-push-script',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          if (res.statusCode >= 300) {
            return reject(new Error(`${method} ${path} -> ${res.statusCode}: ${JSON.stringify(json)}`));
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`${method} ${path} -> ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function base64(str) {
  return Buffer.from(str).toString('base64');
}

(async () => {
  try {
    // 1. 获取当前分支引用
    const ref = await api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH}`);
    const parentSha = ref.object.sha;
    console.log('当前 commit:', parentSha.slice(0, 7));

    // 2. 获取父 commit 的 tree
    const parentCommit = await api('GET', `/repos/${REPO}/git/commits/${parentSha}`);
    const baseTreeSha = parentCommit.tree.sha;

    // 3. 为每个文件创建 blob
    const treeItems = [];
    for (const f of FILES_TO_PUSH) {
      const content = fs.readFileSync(path.join(BASE_DIR, f), 'utf8');
      const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
        content: base64(content),
        encoding: 'base64',
      });
      treeItems.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
      console.log('blob created:', f);
    }

    // 4. 创建 tree
    const tree = await api('POST', `/repos/${REPO}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeItems,
    });
    console.log('tree created:', tree.sha.slice(0, 7));

    // 5. 创建 commit
    const commit = await api('POST', `/repos/${REPO}/git/commits`, {
      message: 'feat: index.json 自动索引 + CMS editorial workflow + OAuth 文档',
      tree: tree.sha,
      parents: [parentSha],
    });
    console.log('commit created:', commit.sha.slice(0, 7));

    // 6. 更新分支引用
    await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha });
    console.log('✅ 已推送到 main');
  } catch (e) {
    console.error('❌ 推送失败:', e.message);
    process.exit(1);
  }
})();
