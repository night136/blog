// 从 lunar.js（426KB 全功能库）导出「农历年表 + 节气表」，供内联的精简实现使用。
//
// 为什么要这么做：lunar.js 同时带八字、佛历、道历、神煞、九星、节气天文算法……
// 本站只用到 4 个 API（农历日期 / 干支生肖 / 24 节气 / 农历月历），却要让每个访客
// 下载 110KB（br），而且它是**外部资源** —— 跨境链路上刷得比下载快就永远下不完。
// 改为「预先把数据导出成表 + 运行时只做日数推算」后，体积降两个数量级，且不再依赖网络。
//
// 用法：
//   node scripts/gen-lunar-data.mjs                  # 打印体积对比
//   node scripts/gen-lunar-data.mjs --block <file>   # 生成可插入 app.js 的完整代码块
//   node scripts/gen-lunar-data.mjs --golden <file>  # 生成黄金基准（供 verify-lunar-core 使用）
//
// ⚠️ 本脚本依赖 assets/vendor/lunar.js，而该库在内联完成后会被删除（只作为参照物存在过）。
//    若日后需要重新生成，按 docs/lunar-inline.md 取回同名库（lunar-javascript 6.x）即可。

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import { computeLunarDigest } from "./lib/lunar-digest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const L = require(path.join(__dirname, "..", "assets", "vendor", "lunar.js"));

const Y0 = 1899;
const Y_END = 2100;
const JIEQI = ["小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明", "谷雨", "立夏", "小满", "芒种", "夏至",
  "小暑", "大暑", "立秋", "处暑", "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至"];
const MONTH_CN = "正二三四五六七八九十冬腊";

// ---------- 1. 农历年表 ----------
// 编码（沿用 1900–2100 农历表的通行位序）：
//   低 4 位 = 闰月月份（0 = 无闰月）；bit16 = 闰月是否大月；bit15..4 = 正月..腊月是否大月
function buildYearInfo() {
  const out = [];
  for (let y = Y0; y <= Y_END; y++) {
    const leap = L.LunarYear.fromYear(y).getLeapMonth();
    let v = leap & 0xf;
    for (let m = 1; m <= 12; m++) {
      if (L.LunarMonth.fromYm(y, m).getDayCount() === 30) v |= 0x10000 >> m;
    }
    if (leap) {
      const ld = L.LunarMonth.fromYm(y, -leap).getDayCount();
      if (ld !== 29 && ld !== 30) throw new Error(`${y} 闰${leap}月天数异常: ${ld}`);
      if (ld === 30) v |= 0x10000;
    }
    if (leap < 0 || leap > 12) throw new Error(`${y} 闰月月份异常: ${leap}`);
    out.push(v);
  }
  return out;
}

// ---------- 2. 节气表 ----------
// 第 n 个节气（小寒=0）固定落在 floor(n/2)+1 月，故只需存「日」。
function buildJieQi() {
  const days = [];
  for (let y = Y0; y <= Y_END + 1; y++) {
    const idx = new Array(24).fill(0);
    for (let i = 0; i < 366; i++) {
      const d = new Date(y, 0, 1 + i);
      if (d.getFullYear() !== y) break;
      const jq = L.Lunar.fromDate(d).getCurrentJieQi();
      if (!jq) continue;
      const n = JIEQI.indexOf(jq.getName());
      if (n < 0) throw new Error(`未知节气名: ${jq.getName()}`);
      const want = (n >> 1) + 1;
      if (d.getMonth() + 1 !== want) throw new Error(`${y} ${jq.getName()} 落在 ${d.getMonth() + 1} 月，预期 ${want} 月`);
      idx[n] = d.getDate();
    }
    for (let n = 0; n < 24; n++) if (!idx[n]) throw new Error(`${y} 缺节气 ${JIEQI[n]}`);
    days.push(...idx);
  }
  return days;
}

const YEAR_INFO = buildYearInfo();
const JIEQI_DAYS = buildJieQi();
// 每字符一个节气日：'0'-'9' = 日；10..31 → String.fromCharCode(87 + 日)
const jieqiStr = JIEQI_DAYS.map((d) => (d < 10 ? String(d) : String.fromCharCode(87 + d))).join("");

// ---------- 3. 黄金基准（全量摘要 + 抽样）----------
const day = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function buildDigest() {
  const t0 = Date.now();
  // 「旧库」适配器：把 lunar.js 的 API 归一化成摘要格式（格式定义在 lib/lunar-digest.mjs）
  const libAdapter = {
    fromDate(date) {
      const lu = L.Lunar.fromDate(date);
      const jq = lu.getCurrentJieQi();
      const nx = lu.getNextJieQi(true);
      return {
        y: lu.getYear(), m: lu.getMonth(), d: lu.getDay(),
        monthCn: lu.getMonthInChinese(), dayCn: lu.getDayInChinese(),
        ganZhi: lu.getYearInGanZhi(), shengXiao: lu.getYearShengXiao(),
        jieQi: jq ? jq.getName() : "",
        nextName: nx.getName(), nextYmd: nx.getSolar().toYmd(),
      };
    },
    monthsOfYear(y) {
      const lp = L.LunarYear.fromYear(y).getLeapMonth();
      const ms = [];
      // 必须按**时间顺序**：闰月紧跟同名平月之后（挂到年末会让「月份首尾相接」失真）
      for (let m = 1; m <= 12; m++) { ms.push(m); if (m === lp) ms.push(-lp); }
      return ms;
    },
    monthDayCount: (y, m) => L.LunarMonth.fromYm(y, m).getDayCount(),
    lunarToSolar: (y, m, d) => L.Lunar.fromYmd(y, m, d).getSolar().toYmd(),
  };
  const r = computeLunarDigest(libAdapter);
  console.error(`[golden] 覆盖 ${r.total} 条记录（逐日 ${r.dayLines.length} + 逐月 ${r.monthLines.length}），耗时 ${Date.now() - t0}ms`);
  return r;
}

const args = process.argv.slice(2);
const mode = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const writeOut = (file, text) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
};

// ------------------------------------------------ --block
if (mode("--block")) {
  const out = mode("--block");
  const yearLines = [];
  const ySrc = YEAR_INFO.map((n) => "0x" + n.toString(16));
  for (let i = 0; i < ySrc.length; i += 9) yearLines.push("    " + ySrc.slice(i, i + 9).join(",") + (i + 9 < ySrc.length ? "," : ""));
  const jqLines = [];
  for (let i = 0; i < jieqiStr.length; i += 100) jqLines.push('    "' + jieqiStr.slice(i, i + 100) + '"' + (i + 100 < jieqiStr.length ? " +" : ";"));

  const block = `  // ===== LUNAR-INLINE-START =====
  // 内联农历（替代原先 426KB / br 110KB 的 assets/vendor/lunar.js）。
  //
  // 为什么：本站只用到「农历日期 / 干支生肖 / 24 节气 / 农历月历」四样，却要为每个访客
  // 下载一个外部脚本。而它有一个致命的失败模式 —— 文档卸载会中止未完成的请求，且
  // max-age 缓存只有**下载完成**后才写入，于是「刷得比下载快就永远下不完」：连续刷新
  // 时农历一直都是空的。内联后数据随 app.js 一起到达，这一整类问题不复存在
  // （连带删掉了加载状态机 / 退避重试 / 看门狗 / 预加载）。
  //
  // 数据由 scripts/gen-lunar-data.mjs 从原库导出：202 年农历年表 + 4872 个节气日，
  // 原始约 6.3KB、gzip 后不足 1KB。运行时只做「日数推算」，没有任何天文计算。
  // 正确性由 scripts/verify-lunar-core.mjs 对着黄金基准逐日全量比对（见 docs/lunar-inline.md）。
  //
  // LUNAR_YEAR_INFO 每年一项（覆盖 ${Y0}..${Y_END}）：
  //   低 4 位 = 闰月月份（0 = 无闰月）；bit16 = 闰月是大月；bit15..4 = 正月..腊月是否大月
  var LUNAR_Y0 = ${Y0};
  var LUNAR_YEAR_INFO = [
${yearLines.join("\n")}
  ];
  // 24 节气日：自 ${Y0} 年起每年 24 个，'0'-'9' 表示 1..9 日，'a'-'n' 表示 10..23 日
  var LUNAR_JIEQI_DAYS =
${jqLines.join("\n")}
  var LUNAR_JIEQI_NAMES = ["小寒","大寒","立春","雨水","惊蛰","春分","清明","谷雨","立夏","小满","芒种","夏至","小暑","大暑","立秋","处暑","白露","秋分","寒露","霜降","立冬","小雪","大雪","冬至"];
  var LUNAR_MONTH_CN = "${MONTH_CN}";
  var LUNAR_GAN = "甲乙丙丁戊己庚辛壬癸";
  var LUNAR_ZHI = "子丑寅卯辰巳午未申酉戌亥";
  var LUNAR_SX = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
  var LUNAR_ANCHOR = Date.UTC(1900, 0, 31) / 86400000;   // 农历 1900 年正月初一
  var LUNAR_MIN_DAY = Date.UTC(${Y0}, 11, 1) / 86400000;   // 支持范围下限
  var LUNAR_MAX_DAY = Date.UTC(${Y_END}, 11, 31) / 86400000;

  function lYearDays(y) {
    var info = LUNAR_YEAR_INFO[y - LUNAR_Y0], sum = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) if (info & i) sum++;
    return sum + lLeapDays(y);
  }
  function lLeapMonth(y) { return LUNAR_YEAR_INFO[y - LUNAR_Y0] & 0xf; }
  function lLeapDays(y) { return lLeapMonth(y) ? ((LUNAR_YEAR_INFO[y - LUNAR_Y0] & 0x10000) ? 30 : 29) : 0; }
  function lMonthDays(y, m) { return m < 0 ? lLeapDays(y) : ((LUNAR_YEAR_INFO[y - LUNAR_Y0] & (0x10000 >> m)) ? 30 : 29); }
  // 自当年正月初一算起，到「第 m 月」初一经过的天数（m < 0 表示闰月）
  function lDaysBeforeMonth(y, m) {
    var lp = lLeapMonth(y), leap = m < 0, t = leap ? -m : m, sum = 0;
    for (var i = 1; i <= (leap ? t : t - 1); i++) {
      sum += lMonthDays(y, i);
      if (i === lp && !(leap && i === t)) sum += lLeapDays(y);
    }
    return sum;
  }
  // 公历日 → 天数序号。用 UTC 计算，避开夏令时/时区把结果推成 0.5 天
  function lSolarNum(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000; }
  function lYearOffset(y) {
    var n = 0, i;
    if (y >= 1900) { for (i = 1900; i < y; i++) n += lYearDays(i); }
    else { for (i = y; i < 1900; i++) n -= lYearDays(i); }
    return n;
  }
  function lToSolarNum(y, m, d) { return lYearOffset(y) + lDaysBeforeMonth(y, m) + (d - 1); }
  // 天数序号 → 农历 y/m/d（m < 0 表示闰月）
  function lFromSolarNum(n) {
    var off = n, y = 1900;
    if (off >= 0) { while (off >= lYearDays(y)) { off -= lYearDays(y); y++; } }
    else { while (off < 0) { y--; off += lYearDays(y); } }
    var lp = lLeapMonth(y), m = 1;
    for (var i = 1; i <= 12; i++) {
      var len = lMonthDays(y, i);
      if (off < len) { m = i; break; }
      off -= len;
      if (i === lp) {
        var ll = lLeapDays(y);
        if (off < ll) { m = -i; break; }
        off -= ll;
      }
    }
    return { y: y, m: m, d: off + 1 };
  }
  function lJieQiDay(y, n) {
    var c = LUNAR_JIEQI_DAYS.charCodeAt((y - LUNAR_Y0) * 24 + n);
    return c < 58 ? c - 48 : c - 87;
  }
  function lJieQiOf(y, m, d) {
    for (var k = 0; k < 2; k++) {
      var n = (m - 1) * 2 + k;
      if (lJieQiDay(y, n) === d) return LUNAR_JIEQI_NAMES[n];
    }
    return null;
  }
  // 下一个节气：严格晚于今天（与旧库 getNextJieQi(true) 一致 —— 当天是节气时返回再下一个）
  function lNextJieQi(y, m, d) {
    for (var n = (m - 1) * 2; n < 24; n++) {
      var nm = (n >> 1) + 1, dd = lJieQiDay(y, n);
      if (nm > m || dd > d) return { name: LUNAR_JIEQI_NAMES[n], y: y, m: nm, d: dd };
    }
    return { name: LUNAR_JIEQI_NAMES[0], y: y + 1, m: 1, d: lJieQiDay(y + 1, 0) };
  }
  function lGanZhi(y) { return LUNAR_GAN.charAt((y - 4) % 10) + LUNAR_ZHI.charAt((y - 4) % 12); }
  function lShengXiao(y) { return LUNAR_SX.charAt((y - 4) % 12); }
  function lMonthCn(m) { return (m < 0 ? "闰" : "") + LUNAR_MONTH_CN.charAt((m < 0 ? -m : m) - 1); }
  function lDayCn(d) {
    var A = "一二三四五六七八九十";
    if (d === 10) return "初十";
    if (d === 20) return "二十";
    if (d === 30) return "三十";
    return (d < 10 ? "初" : d < 20 ? "十" : "廿") + A.charAt((d < 10 ? d : d % 10) - 1);
  }
  // 一天的农历信息（hero 行与侧栏挂件共用）。超出支持范围返回 null，调用方降级显示。
  function lunarOf(date) {
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    var num = lSolarNum(y, m, d);
    if (num < LUNAR_MIN_DAY || num > LUNAR_MAX_DAY) return null;
    var lu = lFromSolarNum(num - LUNAR_ANCHOR);
    return {
      y: lu.y, m: lu.m, d: lu.d,
      month: lMonthCn(lu.m), day: lDayCn(lu.d),
      ganZhi: lGanZhi(lu.y), shengXiao: lShengXiao(lu.y),
      jieQi: lJieQiOf(y, m, d),
      next: lNextJieQi(y, m, d),
    };
  }
  function lunarMonthDays(y, m) { return lMonthDays(y, m); }
  function lunarToSolar(y, m, d) {
    var dt = new Date((lToSolarNum(y, m, d) + LUNAR_ANCHOR) * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  function solarWeekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  // ===== LUNAR-INLINE-END =====

  let heroLineKey = "";       // hero 行的渲染签名，避免每秒重建 DOM
  let lunarDetailDayKey = ""; // 详细农历（节气/整月月历）已渲染的日期，避免每秒重算
  const narrowMQ = window.matchMedia("(max-width: 980px)");
  const isNarrow = () => narrowMQ.matches;

  function shichenOf(d) {
    const idx = Math.floor(((d.getHours() + 1) % 24) / 2);
    return { idx, name: DI_ZHI[idx] };
  }`;

  writeOut(out, block);
  console.log("已写出代码块: %s (%d 字节)", out, Buffer.byteLength(block));
}

// ------------------------------------------------ --golden
else if (mode("--golden")) {
  const out = mode("--golden");
  const { digest, dayLines, monthLines } = buildDigest();
  // 每年的农历正月初一（最能定位「年边界」错位）
  const yearStarts = [];
  for (let y = 1900; y <= Y_END; y++) {
    const s = L.Lunar.fromYmd(y, 1, 1).getSolar();
    yearStarts.push(s.toYmd());
  }
  // 抽样（每 500 天一条），便于失败时定位
  const samples = dayLines.filter((_, i) => i % 500 === 0);
  const fixture = {
    note: "由 scripts/gen-lunar-data.mjs 从 lunar.js 生成。digest 覆盖 1899-12-01..2100-12-31 每一天的农历/节气，以及每个农历月的月长与首末日。",
    generatedAt: "2026-09-15",
    range: [day(Y0, 12, 1), day(Y_END, 12, 31)],
    digest: digest,
    yearStarts: yearStarts,
    monthCount: monthLines.length,
    samples: samples,
  };
  writeOut(out, JSON.stringify(fixture, null, 1));
  console.log("已写出黄金基准: %s (%d 字节, digest=%s)", out, Buffer.byteLength(JSON.stringify(fixture)), digest.slice(0, 16));
}

// ------------------------------------------------ 默认：体积对比
else {
  const yBytes = Buffer.byteLength(JSON.stringify(YEAR_INFO));
  const jBytes = Buffer.byteLength(JSON.stringify(jieqiStr));
  console.log("农历年表: %d 项, %d 字节", YEAR_INFO.length, yBytes);
  console.log("节气表:   %d 项, %d 字节", JIEQI_DAYS.length, jBytes);
  console.log("合计原始: %d 字节", yBytes + jBytes);
  const gz = zlib.gzipSync(JSON.stringify(YEAR_INFO) + jieqiStr).length;
  console.log("gzip 后:  %d 字节   （原 lunar.js 435942 字节 / br 约 110000 字节）", gz);
  console.log("压缩比:   %s", (110000 / gz).toFixed(1) + "×");
}
