import { useEffect, useState } from 'react';
import { api } from '../lib/client';

export type LinePoint = { time: string; value: number };
export type SeriesData = { label: string; color: string; data: LinePoint[] };

type AxisAndPane = { axis?: 'left' | 'right'; pane?: number };
type QuoteSeriesConfig = AxisAndPane & { source: 'quotes'; symbol: string; label: string; color: string };
type MacroSeriesConfig = AxisAndPane & { source: 'macro';  seriesId: string; label: string; color: string };
export type SeriesConfig = QuoteSeriesConfig | MacroSeriesConfig;

export type Interval = '1D' | '1W' | '1M' | '1Q' | '1Y';

const HISTORY_DAYS = 18250; // 50y — enough to cover all CBOE history (back to 1986)

function periodKey(dateStr: string, interval: Interval): string {
  if (interval === '1D') return dateStr;

  const d = new Date(dateStr + 'T00:00:00Z');
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  if (interval === '1Y') {
    return `${year}-01-01`;
  }
  if (interval === '1Q') {
    const qStartMonth = Math.floor(month / 3) * 3;
    return `${year}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
  }
  if (interval === '1M') {
    return `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }
  // 1W: Monday of ISO-ish week
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(year, month, day + diff));
  return monday.toISOString().slice(0, 10);
}

function aggregate(data: LinePoint[], interval: Interval): LinePoint[] {
  if (interval === '1D') return data;
  const byKey = new Map<string, LinePoint>();
  for (const p of data) {
    const key = periodKey(p.time, interval);
    byKey.set(key, { time: key, value: p.value });
  }
  return Array.from(byKey.values()).sort((a, b) => a.time.localeCompare(b.time));
}

export function useChartData(configs: SeriesConfig[], interval: Interval): {
  series: SeriesData[];
  loading: boolean;
  error: string | null;
} {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(configs.map(async (cfg) => {
      if (cfg.source === 'quotes') {
        const res = await (api.api.quotes[':symbol'].$get as (args: unknown) => Promise<Response>)({
          param: { symbol: cfg.symbol },
          query: { days: String(HISTORY_DAYS) },
        });
        const bars = await res.json() as Array<{ date: string; close: number }>;
        return {
          label: cfg.label,
          color: cfg.color,
          data: aggregate(bars.map(b => ({ time: b.date, value: b.close })), interval),
        };
      } else {
        const res = await (api.api.macro[':seriesId'].$get as (args: unknown) => Promise<Response>)({
          param: { seriesId: cfg.seriesId },
          query: { days: String(HISTORY_DAYS) },
        });
        const points = await res.json() as Array<{ date: string; value: number }>;
        return {
          label: cfg.label,
          color: cfg.color,
          data: aggregate(points.map(p => ({ time: p.date, value: p.value })), interval),
        };
      }
    }))
      .then(result => { if (!cancelled) setSeries(result); })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [JSON.stringify(configs), interval]);

  return { series, loading, error };
}
