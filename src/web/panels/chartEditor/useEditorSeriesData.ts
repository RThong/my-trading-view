// 编辑器的取数层:按注册表把各序列统一成 { time, value }[],再按 Header 的周期聚合。
// 只读复用现有接口与数据 hook(/api/regime 的 useRegimeData、/api/yield-curve,以及 /api/price、25Δ、VRP、/api/series),保证同一序列和旧图表数字一致;
// 任意 Yahoo 代码走 /api/yahoo/history。
import { useMemo } from 'react';
import useSWR from 'swr';
import { aggregate, isWeekend, type LinePoint } from '../../lib/chart';
import type { Interval } from '../../hooks/interval';
import { useServerRefresh } from '../../hooks/useServerRefresh';
import { useRegimeData, type RegimeData } from '../regime/regimeChart.hooks';
import { shiftPoints } from './analysis';
import { rememberYahooName, seriesDef, type CurveSource, type SeriesDef, type SeriesSource } from './registry';
import { SWR_OPTS } from '../../lib/http';

const RETRY_SWR_OPTS = { ...SWR_OPTS, revalidateIfStale: true };
/**
 * 只留周一~周五(同 tenorHistory.hooks 的 weekdayOnly):
 * BTC 这类 7×24 序列与股票 / 利率同轴时,周末点会给时间轴凭空多出约 900 根空位。
 */
export function weekdayOnly(points: LinePoint[]): LinePoint[] {
  return points.filter((p) => !isWeekend(p.time));
}

/**
 * 一次取数请求:哪条序列、平移多少交易日;daily = 不按页头周期聚合、固定日线
 * (领先滞后扫描要逐交易日平移,周 / 月线聚合过的序列扫不出日级领先)。同一序列参数不同就是不同请求。
 */
export type SeriesRequest = { series: string; shift: number; daily?: true };

/** 请求的键(也是 points 的键)。注册表 id 里没有 '@' / '#'。 */
export function requestKey({ series, shift, daily }: SeriesRequest): string {
  return `${series}${shift ? `@${shift}` : ''}${daily ? '#d' : ''}`;
}

function parseKey(key: string): SeriesRequest {
  const daily = key.endsWith('#d');
  const body = daily ? key.slice(0, -2) : key;
  const at = body.lastIndexOf('@');
  const req = at < 0 ? { series: body, shift: 0 } : { series: body.slice(0, at), shift: Number(body.slice(at + 1)) };
  return daily ? { ...req, daily: true } : req;
}

/** 「URL + 字段」型的源(price_eod 现货、25Δ、VRP、/api/series):URL → 行;取不到的为 null(单个失败不连累其它)。 */
type EndpointRow = { date: string } & Record<string, number | string | null>;
type EndpointData = Record<string, EndpointRow[] | null>;
const NO_ENDPOINT: EndpointData = {};

// 按 URL 缓存请求(同 fetchYahoo):加一条序列时 SWR 的键变了会整组重取,已取过的直接复用;失败的不缓存,下次再试
const endpointRequests = new Map<string, Promise<EndpointRow[] | null>>();
function fetchEndpoint(url: string): Promise<EndpointRow[] | null> {
  const hit = endpointRequests.get(url);
  if (hit) return hit;

  // 网络错、非 2xx、JSON 坏、形状不对都只让这一个 URL 归 null,不拖垮同批的其它序列
  const req = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((rows) => (Array.isArray(rows) ? (rows as EndpointRow[]) : null))
    .catch(() => null);
  req.then((rows) => {
    if (!rows) endpointRequests.delete(url);
  });
  endpointRequests.set(url, req);
  return req;
}

async function getEndpoints([, ...urls]: string[]): Promise<EndpointData> {
  const rows = await Promise.all(urls.map(async (url) => [url, await fetchEndpoint(url)] as const));
  return Object.fromEntries(rows);
}

type YahooHistory = { symbol: string; name: string; points: { date: string; close: number }[] };
/** 代码 → 日线;取不到的为 null(单个代码失败不连累其它代码) */
type YahooData = Record<string, YahooHistory | null>;
const NO_YAHOO: YahooData = {};

// 按代码缓存请求:勾选新代码时 SWR 的键变了会整组重取,已取过的直接复用这里的 promise,不重复请求
const yahooRequests = new Map<string, Promise<YahooHistory | null>>();
function fetchYahoo(symbol: string): Promise<YahooHistory | null> {
  const hit = yahooRequests.get(symbol);
  if (hit) return hit;

  const req = fetch(`/api/yahoo/history/${encodeURIComponent(symbol)}`)
    .then(async (r) => {
      if (!r.ok) return null;
      const h = (await r.json()) as YahooHistory;
      rememberYahooName(symbol, h.name);
      return h;
    })
    .catch(() => null);
  // 失败的不缓存,下次勾选再试
  req.then((h) => {
    if (!h) yahooRequests.delete(symbol);
  });
  yahooRequests.set(symbol, req);
  return req;
}

async function getYahoo([, ...symbols]: string[]): Promise<YahooData> {
  const rows = await Promise.all(symbols.map(async (s) => [s, await fetchYahoo(s)] as const));
  return Object.fromEntries(rows);
}

/** 日线里周末点超过一成 = 7×24 资产(加密);美股的周末快照入库前已归到周五,不会误判。同 AssetChart 的判据。 */
function hasWeekends(points: LinePoint[]) {
  return points.filter((p) => isWeekend(p.time)).length > points.length * 0.1;
}

/** 收益曲线接口的响应(只用到的字段)。同利率页 useYieldCurve 的 YieldCurveData。 */
type CurveData = {
  series: Record<string, { date: string; value: number }[]>;
  refreshing?: boolean;
  partial?: boolean;
};
const NO_CURVE: CurveData = { series: {} };

async function getCurve(url: string): Promise<CurveData> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<CurveData>;
}

/**
 * 某条收益曲线(没用到就不发请求)。要的是长历史版(history=full:名义 1990 起、实际 / BEI 2003 起),
 * 与利率页的默认版(2018 起)分开缓存 —— 旧页面的分位 / 时间轴不受影响。
 * 服务端给的是旧 / 不完整数据时照利率页的做法定时重取(useServerRefresh)。
 */
function useCurve(curve: CurveSource, used: boolean) {
  const key = `/api/yield-curve?source=${curve}&history=full`;
  const { data = NO_CURVE, error, isLoading, mutate } = useSWR(used ? key : null, getCurve, SWR_OPTS);
  useServerRefresh(key, data, mutate);

  return { data, error: error as Error | undefined, isLoading };
}

/** 各源的原始响应,seriesPoints 从这里按注册表取。 */
export type SourceData = {
  regime: RegimeData;
  curves: Partial<Record<CurveSource, CurveData>>;
  endpoints?: EndpointData;
  yahoo?: YahooData;
};

function fromDated(rows: { date: string; value: number }[] | undefined): LinePoint[] {
  return (rows ?? []).map((p) => ({ time: p.date, value: p.value }));
}
function fromCloses(rows: { date: string; close: number }[] | undefined): LinePoint[] {
  return (rows ?? []).map((b) => ({ time: b.date, value: b.close }));
}

/** 按数据源种类从原始响应里取出 { time, value }[](查表,每种源一个取法)。取不到 → []。 */
const EXTRACT: {
  [K in SeriesSource['kind']]: (src: Extract<SeriesSource, { kind: K }>, data: SourceData) => LinePoint[];
} = {
  regime: (src, data) => fromDated(data.regime.series[src.key]),
  regimeOhlc: (src, data) => (data.regime.ohlc?.[src.key] ?? []).map((b) => ({ time: b.time, value: b.close })),
  curve: (src, data) => fromDated(data.curves[src.curve]?.series[src.tenor]),
  endpoint: (src, data) =>
    (data.endpoints?.[src.url] ?? []).map((r) => ({ time: r.date, value: Number(r[src.field] ?? Number.NaN) })),
  yahoo: (src, data) => fromCloses(data.yahoo?.[src.symbol]?.points),
};

/**
 * 单条序列:从原始响应取出 → 统一形状 → (7×24 的)去周末 → 平移 → 按周期聚合。取不到 → []。
 * 先平移再聚合:反过来的话周线键(周一)平移后落在周中,时间轴上会多出空位。
 */
export function seriesPoints(def: SeriesDef, data: SourceData, interval: Interval, shift = 0): LinePoint[] {
  const src = def.source;
  const raw = (EXTRACT[src.kind] as (s: SeriesSource, d: SourceData) => LinePoint[])(src, data);

  const finite = raw.filter((p) => Number.isFinite(p.value));

  // 静态表里的 7×24 序列已标 weekends;Yahoo 任意代码事先不知道,按数据判
  const weekends = def.weekends || (src.kind === 'yahoo' && hasWeekends(finite));
  return aggregate(shiftPoints(weekends ? weekdayOnly(finite) : finite, shift), interval);
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
  /** 请求键(requestKey)→ 点。只含本次请求到的。 */
  points: Record<string, LinePoint[]>;
  isLoading: boolean;
  error?: Error;
  /** 用到了、但源这次没给数据的序列 id(注册表 id,不带平移) */
  missing: string[];
};

export function useEditorSeriesData(requests: SeriesRequest[], interval: Interval): EditorSeriesData {
  // 用 join 后的字符串当依赖:调用方每次渲染给新数组,内容不变就不重算(稳定化责任放在 hook 内)。
  const keysStr = [...new Set(requests.map(requestKey))].sort().join(',');
  const sources = useMemo(
    () =>
      keysStr
        .split(',')
        .map((k) => seriesDef(parseKey(k).series)?.source)
        .filter((s) => s !== undefined),
    [keysStr],
  );
  const usesRegime = sources.some((s) => s.kind === 'regime' || s.kind === 'regimeOhlc');
  const { data: regime, error: regimeError, isLoading: regimeLoading } = useRegimeData(usesRegime);
  const usesCurve = (c: CurveSource) => sources.some((s) => s.kind === 'curve' && s.curve === c);
  const yahooSymbols = [...new Set(sources.flatMap((s) => (s.kind === 'yahoo' ? [s.symbol] : [])))];
  const yahooKey = yahooSymbols.length ? ['editor:yahoo', ...yahooSymbols] : null;
  // revalidateIfStale:失败的代码 fetchYahoo 不缓存,但 SWR 会把 {SYM: null} 按键缓存住 ——
  // 取消再勾选回到同一个键时要重取一次,失败的才有机会重试(成功的走 fetchYahoo 的 promise 缓存,不重复请求)
  const { data: yahoo = NO_YAHOO, isLoading: yahooLoading } = useSWR(yahooKey, getYahoo, RETRY_SWR_OPTS);
  // 去重:同一序列可能同时有原线、平移后、扫描用日线几份请求,取的都是同一个 URL
  const urls = [...new Set(sources.flatMap((s) => (s.kind === 'endpoint' ? [s.url] : [])))];
  const endpointKey = urls.length ? ['editor:endpoint', ...urls] : null;
  const { data: endpoints = NO_ENDPOINT, isLoading: endpointLoading } = useSWR(
    endpointKey,
    getEndpoints,
    RETRY_SWR_OPTS,
  );
  // 曲线源是固定的几个,逐个调用(hook 不能放进循环)
  const curveState = {
    treasury: useCurve('treasury', usesCurve('treasury')),
    real: useCurve('real', usesCurve('real')),
    bei: useCurve('bei', usesCurve('bei')),
    jgb: useCurve('jgb', usesCurve('jgb')),
    sofr_ois: useCurve('sofr_ois', usesCurve('sofr_ois')),
    credit_rating: useCurve('credit_rating', usesCurve('credit_rating')),
    credit_term: useCurve('credit_term', usesCurve('credit_term')),
    ai_cds: useCurve('ai_cds', usesCurve('ai_cds')),
  } satisfies Record<CurveSource, unknown>;
  const curveStates = Object.values(curveState);
  // 各曲线的数据逐个当依赖(SWR 给的 data 引用稳定;curveState 本身每次渲染都是新对象,整份当依赖会每次重算)
  const { treasury, real, bei, jgb, sofr_ois, credit_rating, credit_term, ai_cds } = curveState;
  const curves = useMemo(
    () => ({
      treasury: treasury.data,
      real: real.data,
      bei: bei.data,
      jgb: jgb.data,
      sofr_ois: sofr_ois.data,
      credit_rating: credit_rating.data,
      credit_term: credit_term.data,
      ai_cds: ai_cds.data,
    }),
    [treasury.data, real.data, bei.data, jgb.data, sofr_ois.data, credit_rating.data, credit_term.data, ai_cds.data],
  );

  const points = useMemo(
    () =>
      Object.fromEntries(
        keysStr
          .split(',')
          .filter(Boolean)
          .flatMap((k) => {
            const req = parseKey(k);
            const def = seriesDef(req.series);
            const data = { regime, yahoo, endpoints, curves };
            return def ? [[k, seriesPoints(def, data, req.daily ? '1D' : interval, req.shift)]] : [];
          }),
      ),
    [keysStr, regime, yahoo, endpoints, curves, interval],
  );

  // 状态只算当前真用到的源:只挑了 SPY 时,regime 慢或挂了都与这张图无关(没用到的曲线 key 为 null,不算)
  const isLoading = regimeLoading || yahooLoading || endpointLoading || curveStates.some((c) => c.isLoading);
  const missing = isLoading
    ? []
    : [
        ...new Set(
          Object.keys(points)
            .filter((k) => points[k].length === 0)
            .map((k) => parseKey(k).series),
        ),
      ];
  const error = regimeError ?? curveStates.find((c) => c.error)?.error;

  return { points, isLoading, error, missing };
}
