// 生成 content/posts/index.json
// 在每次新增/修改文章后运行一次：node scripts/build-index.js
const fs = require('fs');
const path = require('path');

const POSTS_DIR = path.join(__dirname, '..', 'content', 'posts');
const OUT_FILE = path.join(POSTS_DIR, 'index.json');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const meta = {};
  m[1].split('\n').forEach((line) => {
    const i = line.indexOf(':');
    if (i > -1) {
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      v = v.replace(/^["']|["']$/g, '');
      meta[k] = v;
    }
  });
  return meta;
}

const files = fs.readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'index.json')
  .sort((a, b) => (a < b ? 1 : -1));

const posts = files.map((file) => {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const meta = parseFrontmatter(raw) || {};
  return {
    id: file.replace(/\.md$/, ''),
    file,
    title: meta.title || file.replace(/\.md$/, ''),
    date: meta.date || '1970-01-01',
    tag: meta.tag || '未分类',
    author: meta.author || '昉昕',
    summary: meta.summary || '',
  };
});

posts.sort((a, b) => (a.date < b.date ? 1 : -1));

fs.writeFileSync(OUT_FILE, JSON.stringify({ posts, generatedAt: new Date().toISOString() }, null, 2));
console.log(`✅ 生成 index.json，包含 ${posts.length} 篇文章`);
