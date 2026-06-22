// 期权/VRP 面板共用的图表辅助:暗色主题选项 + 按 interval 的周期聚合。
import type { Interval } from '../hooks/interval';

export type LinePoint = { time: string; value: number };
export type Bar = { time: string; open: number; high: number; low: number; close: number };

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

function periodKey(dateStr: string, interval: Interval): string {
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
  return Array.from(byKey.values()).sort((a, b) => a.time.localeCompare(b.time));
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
  return Array.from(byKey.values()).sort((a, b) => a.time.localeCompare(b.time));
}
