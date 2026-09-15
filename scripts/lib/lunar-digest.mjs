// 农历「全量摘要」的计算方式 —— 生成基准（gen-lunar-data.mjs，用旧库）
// 与校验实现（verify-lunar-core.mjs，用内联实现）共用这一份格式化逻辑。
//
// 为什么要共用：摘要只有在「两侧按完全相同的规则拼串」时才有意义。若各写一份，
// 规则一旦漂移就会**假失败**（好过假通过，但同样浪费时间）。共用后，
// digest 不等就一定是农历数据本身不一致。
//
// adapter 需要提供：
//   fromDate(date) → { y, m, d, monthCn, dayCn, ganZhi, shengXiao, jieQi, nextName, nextYmd }
//       m < 0 表示闰月；jieQi 为当日节气名（没有则 null/""）；next* 为下一个节气
//   monthDayCount(y, m) → 该农历月天数（m < 0 为闰月）
//   lunarToSolar(y, m, d) → "YYYY-MM-DD"

import crypto from "crypto";

export const LUNAR_RANGE = { from: [1899, 12, 1], to: [2100, 12, 31] };

const p2 = (n) => String(n).padStart(2, "0");
export const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;

/** 逐日扫描 + 逐月记录，返回 { digest, dayLines, monthLines } */
export function computeLunarDigest(adapter) {
  const dayLines = [];
  const monthLines = [];
  const [fy, fm, fd] = LUNAR_RANGE.from;
  const [ty, tm, td] = LUNAR_RANGE.to;

  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += 86400000) {
    const dt = new Date(t);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const lu = adapter.fromDate(new Date(y, m - 1, d));
    if (!lu) throw new Error(`adapter 对 ${iso(y, m, d)} 返回空`);
    dayLines.push([
      iso(y, m, d), lu.y, lu.m, lu.d, lu.monthCn, lu.dayCn, lu.ganZhi, lu.shengXiao,
      lu.jieQi || "", lu.nextName + "@" + lu.nextYmd,
    ].join("|"));
  }

  for (let y = fy; y <= ty; y++) {
    for (const m of adapter.monthsOfYear(y)) {
      const cnt = adapter.monthDayCount(y, m);
      monthLines.push(`M|${y}|${m}|${cnt}|${adapter.lunarToSolar(y, m, 1)}|${adapter.lunarToSolar(y, m, cnt)}`);
    }
  }

  const all = dayLines.concat(monthLines);
  const digest = crypto.createHash("sha256").update(all.join("\n")).digest("hex");
  return { digest, dayLines, monthLines, total: all.length };
}
