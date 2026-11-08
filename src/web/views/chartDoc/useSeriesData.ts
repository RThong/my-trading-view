// 注册表的取数层(图表编辑器与固定面板的计算格共用):按注册表把各序列统一成 { time, value }[],再按 Header 的周期聚合。
// 只读复用现有接口与数据 hook(/api/regime 的 useRegimeData、/api/yield-curve,以及 /api/price、25Δ、VRP、/api/series),保证同一序列和旧图表数字一致;
// 任意 Yahoo 代码走 /api/yahoo/history。
import { useMemo } from 'react';
import useSWR from 'swr';
import { aggregate, aggregateBars, isWeekend, type Bar, type LinePoint } from '../../chart/core';
import type { Interval } from '../../hooks/interval';
import { useServerRefresh } from '../../hooks/useServerRefresh';
import { useRegimeData, type RegimeData } from '../regime/regimeChart.hooks';
import { combineSeries, shiftBars, shiftPoints } from '../../chart/analysis';
import type { Calc } from './chartDoc';
import {
  rememberYahooName,
  seriesLabel,
  seriesDef,
  type CurveSource,
  type SeriesDef,
  type SeriesSource,
} from './registry';
import { SWR_OPTS } from '../../lib/http';
import { latestIso } from '../../../shared/calc/isoDate';

const RETRY_SWR_OPTS = { ...SWR_OPTS, revalidateIfStale: true };
/**
 * 只留周一~周五:
 * BTC 这类 7×24 序列与股票 / 利率同轴时,周末点会给时间轴凭空多出约 900 根空位。
 */
export function weekdayOnly(points: LinePoint[]): LinePoint[] {
  return points.filter((p) => !isWeekend(p.time));
}

/**
 * 一次取数请求:哪条序列、平移多少交易日;daily = 不按页头周期聚合、固定日线
 * (领先滞后扫描要逐交易日平移,周 / 月线聚合过的序列扫不出日级领先)。同一序列参数不同就是不同请求。
 */
/** weekends:保留 7×24 序列的周末点(整张图的线都是 7×24 时才要,见 layerPoints 的 allSevenDay);缺省去周末,好与工作日序列共用时间轴 */
export type SeriesRequest = { series: string; calc?: Calc; shift: number; daily?: true; bars?: true; weekends?: true };

/** 请求的键(也是 points 的键)。序列 id 里不会有 '|' / '@' / '#'(parseChartDoc 拒收,注册表也没有)。 */
export function requestKey({ series, calc, shift, daily, bars, weekends }: SeriesRequest): string {
  const c = calc ? `|${calc.op}${calc.fill ? 'f' : ''}|${calc.series}` : '';
  return `${series}${c}${shift ? `@${shift}` : ''}${daily ? '#d' : ''}${bars ? '#b' : ''}${weekends ? '#w' : ''}`;
}

function parseKey(key: string): SeriesRequest {
  const weekends = key.endsWith('#w');
  const tail = weekends ? key.slice(0, -2) : key;
  const bars = tail.endsWith('#b');
  const rest = bars ? tail.slice(0, -2) : tail;
  const daily = rest.endsWith('#d');
  const body = daily ? rest.slice(0, -2) : rest;
  const at = body.lastIndexOf('@');
  const head = at < 0 ? body : body.slice(0, at);
  const shift = at < 0 ? 0 : Number(body.slice(at + 1));
  const [series, op, b] = head.split('|');
  const calc: Calc | undefined = op
    ? { op: op[0] as Calc['op'], series: b, ...(op[1] === 'f' && { fill: true as const }) }
    : undefined;
  return {
    series,
    shift,
    ...(calc && { calc }),
    ...(daily && { daily: true as const }),
    ...(weekends && { weekends: true as const }),
    ...(bars && { bars: true as const }),
  };
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

type YahooHistory = {
  symbol: string;
  name: string;
  points: { date: string; close: number; open?: number | null; high?: number | null; low?: number | null }[];
};
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
function hasWeekends(times: string[]) {
  return times.filter(isWeekend).length > times.length * 0.1;
}

/** 这条序列要不要去周末:静态表里的 7×24 序列已标 weekends;Yahoo 任意代码事先不知道,按数据判。点和 K 线共用 */
function isSevenDay(def: SeriesDef, src: SeriesSource, times: string[]) {
  return !!def.weekends || (src.kind === 'yahoo' && hasWeekends(times));
}

/** 收益曲线接口的响应(只用到的字段)。同利率页 useYieldCurve 的 YieldCurveData。 */
type CurveData = {
  series: Record<string, { date: string; value: number }[]>;
  refreshing?: boolean;
  partial?: boolean;
  /** 本次现拉失败、服务端拿上一份顶上的期限(见 server 的 fillFromPrev) */
  fallback?: string[];
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
export function seriesPoints(
  def: SeriesDef,
  data: SourceData,
  interval: Interval,
  shift = 0,
  keepWeekends = false,
): LinePoint[] {
  return aggregate(shiftPoints(dailyPoints(def, data, keepWeekends), shift), interval);
}

/**
 * 计算图层:A、B 各自按日线取出,按 calc 的对齐口径相减 / 相除(见 combineSeries),再平移、聚合。
 * 先算后聚合:对齐必须在日线上做才不会错位。
 */
export function calcPoints(
  a: SeriesDef,
  calc: Calc,
  b: SeriesDef,
  data: SourceData,
  interval: Interval,
  shift = 0,
  keepWeekends = false,
): LinePoint[] {
  const values = combineSeries(
    dailyPoints(a, data, keepWeekends),
    dailyPoints(b, data, keepWeekends),
    calc.op,
    calc.fill,
  );
  return aggregate(shiftPoints(values, shift), interval);
}

/**
 * 一根日 K。收盘必须是数,否则这天不要(同点数据);开高低缺(null / 不是数)就用收盘补成一字线 ——
 * 同服务端 toOhlc 的口径:有收盘的日子就有一根,蜡烛不会比收盘点少几天、更不会整条空白(只给收盘的 Yahoo 代码画成一排一字线)。
 * null 不能直接 Number():Number(null) = 0,会造出一根 0 价 K 线把轴压扁
 */
function toBar(time: string, o: unknown, h: unknown, l: unknown, c: unknown): Bar[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const close = num(c);
  if (close === undefined) return [];

  return [{ time, open: num(o) ?? close, high: num(h) ?? close, low: num(l) ?? close, close }];
}

function fromRegimeOhlc(src: { key: string }, data: SourceData) {
  return data.regime.ohlc?.[src.key] ?? [];
}
function fromYahoo(symbol: string, data: SourceData) {
  return (data.yahoo?.[symbol]?.points ?? []).flatMap((p) => toBar(p.date, p.open, p.high, p.low, p.close));
}

/** 按数据源种类取整根日 K(只有注册表标了 ohlc 的序列才有)。 */
const BAR_EXTRACT: Partial<{
  [K in SeriesSource['kind']]: (src: Extract<SeriesSource, { kind: K }>, data: SourceData) => Bar[];
}> = {
  regime: fromRegimeOhlc,
  regimeOhlc: fromRegimeOhlc,
  endpoint: (src, data) =>
    (data.endpoints?.[src.url] ?? []).flatMap((r) => toBar(r.date, r.open, r.high, r.low, r.close)),
  yahoo: (src, data) => fromYahoo(src.symbol, data),
};

/**
 * 单条序列的 K 线(蜡烛图层用):取整根日 K → (7×24 的)去周末 → 平移 → 按周期聚合(开取首、收取尾、高低取极值)。
 * 注册表没标 ohlc 的返回 [](画法下拉里「蜡烛」本来就置灰)。
 */
export function seriesBars(
  def: SeriesDef,
  data: SourceData,
  interval: Interval,
  shift = 0,
  keepWeekends = false,
): Bar[] {
  const src = def.source;
  const extract = def.ohlc
    ? (BAR_EXTRACT[src.kind] as ((s: SeriesSource, d: SourceData) => Bar[]) | undefined)
    : undefined;
  // 收盘走本源、K 线另从 Yahoo 取的(标普 500 等,见注册表 barsFrom)
  const raw = def.barsFrom ? fromYahoo(def.barsFrom, data) : (extract?.(src, data) ?? []);
  const daily =
    !keepWeekends &&
    isSevenDay(
      def,
      src,
      raw.map((b) => b.time),
    )
      ? raw.filter((b) => !isWeekend(b.time))
      : raw;

  return aggregateBars(shiftBars(daily, shift), interval);
}

/** 单条序列的日线:从原始响应取出 → 统一形状 → 丢非有限值 → (7×24 的)去周末。 */
function dailyPoints(def: SeriesDef, data: SourceData, keepWeekends: boolean): LinePoint[] {
  const src = def.source;
  const raw = (EXTRACT[src.kind] as (s: SeriesSource, d: SourceData) => LinePoint[])(src, data);

  const finite = raw.filter((p) => Number.isFinite(p.value));

  return !keepWeekends &&
    isSevenDay(
      def,
      src,
      finite.map((p) => p.time),
    )
    ? weekdayOnly(finite)
    : finite;
}

/**
 * 各线时间段的交集:起点取最晚的起点,终点取最晚的终点(右端不按最短的截,最新的点总要看得到)。
 * 没有线有数据,或交集为空(起点晚于所有终点)→ null。
 */
export function commonRange(series: LinePoint[][]): { from: string; to: string } | null {
  const withData = series.filter((p) => p.length > 0);
  if (withData.length === 0) return null;

  const from = latestIso(withData.map((p) => p[0].time));
  const to = latestIso(withData.map((p) => p.at(-1)!.time));

  return from < to ? { from, to } : null;
}

export type SeriesData = {
  /** 请求键(requestKey)→ 点。只含本次请求到的。 */
  points: Record<string, LinePoint[]>;
  /** 请求键 → K 线。只含带 bars 标记的请求(蜡烛图层;点照旧在 points 里,图例 / 分位读收盘) */
  bars: Record<string, Bar[]>;
  isLoading: boolean;
  error?: Error;
  /** 用到了、但这次没有数据的序列名(计算图层是「A − B」,含两条没有重叠日期的情况) */
  missing: string[];
  /** 用到了「源这次没拉到、服务端拿上一份顶上」的腿的请求键(线照画,但不是最新;计算图层任一腿是这样就算) */
  stale: string[];
};

export function useSeriesData(requests: SeriesRequest[], interval: Interval): SeriesData {
  // 用 join 后的字符串当依赖:调用方每次渲染给新数组,内容不变就不重算(稳定化责任放在 hook 内)。
  const keysStr = [...new Set(requests.map(requestKey))].sort().join(',');
  const sources = useMemo(
    () =>
      keysStr
        .split(',')
        .map(parseKey)
        .flatMap((r) => {
          const def = seriesDef(r.series);
          // 蜡烛图层的 K 线另从 Yahoo 取的,把那个代码也算进要请求的源
          const bars: SeriesSource[] = r.bars && def?.barsFrom ? [{ kind: 'yahoo', symbol: def.barsFrom }] : [];
          return [def?.source, ...(r.calc ? [seriesDef(r.calc.series)?.source] : []), ...bars];
        })
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

  const points = useMemo(() => {
    // bars 标记只决定要不要另算 K 线,点按去掉它的键算一次:同一序列的折线和蜡烛共用一份点
    const byBase = new Map<string, LinePoint[] | undefined>();
    const pointsOf = (req: SeriesRequest) => {
      const base = requestKey({ ...req, bars: undefined });
      if (!byBase.has(base)) byBase.set(base, computePoints(req));
      return byBase.get(base);
    };
    function computePoints(req: SeriesRequest): LinePoint[] | undefined {
      const def = seriesDef(req.series);
      const data = { regime, yahoo, endpoints, curves };
      const iv = req.daily ? '1D' : interval;
      if (!def) return undefined;
      if (!req.calc) return seriesPoints(def, data, iv, req.shift, req.weekends);

      const b = seriesDef(req.calc.series);
      return b ? calcPoints(def, req.calc, b, data, iv, req.shift, req.weekends) : undefined;
    }

    return Object.fromEntries(
      keysStr
        .split(',')
        .filter(Boolean)
        .flatMap((k) => {
          const pts = pointsOf(parseKey(k));
          return pts ? [[k, pts]] : [];
        }),
    );
  }, [keysStr, regime, yahoo, endpoints, curves, interval]);
  const bars = useMemo(
    () =>
      Object.fromEntries(
        keysStr
          .split(',')
          .filter(Boolean)
          .flatMap((k) => {
            const req = parseKey(k);
            const def = seriesDef(req.series);
            // 只给蜡烛图层的请求(bars 标记)算 K 线:画成折线的 SPY 不必每次刷新都多跑一遍
            if (!req.bars || !def?.ohlc || req.calc) return [];
            return [
              [
                k,
                seriesBars(
                  def,
                  { regime, yahoo, endpoints, curves },
                  req.daily ? '1D' : interval,
                  req.shift,
                  req.weekends,
                ),
              ],
            ];
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
            .map((k) => parseKey(k))
            .map((r) => seriesLabel(r.series, r.calc)),
        ),
      ];
  const error = regimeError ?? curveStates.find((c) => c.error)?.error;

  const stale = useMemo(() => {
    function legStale(id: string): boolean {
      const src = seriesDef(id)?.source;
      if (src?.kind === 'regime' || src?.kind === 'regimeOhlc') return !!regime.fallback?.includes(src.key);
      if (src?.kind === 'curve') return !!curves[src.curve]?.fallback?.includes(src.tenor);
      return false;
    }
    return keysStr
      .split(',')
      .filter(Boolean)
      .filter((k) => {
        const r = parseKey(k);
        return [r.series, ...(r.calc ? [r.calc.series] : [])].some(legStale);
      });
  }, [keysStr, regime, curves]);

  return { points, bars, isLoading, error, missing, stale };
}
