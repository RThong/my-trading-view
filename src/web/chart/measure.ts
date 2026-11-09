// 测量尺(临时,不存进文档)的纯计算:从起点到终点涨跌多少、隔几根、几天。交互见编辑器 useDrawings。

type Point = { time: string; value: number };

const DAY_MS = 86_400_000;

export type MeasureStats = {
  delta: number;
  /** 涨跌幅(%),按起点绝对值算(穿零的序列符号跟着涨跌走);起点为 0 时没有 */
  pct: number | null;
  /** 隔了几根(按图上的逻辑下标,周 / 月线就是周 / 月数);终点在起点左边为负 */
  bars: number;
  /** 日历天数;终点在起点左边为负 */
  days: number;
};

export function measureStats(a: Point, b: Point, bars: number): MeasureStats {
  const delta = b.value - a.value;

  return {
    delta,
    pct: a.value === 0 ? null : (delta / Math.abs(a.value)) * 100,
    bars: Math.round(bars),
    days: Math.round((Date.parse(b.time) - Date.parse(a.time)) / DAY_MS),
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
