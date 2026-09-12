// 期权/VRP 面板共用的图表辅助:暗色主题选项 + 按 interval 的周期聚合。
import { sortBy } from 'remeda';
import type { Interval } from '../hooks/interval';

export type LinePoint = { time: string; value: number };
export type Bar = { time: string; open: number; high: number; low: number; close: number };

/** 竖线处相对前一根/点的变化。prev 无(第一根)→ null;prev=0 → 有 delta 无 pct(除零)。
 *  pct 用 |prev| 做分母,保证符号跟随 delta(本盘有会穿零的序列:skew / VRP / V1−V3)。 */
export function changeStats(cur: number, prev: number | undefined): { delta: number; pct: number | null } | null {
  if (prev === undefined) return null;
  const delta = cur - prev;
  return { delta, pct: prev === 0 ? null : (delta / Math.abs(prev)) * 100 };
}

/** 把 lightweight-charts 的 Time(BusinessDay 对象 / 字符串 / 时间戳)统一格式化成 YYYY-MM-DD。 */
function fmtDate(time: unknown): string {
  if (typeof time === 'string') return time; // 已是 'YYYY-MM-DD'
  if (time && typeof time === 'object' && 'year' in time) {
    const t = time as { year: number; month: number; day: number };
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  }
  return new Date((time as number) * 1000).toISOString().slice(0, 10);
}

export const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626' },
  timeScale: { borderColor: '#262626', timeVisible: false },
  // 鼠标悬停时浮动的时间标签(crosshair)统一成 YYYY-MM-DD,覆盖默认中文 locale。
  localization: { timeFormatter: fmtDate },
  autoSize: true,
};

/**
 * 蜡烛价格轴是否该取对数。**按数据判,不给调用方开配置** —— 判据是客观的:
 * 跨两个数量级以上,线性轴会把低位那半段压成一条贴底的平线(BTC:2012 的 $4 到今天的 $12 万,
 * 29500 倍)。实测本站其余标的最宽的也只有 9 倍(USO / VIX),离阈值差三个数量级,不会误判。
 */
export const needsLogScale = (bars: Bar[]): boolean => {
  const lows = bars.map((b) => b.low).filter((v) => v > 0);
  return lows.length > 0 && Math.max(...bars.map((b) => b.high)) / Math.min(...lows) > 100;
};

/** 周期键:同一周期内所有日期映射到同一个规范日期(周一 / 月初 / 季初 / 年初)。
 *  **导出是刻意的**:成交量必须和 OHLC 用同一个键分组,各写一份必然漂。 */
export function periodKey(dateStr: string, interval: Interval): string {
  if (interval === '1D') return dateStr;

  const d = new Date(dateStr + 'T00:00:00Z');
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  if (interval === '1Y') return `${year}-01-01`;
  if (interval === '1Q') {
    const qStartMonth = Math.floor(month / 3) * 3;
    return `${year}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
  }
  if (interval === '1M') return `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(year, month, day + diff));
  return monday.toISOString().slice(0, 10);
}

/** 同一周期内多个点取最后一个(Map 重复 key 保留后写入的),再按时间升序。 */
export function aggregate(points: LinePoint[], interval: Interval): LinePoint[] {
  if (interval === '1D') return points;
  const byKey = new Map(
    points.map((p) => {
      const key = periodKey(p.time, interval);
      return [key, { time: key, value: p.value }] as const;
    }),
  );
  return sortBy([...byKey.values()], (p) => p.time);
}

/** OHLC 按周期聚合:open=首根、close=尾根、high/low=区间极值。输入须按时间升序。 */
export function aggregateBars(bars: Bar[], interval: Interval): Bar[] {
  if (interval === '1D') return bars;
  const byKey = new Map<string, Bar>();
  for (const b of bars) {
    const key = periodKey(b.time, interval);
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close; // 升序输入 → 最后一根即收盘
    }
  }
  return sortBy([...byKey.values()], (b) => b.time);
}

/**
 * 把自动缩放算出的价格轴范围**夹进一个上限框**,只改轴、不改数据。
 *
 * 为什么要有它:有的序列日常波动在 ±2 内,却带着单周 −27 这样的真实极值
 * (Uri 寒潮冻停德州炼厂的开工率季节 z、2020 停摆的同比基数)。一根这样的点把其余 8 年
 * 压成一条直线,那格就废了。**服务端不截断数据** —— 那个值是真的,截了会骗人;
 * 在轴这一层夹,线仍然画出去、hover 仍读到真值,只是不让它决定整幅的高度。
 *
 * 语义是**求交不是覆盖**:数据本来就在框内时,照常自动缩放(不会强行撑到框的边界)。
 * 可视窗口整段落在框外时(缩放到那一周),夹出来的区间会倒挂 —— 此时**退回原范围**,
 * 否则那格什么都看不见。所以「放大到极值那周去看真值」这条路始终是通的。
 */
export function clampPriceRange(
  range: { minValue: number; maxValue: number },
  [lo, hi]: [number, number],
): { minValue: number; maxValue: number } {
  const minValue = Math.max(range.minValue, lo);
  const maxValue = Math.min(range.maxValue, hi);

  return minValue < maxValue ? { minValue, maxValue } : range;
}

/**
 * 造 lightweight-charts 的 `autoscaleInfoProvider` 回调:把自动算出的范围夹进 `box`。
 *
 * **抽成纯函数只为可测** —— 原本这段内联在 `paneChart.hooks` 的建图流程里,而那层要跑起来
 * 得有真的 chart 实例。变异检验实测:把 null 守卫删掉、或把整个 clamp 分支短路成 `if (false)`,
 * 全套测试都照样绿。夹轴的语义(求交 / 倒挂退回 / null 守卫)不该靠「没人动它」来保证。
 *
 * `priceRange` 为 null = 该 series 在当前可视窗口内没有数据 —— 原样退回,
 * 别去夹一个不存在的范围(会在图表自己的渲染循环里抛,排查极难定位)。
 */
export function clampAutoscaleProvider<T extends { priceRange: { minValue: number; maxValue: number } | null }>(
  box: [number, number],
): (original: () => T | null) => T | null {
  return (original) => {
    const info = original();
    if (!info?.priceRange) return info;

    return { ...info, priceRange: clampPriceRange(info.priceRange, box) };
  };
}
