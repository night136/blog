// 计算 Markdown 正文的字数与阅读时长（与前端 assets/app.js 保持一致）
export function readingTime(md) {
  const text = (md || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/[#*`\[\](){}|>\-]/g, "");
  const cjkChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const nonCjkWords = text
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((x) => x).length;
  const words = cjkChars + nonCjkWords;
  return { words, minutes: Math.max(1, Math.round(words / 300)) };
}
