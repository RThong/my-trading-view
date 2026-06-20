// 期权/VRP 面板共用的图表辅助:暗色主题选项 + 按 interval 的周期聚合。
import type { Interval } from '../hooks/interval';

export type LinePoint = { time: string; value: number };

export const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626' },
  timeScale: { borderColor: '#262626', timeVisible: false },
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
