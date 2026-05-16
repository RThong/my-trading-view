import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type LinePoint = { time: string; value: number };
export type SeriesData = { label: string; color: string; data: LinePoint[] };

type QuoteSeriesConfig = { source: 'quotes'; symbol: string; label: string; color: string };
type MacroSeriesConfig = { source: 'macro';  seriesId: string; label: string; color: string };
export type SeriesConfig = QuoteSeriesConfig | MacroSeriesConfig;

export function useChartData(configs: SeriesConfig[], days: number): {
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
          query: { days: String(days) },
        });
        const bars = await res.json() as Array<{ date: string; close: number }>;
        return {
          label: cfg.label,
          color: cfg.color,
          data: bars.map(b => ({ time: b.date, value: b.close })),
        };
      } else {
        const res = await (api.api.macro[':seriesId'].$get as (args: unknown) => Promise<Response>)({
          param: { seriesId: cfg.seriesId },
          query: { days: String(days) },
        });
        const points = await res.json() as Array<{ date: string; value: number }>;
        return {
          label: cfg.label,
          color: cfg.color,
          data: points.map(p => ({ time: p.date, value: p.value })),
        };
      }
    }))
      .then(result => { if (!cancelled) setSeries(result); })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [JSON.stringify(configs), days]);

  return { series, loading, error };
}
