// 测量尺(临时,不存进文档)的纯计算:从起点到终点涨跌多少、隔几根、几天。交互见编辑器 useDrawings。

type Point = { time: string; value: number };

const DAY_MS = 86_400_000;

export type MeasureStats = {
  /** 较晚那点减较早那点 */
  delta: number;
  /** 涨跌幅(%),以较早那点的绝对值为基准(穿零的序列符号跟着涨跌走);较早那点为 0 时没有 */
  pct: number | null;
  /** 隔了几根(按图上的逻辑下标,周 / 月线就是周 / 月数),不为负 */
  bars: number;
  /** 日历天数,不为负 */
  days: number;
};

/**
 * 按时间先后算,不按点击先后(负责人 2026-11-09 定):先点高点再往回点低点,量的仍是「这段从低点涨了多少」 ——
 * 复盘问的是一段走势的涨跌,涨跌幅的基准也该是较早的价位。bars 传入两点逻辑下标之差,正负都行
 */
export function measureStats(a: Point, b: Point, bars: number): MeasureStats {
  const [from, to] = b.time < a.time ? [b, a] : [a, b];
  const delta = to.value - from.value;

  return {
    delta,
    pct: from.value === 0 ? null : (delta / Math.abs(from.value)) * 100,
    // 先取绝对值再取整:Math.round 遇 .5 一律往大取(-2.5 → -2,2.5 → 3),先取整的话往左量会少一根
    bars: Math.round(Math.abs(bars)),
    days: Math.round((Date.parse(to.time) - Date.parse(from.time)) / DAY_MS),
  };
}

// 涨跌值的小数位:价格类(上千)两位就够;收益率、比值这类小数要多看几位
function fmtDelta(v: number): string {
  const abs = Math.abs(v);
  const text = abs >= 1 || abs === 0 ? abs.toFixed(2) : abs.toPrecision(3);
  return `${v < 0 ? '-' : '+'}${text}`;
}

/** 框下显示的两行:「+152.30 (+2.07%)」「32 根 · 45 天」 */
export function measureLabel(s: MeasureStats): [string, string] {
  const pct = s.pct === null ? '' : ` (${s.pct < 0 ? '' : '+'}${s.pct.toFixed(2)}%)`;

  return [`${fmtDelta(s.delta)}${pct}`, `${s.bars} 根 · ${s.days} 天`];
}
