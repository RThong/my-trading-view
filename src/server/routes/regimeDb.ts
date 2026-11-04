import type { Database } from 'bun:sqlite';
import { mergeMove } from '../fetchers/moveIndex';
import { rollingMean, type Point } from '../analytics/regime';
import { OIS_INPUT_TENORS, hikesByTenor } from '../../shared/calc/policyPath';
import type { SeriesKey } from '../../shared/regimeSeries';
import { nearMinusFar } from '../analytics/termStructure';
import { rollingSharpe } from '../analytics/sharpe';
import { getMarketSeries, getPriceBars, getSecLag } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';
import {
  BUYER_FCF_SERIES,
  BUYER_FCFQ_SERIES,
  seriesId as secSeriesId,
  trailingContiguous,
} from '../analytics/secFundamentals';
import { twseSeriesId } from '../fetchers/twseRevenue';
import {
  ACTIVE_TICKERS,
  SEC_BUYER_FCF_KEY,
  SEC_BUYER_FCFQ_KEY,
  fundKey,
  kindsOf,
  trimsGaps,
  type FundKind,
  type FundTrim,
  type SecLag,
} from '../../shared/aiChain';
import { type OhlcBar, JOB_WRITTEN_SERIES, OIS_HIKE_HORIZONS } from './regimeKeys';

// /api/regime 里读库的那部分:daily job 写进 market_series / price_eod 的序列、SEC 基本面、Eris OIS 派生的加息次数。
// 现拉外部源在路由文件的 fetchFresh 里;这里只碰本地 SQLite。

/** 库里的日 bar → 蜡烛点。OHLC 三项可空(部分源只给收盘),缺则退化成十字线(open=high=low=close)。 */
export function toOhlc(
  bars: Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number }>,
): OhlcBar[] {
  return bars.map((b) => ({
    time: b.date,
    open: b.open ?? b.close,
    high: b.high ?? b.close,
    low: b.low ?? b.close,
    close: b.close,
  }));
}

/** kind → 库里 series_id。查表而非分支:漏一档是编译错误(Record 要求键齐)。 */
const SERIES_ID: Record<FundKind, (ticker: string) => string> = {
  // gm/capex/fcf/fcfq 无论来自 companyfacts 还是季报 6-K,原始行都落同一张表、派生同一套
  // `SEC_*` 序列(见 jobs/sec6kReports),所以这里不必按源分层。
  gm: (t) => secSeriesId(t, 'GM'),
  capex: (t) => secSeriesId(t, 'CAPEX'),
  fcf: (t) => secSeriesId(t, 'FCF'),
  fcfq: (t) => secSeriesId(t, 'FCFQ'),
  rev: (t) => secSeriesId(t, 'REV'),
  revGrowth: (t) => secSeriesId(t, 'REVG'),
  capexCloud: (t) => secSeriesId(t, 'CAPEXCLOUD'),
  revM: (t) => twseSeriesId(t, 'revM'),
  revYoy: (t) => twseSeriesId(t, 'revYoy'),
};

/**
 * 读**全部来自本地库**的东西:market_series 的直读几条、price_eod 的蜡烛、以及由它们派生的量。
 * 主路径与缓存命中路径共用这一个函数 —— 上一版只覆盖了 market_series 的成对映射,
 * 结果 qqq / ohlc.btc / btcSharpe1y / vxTermSpread 四组照旧不重读,注释却写着"凡是 job 写的都重读"。
 * 抽成一处就不会再出现"框架比实现宽"这种事:加一条只改这里,两条路径同时生效。
 */
export function readDbBacked(
  db: Database,
  /** MOVE 现拉的那条腿。它不来自库,但 MOVE 的最终值是「它 + 库里补丁」合并出来的,所以合并动作得放在这。 */
  moveLive: Point[],
  /** FRED SOFR 定盘值:OIS 加息次数的基准(现拉),曲线那半在库里,所以同样得在这里合。 */
  sofrLive: Point[],
): {
  series: Record<string, Point[]>;
  unavailable: string[];
  ohlc: Record<string, OhlcBar[]>;
} {
  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  const ohlc: Record<string, OhlcBar[]> = {};
  const put = (name: SeriesKey, value: Point[] | undefined) => {
    if (value?.length) series[name] = value;
    else unavailable.push(name);
  };

  JOB_WRITTEN_SERIES.forEach(([out, sym]) => {
    put(out, getMarketSeries(db, sym));
  });

  // QQQ 现货:波动率与情绪两个视角的价格参照 —— 那些指标只有对着价格才读得出「背离还是同步」。
  // 同 DXY 的处理:close 进 series 管存在性,OHLC 进 ohlc 画蜡烛。
  // 截到 HISTORY_START_DATE:price_eod 的 ETF 拉到了上市日(给 K 线均线收敛用),这两个视角的其它序列
  // 多从 2018 起,不截会把整张图的时间轴拉回 1999。
  const qqqBars = getPriceBars(db, 'QQQ').filter((b) => b.date >= HISTORY_START_DATE);
  put(
    'qqq',
    qqqBars.map((b) => ({ date: b.date, value: b.close })),
  );
  if (qqqBars.length) ohlc.qqq = toOhlc(qqqBars);

  // BTC:现货蜡烛 + 1Y 滚动夏普。窗口 365 而非 252 —— crypto 每天都有数据点,
  // 「一年」就是 365 个点;年化同走 √365(与 VRP 的 BTC 腿同口径,见 analytics/vrp)。
  // 蜡烛带上当天盘中那根(看盘要);夏普只用已收盘的,盘中那根的收益只有几小时,混进去是偏差。
  const btcBars = getPriceBars(db, 'BTC');
  const btcClose = getPriceBars(db, 'BTC', { closedOnly: true }).map((b) => ({ date: b.date, value: b.close }));
  // 这里**不走 put**(与 qqq 的写法刻意不同):BTC 点数是它们的两倍多,
  // 把 close 再塞一份进 series 是 ~196KB 的纯冗余 —— 蜡烛只读 ohlc,那份 series 唯一作用是判存在性。
  // 存在性直接由 ohlc 判,语义不变、payload 省掉。
  if (btcBars.length) ohlc.btc = toOhlc(btcBars);
  else unavailable.push('btc');
  put('btcSharpe1y', rollingSharpe(btcClose, 365, 365));
  // 供应密度:库里存原始日值,对外发 7 日均线 —— 原始值单日能跳 10pp,Murphy 原图那条就是 7 日均线。
  const densityRaw = getMarketSeries(db, 'BTC_SUPPLY_DENSITY');
  put('btcSupplyDensity', rollingMean(densityRaw, 7));
  put('btcSupplyDensityRaw', densityRaw);

  // 期限结构价差走 nearMinusFar(近端 − 远端,正 = backwardation)。具名 near/far 是刻意的:
  // 方向写反不会报错、只会让人读反图,而位置参数的调换单测抓不住(见 analytics/termStructure)。
  // 它是**内连接**:两腿更新不同步时宁可少一根,也不拿旧的一腿配新的另一腿还标成新日期。
  put('vxTermSpread', nearMinusFar({ near: getMarketSeries(db, 'VX1'), far: getMarketSeries(db, 'VX3') }));

  // MOVE:实时拉的优先,库里的补丁只填 Yahoo 断供的那些天。
  put('move', mergeMove(moveLive, getMarketSeries(db, 'MOVE')));

  // OIS 隐含「到 N 为止累计计入几次加息」:逐日用当天整条曲线反推。Eris 由 daily job 写库,所以归这一批重读。
  // 基准 = 当日 SOFR 定盘值;FRED 次日早上才发,当天没有就沿用上一个(≤ 当日最近)。
  const oisPar = [...oisParByDate(db)].map(([date, par]) => ({
    date,
    par,
    base: sofrLive.findLast((p) => p.date <= date)?.value,
  }));
  OIS_HIKE_HORIZONS.forEach(([out, tenor]) => {
    put(
      out,
      oisPar.flatMap(({ date, par, base }) => {
        const v = base === undefined ? null : hikesByTenor(par, date, tenor, base);
        return v === null ? [] : [{ date, value: v }];
      }),
    );
  });

  return { series, unavailable, ohlc };
}

/** 库里 Eris 各档按日拼成整条曲线(期限 → 百分点)。插入顺序跟 1D 的日期升序走。 */
function oisParByDate(db: Database): Map<string, Record<string, number>> {
  const points = OIS_INPUT_TENORS.flatMap((tenor) =>
    getMarketSeries(db, `ERIS_OIS_${tenor}`).map((p) => ({ tenor, ...p })),
  );

  // groupBy 的 Map 顺序 = 各日期首次出现的顺序(即 1D 那档的日期升序)
  const byDate = Map.groupBy(points, (p) => p.date);
  return new Map([...byDate].map(([date, ps]) => [date, Object.fromEntries(ps.map((p) => [p.tenor, p.value]))]));
}

/**
 * AI 链基本面派生量(季频/月频,由 jobs/aiChainFundamentals 每天跑着维护)。库里没有就归 unavailable,
 * 该 pane 留空 —— 这几条不像行情那样天天更新,job 没跑过是常态,不该整页失败。
 *
 * 序列按**启用名单 × 该家各个源的格子种类并集**派生(见 shared/aiChain 的 kindsOf),
 * 键由 fundKey 生成、与面板同源:加公司或加源都不用改这里。
 */
export function readSecSeries(db: Database): {
  series: Record<string, Point[]>;
  unavailable: string[];
  lag: SecLag[];
  trims: FundTrim[];
} {
  const defs = [
    ...ACTIVE_TICKERS.flatMap((ticker) =>
      kindsOf(ticker).map((kind) => ({
        out: fundKey(ticker, kind),
        id: SERIES_ID[kind](ticker),
        // 裁不裁由「折线还是柱状」决定,和源无关(见 shared/aiChain 的 KIND_RENDER)。
        trim: trimsGaps(kind),
      })),
    ),
    { out: SEC_BUYER_FCF_KEY, id: BUYER_FCF_SERIES, trim: trimsGaps('fcf') },
    // 单季合计是柱状 → 不裁。裁了会在真缺一季时把缺口之前的历史柱全砍掉。
    { out: SEC_BUYER_FCFQ_KEY, id: BUYER_FCFQ_SERIES, trim: trimsGaps('fcfq') },
  ];

  const read = defs.map(({ out, id, trim }) => {
    const raw = getMarketSeries(db, id);
    return { out, raw, rows: trim ? trailingContiguous(raw) : raw };
  });

  // 裁掉了多少必须回报:裁本身是对的,**静默才是问题** —— 用户只看到一条短线,
  // 分不清是「这家上市晚」还是「中间缺了几季、TTM 整段作废」(见 FundTrim)。
  // trailingContiguous 保留的是尾段,所以被裁掉的是前 dropped 个点。
  const trims: FundTrim[] = read
    .filter(({ raw, rows }) => raw.length > rows.length)
    .map(({ out, raw, rows }) => {
      const dropped = raw.length - rows.length;
      return { key: out, dropped, gapFrom: raw[dropped - 1]!.date, gapTo: rows[0]!.date };
    });

  const series: Record<string, Point[]> = Object.fromEntries(
    read.filter(({ rows }) => rows.length).map(({ out, rows }) => [out, rows]),
  );
  const unavailable = read.filter(({ rows }) => !rows.length).map(({ out }) => out);

  // 只保留启用名单里的:名单外的公司(曾启用过、水位还留在库里)不该在面板上冒出来。
  const lag = getSecLag(db).filter((l) => ACTIVE_TICKERS.includes(l.ticker));

  return { series, unavailable, lag, trims };
}
