// 编辑器的取数层:按注册表把各序列统一成 { time, value }[],再按 Header 的周期聚合。
// 只读复用现有接口与数据 hook(/api/regime 的 useRegimeData、/api/price),保证同一序列和旧图表数字一致。
import { useMemo } from 'react';
import useSWR from 'swr';
import { aggregate, type LinePoint } from '../../lib/chart';
import type { Interval } from '../../hooks/interval';
import { useRegimeData, type RegimeData } from '../regime/regimeChart.hooks';
import { seriesDef, type SeriesDef } from './registry';

type PriceBar = { date: string; close: number };
type PriceData = Record<string, PriceBar[]>;

const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };
const NO_PRICE: PriceData = {};

async function getPrices([, ...symbols]: string[]): Promise<PriceData> {
  const rows = await Promise.all(
    symbols.map(async (s) => {
      const r = await fetch(`/api/price/${encodeURIComponent(s)}`);
      if (!r.ok) throw new Error(`${s}: ${r.status}`);
      return [s, (await r.json()) as PriceBar[]] as const;
    }),
  );

  return Object.fromEntries(rows);
}

/**
 * 只留周一~周五。同 tenorHistory.hooks 的 weekdayOnly(那边未导出,按约定复制一份不改原件):
 * BTC 这类 7×24 序列与股票 / 利率同轴时,周末点会给时间轴凭空多出约 900 根空位。
 */
export const weekdayOnly = (points: LinePoint[]): LinePoint[] =>
  points.filter((p) => {
    const dow = new Date(`${p.time}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });

/** 单条序列:从原始响应取出 → 统一形状 → (7×24 的)去周末 → 按周期聚合。取不到 → []。 */
export function seriesPoints(def: SeriesDef, regime: RegimeData, prices: PriceData, interval: Interval): LinePoint[] {
  const src = def.source;
  const raw: LinePoint[] =
    src.kind === 'regime'
      ? (regime.series[src.key] ?? []).map((p) => ({ time: p.date, value: p.value }))
      : src.kind === 'regimeOhlc'
        ? (regime.ohlc?.[src.key] ?? []).map((b) => ({ time: b.time, value: b.close }))
        : (prices[src.symbol] ?? []).map((b) => ({ time: b.date, value: b.close }));

  const finite = raw.filter((p) => Number.isFinite(p.value));

  return aggregate(def.weekends ? weekdayOnly(finite) : finite, interval);
}

/**
 * 各线时间段的交集:起点取最晚的起点,终点取最晚的终点(右端不按最短的截,最新的点总要看得到)。
 * 没有线有数据,或交集为空(起点晚于所有终点)→ null。
 */
export function commonRange(series: LinePoint[][]): { from: string; to: string } | null {
  const withData = series.filter((p) => p.length > 0);
  if (withData.length === 0) return null;

  const from = withData.map((p) => p[0].time).reduce((a, b) => (a > b ? a : b));
  const to = withData.map((p) => p.at(-1)!.time).reduce((a, b) => (a > b ? a : b));

  return from < to ? { from, to } : null;
}

export type EditorSeriesData = {
  /** 序列 id → 点。只含当前文档用到的序列。 */
  points: Record<string, LinePoint[]>;
  isLoading: boolean;
  error?: Error;
  /** 用到了、但源这次没给数据的序列 id */
  missing: string[];
};

export function useEditorSeriesData(seriesIds: string[], interval: Interval): EditorSeriesData {
  const { data: regime, error: regimeError, isLoading: regimeLoading } = useRegimeData();

  // 用 join 后的字符串当依赖:调用方每次渲染给新数组,内容不变就不重算(稳定化责任放在 hook 内)。
  const idsKey = [...new Set(seriesIds)].sort().join(',');
  const sources = useMemo(
    () =>
      idsKey
        .split(',')
        .map((id) => seriesDef(id)?.source)
        .filter((s) => s !== undefined),
    [idsKey],
  );
  const symbols = sources.flatMap((s) => (s.kind === 'price' ? [s.symbol] : []));
  const usesRegime = sources.some((s) => s.kind !== 'price');
  const priceKey = symbols.length ? ['editor:price', ...symbols] : null;
  const { data: prices = NO_PRICE, error: priceError, isLoading: priceLoading } = useSWR(priceKey, getPrices, SWR_OPTS);

  const points = useMemo(() => {
    const defs = idsKey
      .split(',')
      .map((id) => seriesDef(id))
      .filter((d) => d !== undefined);
    return Object.fromEntries(defs.map((d) => [d.id, seriesPoints(d, regime, prices, interval)]));
  }, [idsKey, regime, prices, interval]);

  // 状态只算当前真用到的源:只挑了 SPY 时,regime 慢或挂了都与这张图无关
  const isLoading = (usesRegime && regimeLoading) || priceLoading;
  const missing = isLoading ? [] : Object.keys(points).filter((id) => points[id].length === 0);
  const error = (usesRegime ? regimeError : undefined) ?? (priceError as Error | undefined);

  return { points, isLoading, error, missing };
}
