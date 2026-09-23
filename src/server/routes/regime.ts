import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { createFredFetcher } from '../fetchers/fred';
import { createEiaFetcher } from '../fetchers/eia';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchFearGreed } from '../fetchers/cnnFearGreed';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchJgbCurve } from '../fetchers/mofJgb';
import { fetchJgbVix } from '../fetchers/jpxJgbVix';
import { fetchCftcJpyNet, fetchCftcVixNetOi } from '../fetchers/cftcCot';
import { fetchBojGap } from '../fetchers/bojOutputGap';
import { fetchNakajimaJgb } from '../fetchers/nakajimaJgb';
import { fetchMoveSeries, mergeMove } from '../fetchers/moveIndex';
import { fetchShillerCape } from '../fetchers/capeShiller';
import { fetchHlwRstar } from '../fetchers/nyfedRstar';
import { fetchAcmTermPremium } from '../fetchers/nyfedAcm';
import { fetchTreasuryCurve } from '../fetchers/usTreasuryPar';
import {
  subtractAligned,
  subtractAt,
  divideAligned,
  yoyPct,
  scale,
  sumAtAnchorDates,
  seasonalZFrom,
  oilCracks,
  distillateYield,
  retailMargin,
  type Point,
} from '../analytics/regime';
import type { RegimeSeries, FundSeries, SeriesKey } from '../../shared/regimeSeries';
import { nearMinusFar } from '../analytics/termStructure';
import { rollingSharpe } from '../analytics/sharpe';
import { openDb } from '../storage/db';
import { getMarketSeries, getPriceBars, getSecLag } from '../storage/repository';
import { HISTORY_START_DATE, SEASONAL_BASELINE_YEARS } from '../config';
import {
  BUYER_FCF_SERIES,
  BUYER_FCFQ_SERIES,
  seriesId as secSeriesId,
  trailingContiguous,
} from '../analytics/secFundamentals';
import { twseSeriesId } from '../fetchers/twseRevenue';
import {
  ACTIVE_TICKERS,
  FUND_KEY_PREFIX,
  SEC_BUYER_FCF_KEY,
  SEC_BUYER_FCFQ_KEY,
  fundKey,
  kindsOf,
  trimsGaps,
  type FundKind,
  type FundTrim,
  type SecLag,
} from '../../shared/aiChain';

// 后端不 import web 的 Bar(跨边界);内联 OHLC 形状,JSON 与前端 chart 的 Bar 一致。
type OhlcBar = { time: string; open: number; high: number; low: number; close: number };

/** 库里的日 bar → 蜡烛点。OHLC 三项可空(部分源只给收盘),缺则退化成十字线(open=high=low=close)。 */
const toOhlc = (
  bars: Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number }>,
): OhlcBar[] =>
  bars.map((b) => ({
    time: b.date,
    open: b.open ?? b.close,
    high: b.high ?? b.close,
    low: b.low ?? b.close,
    close: b.close,
  }));
type RegimeBody = {
  series: Record<string, Point[]>;
  unavailable: string[];
  ohlc?: Record<string, OhlcBar[]>;
  secLag?: SecLag[];
  secTrim?: FundTrim[];
};

// 内存 TTL 缓存:现拉全部外部源约 1.3s,重复打开走缓存瞬时返回。
// 只缓存全成功的响应(降级响应不缓存,下次刷新重试),避免瞬时反爬失败被粘住。
// EOD 日频数据盘中不变,TTL 取 6h 安全。进程级单例,dev/prod 长驻进程共享。
const TTL_MS = 6 * 60 * 60 * 1000;
/**
 * `moveLive` 单独存:MOVE 是「现拉的 Yahoo 腿 + 库里的补丁」合并出来的,
 * 而库那半边由 daily job(别的进程)写 —— 只缓存合并结果的话,job 补上的那天最长要等满 TTL 才出现。
 * 存住 live 腿,缓存命中时就能拿它重新和库里的 merge 一次,和 readDbBacked 的动机同一个。
 */
let cache: { at: number; body: RegimeBody; moveLive: Point[] } | null = null;

/**
 * AI 链基本面派生量(季频/月频,由 jobs/aiChainFundamentals 每天跑着维护)。库里没有就归 unavailable,
 * 该 pane 留空 —— 这几条不像行情那样天天更新,job 没跑过是常态,不该整页失败。
 *
 * 序列按**启用名单 × 该家各个源的格子种类并集**派生(见 shared/aiChain 的 kindsOf),
 * 键由 fundKey 生成、与面板同源:加公司或加源都不用改这里。
 */
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
 * 由**独立 job**写库、因此缓存命中时必须重读的序列(out 键 → market_series 的 symbol)。
 * 这些不像 FRED/CBOE 那样是请求时现拉的:进程内缓存看不到 cryptoDaily 等别的进程刚写进去的行,
 * 不重读的话,job 刚跑完最长还要等 TTL(6h)才在面板上出现。读库很便宜,不值得为它整体失效缓存。
 * GPU 这几条尤其要重读 —— 缓存条件专门放宽了「gpu 前缀缺失也缓存」(库没跑过 job 时四条必然缺、
 * B300 长期允许缺),两个改动合起来会把「GPU 不可用」这个状态缓存住并卡满 6h。
 */
export const JOB_WRITTEN_SERIES = [
  // VIX/VXN 同样是 daily job 写库、同样该重读 —— 它们历史非空,所以症状比 GPU 轻
  // (不是"整格不可用",只是最新一点最长滞后 6h),但性质一模一样,别再漏第二次。
  ['vix', 'VIX'],
  ['vxn', 'VXN'],
  ['gpuH100', 'CGI_H100'],
  ['gpuH200', 'CGI_H200'],
  ['gpuB200', 'CGI_B200'],
  ['gpuB300', 'CGI_B300'],
] as const;

/** 只有 gpu 这几条允许"缺着也缓存"(库没跑过 job 时必然缺、B300 长期允许缺)。 */
export const GPU_KEY_PREFIX = 'gpu';
/**
 * 这次响应能不能进缓存。**只缓存全成功**(降级响应不缓存,下次重试),三类例外:
 *  · `fund:` —— SEC 季频,靠独立 job 逐季攒,从没跑过 job 的库里必然缺。
 *  · `gpu`  —— 新接的 experimental 源,允许缺。
 *  · EIA 八条,**且仅当没配 key 时** —— 那是配置状态,不是失败。
 *
 * ⚠️ 第三条的「仅当」是要害:配了 key 还缺 = 网络挂了或源结构变了,属 transient,
 * 就该挡住缓存让下次重试。一律豁免的话会把降级响应缓存 6 小时。
 * ⚠️ 反过来不豁免也不行:README 把 EIA key 写成可选项,缺 key 时这八条恒缺 →
 * `every` 恒 false → 缓存永久关不上,每次请求重拉 FRED/CBOE/Yahoo/财政部…全套上游。
 */
export function shouldCache(unavailable: readonly string[], { hasEiaKey }: { hasEiaKey: boolean }): boolean {
  const exempt = new Set<string>(hasEiaKey ? [] : EIA_SERIES);

  return unavailable.every((n) => n.startsWith(FUND_KEY_PREFIX) || n.startsWith(GPU_KEY_PREFIX) || exempt.has(n));
}

/**
 * ⚠️ **这张名单是手抄的,必须和主 handler 里实际 `put()` 的那八条一致** ——
 * 将来加第九条 EIA 线却忘了同步,缺 key 时那条不在豁免里 → 缓存又会永久关不上(见 `shouldCache`)。
 * 同文件的 `DB_BACKED_KEYS` 有同构的回归测试,这里同样在 `routes/regime.test.ts` 里钉住。
 */
export const EIA_SERIES: readonly SeriesKey[] = [
  'refUtil',
  'refUtilZ5y',
  'distStocksZ5y',
  'gasStocksZ5y',
  'distExportsZ5y',
  'distYield',
  'crudeRunsYoy',
  'distProdYoy',
  // 零售两条与两条加价同样只在配了 key 时才有 —— 加价虽然有一条 Yahoo 腿(ULSD/RBOB),
  // 但缺 key 时零售腿为空、整条出不来,所以照样要豁免。裸 `ulsd` 不在此列(它与 EIA 无关)。
  'dieselRetail',
  'gasRetail',
  'dieselRetailMargin',
  'gasRetailMargin',
];

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

  for (const [out, sym] of JOB_WRITTEN_SERIES) put(out, getMarketSeries(db, sym));

  // QQQ 现货:波动率与情绪两个视角的价格参照 —— 那些指标只有对着价格才读得出「背离还是同步」。
  // 同 DXY 的处理:close 进 series 管存在性,OHLC 进 ohlc 画蜡烛。
  const qqqBars = getPriceBars(db, 'QQQ');
  put(
    'qqq',
    qqqBars.map((b) => ({ date: b.date, value: b.close })),
  );
  if (qqqBars.length) ohlc.qqq = toOhlc(qqqBars);

  // BTC:现货蜡烛 + 1Y 滚动夏普。窗口 365 而非 252 —— crypto 每天都有数据点,
  // 「一年」就是 365 个点;年化同走 √365(与 VRP 的 BTC 腿同口径,见 analytics/vrp)。
  const btcBars = getPriceBars(db, 'BTC');
  const btcClose = btcBars.map((b) => ({ date: b.date, value: b.close }));
  // 这里**不走 put**(与 qqq 的写法刻意不同):BTC 点数是它们的两倍多,
  // 把 close 再塞一份进 series 是 ~196KB 的纯冗余 —— 蜡烛只读 ohlc,那份 series 唯一作用是判存在性。
  // 存在性直接由 ohlc 判,语义不变、payload 省掉。
  if (btcBars.length) ohlc.btc = toOhlc(btcBars);
  else unavailable.push('btc');
  put('btcSharpe1y', rollingSharpe(btcClose, 365, 365));

  // 期限结构价差走 nearMinusFar(近端 − 远端,正 = backwardation)。具名 near/far 是刻意的:
  // 方向写反不会报错、只会让人读反图,而位置参数的调换单测抓不住(见 analytics/termStructure)。
  // 它是**内连接**:两腿更新不同步时宁可少一根,也不拿旧的一腿配新的另一腿还标成新日期。
  put('vxTermSpread', nearMinusFar({ near: getMarketSeries(db, 'VX1'), far: getMarketSeries(db, 'VX3') }));

  // MOVE:实时拉的优先,库里的补丁只填 Yahoo 断供的那些天。
  put('move', mergeMove(moveLive, getMarketSeries(db, 'MOVE')));

  return { series, unavailable, ohlc };
}

/** 这一批的 key 全集:缓存命中时要先把旧条目按 key 剔掉,再塞新读到的。 */
export const DB_BACKED_KEYS: ReadonlySet<string> = new Set<string>([
  ...JOB_WRITTEN_SERIES.map(([out]) => out),
  'qqq',
  'btc',
  'btcSharpe1y',
  'vxTermSpread',
  'move',
]);

function readSecSeries(db: Database): {
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

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  const trims: FundTrim[] = [];

  for (const { out, id, trim } of defs) {
    const raw = getMarketSeries(db, id);
    const rows = trim ? trailingContiguous(raw) : raw;

    // 裁掉了多少必须回报:裁本身是对的,**静默才是问题** —— 用户只看到一条短线,
    // 分不清是「这家上市晚」还是「中间缺了几季、TTM 整段作废」(见 FundTrim)。
    // trailingContiguous 保留的是尾段,所以被裁掉的是前 dropped 个点。
    const dropped = raw.length - rows.length;
    if (dropped > 0) {
      trims.push({ key: out, dropped, gapFrom: raw[dropped - 1]!.date, gapTo: rows[0]!.date });
    }

    if (rows.length) series[out] = rows;
    else unavailable.push(out);
  }

  // 只保留启用名单里的:名单外的公司(曾启用过、水位还留在库里)不该在面板上冒出来。
  const lag = getSecLag(db).filter((l) => ACTIVE_TICKERS.includes(l.ticker));

  return { series, unavailable, lag, trims };
}

/**
 * 宏观 / regime 指标:现拉外部源(零存储,见 spec),并行 + 优雅降级 + 内存 TTL 缓存。
 * 单源失败(FRED key 缺 / CBOE 符号 404 / CNN 反爬)→ 归入 unavailable,其余照常返回,不整体 500。
 * 净流动性 / 回购利差为读时派生(前向填充对齐后线性组合)。
 */
export const regimeRoute = new Hono().get('/', async (c) => {
  // 缓存命中也重读 SEC 那几条:它们由独立的 job 天天写库,进程内缓存看不到跨进程的写入,
  // 否则刚跑完 job 最长还要等 6h 才在面板上出现。读库很便宜,不值得为它整体失效缓存。
  if (cache && Date.now() - cache.at < TTL_MS) {
    const db = openDb();
    try {
      const sec = readSecSeries(db);
      const job = readDbBacked(db, cache.moveLive);
      return c.json({
        ...cache.body,
        series: { ...cache.body.series, ...sec.series, ...job.series },
        ohlc: { ...cache.body.ohlc, ...job.ohlc },
        // 按 key 集合剔除而不是按前缀:前缀耦合的话,以后往 JOB_WRITTEN_SERIES 里加一条
        // 不叫 gpu* 的(如 vix)就会漏剔,unavailable 里出现重复项。
        unavailable: [
          ...cache.body.unavailable.filter((n) => !n.startsWith(FUND_KEY_PREFIX) && !DB_BACKED_KEYS.has(n)),
          ...sec.unavailable,
          ...job.unavailable,
        ],
        secLag: sec.lag,
        secTrim: sec.trims,
      });
    } finally {
      db.close();
    }
  }

  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const fredSeries = (id: string): Promise<Point[]> =>
    fred.fetchSeries(id, HISTORY_START_DATE).then((rows) => rows.map((r) => ({ date: r.obsDate, value: r.value })));
  const cboeSeries = (sym: string): Promise<Point[]> =>
    fetchCboeIndexAsQuotes({ cboeSymbol: sym, storedSymbol: sym }).then((rows) =>
      rows.map((r) => ({ date: r.tradeDate, value: r.close })),
    );

  // 并行拉全部原始源。key 为内部名,后面映射到对外序列名。
  const src = {
    walcl: fredSeries('WALCL'),
    wtregen: fredSeries('WTREGEN'),
    rrp: fredSeries('RRPONTSYD'),
    rpo: fredSeries('RPONTSYD'),
    sofr: fredSeries('SOFR'),
    iorb: fredSeries('IORB'),
    hyOas: fredSeries('BAMLH0A0HYM2'),
    // dgs10 / dgs2 改走财政部 par yield 直发源(当天出,FRED DGS 慢 1-2 天),见下方 ustP。
    wages: fredSeries('FRBATLWGT3MMAUMHWGO'), // Atlanta Fed 薪资增速 tracker(3mma,月频 %)
    stickyCpi: fredSeries('CORESTICKM159SFRBATL'), // Atlanta Fed 核心黏性价格 CPI(Sticky Price CPI less food & energy,YoY%,月频;不等于服务通胀)
    // 5y5y 通胀远期:剥掉近 5 年、只看第 6-10 年的通胀定价,比 10Y BEI 更贴"长期通胀锚"。日频 %。
    // 用 FRED 官方口径,不自己拿 2×BEI10 − BEI5 算 —— DGS/DFII 是固定期限收益率不是零息,自算是近似。
    t5yifr: fredSeries('T5YIFR'),
    // Kim-Wright (2005) 三因子模型估的 10Y 零息期限溢价(Board of Governors,日频 %)。
    // ⚠️ 字段名必须带模型名:ACM(纽约联储)是另一套模型的同名指标,同一天可以差不少,
    // 两条并排看分歧带宽才是置信度,叫成 termPremium10y 会让两者被误当同一个东西。
    tp10Kw: fredSeries('THREEFYTP10'),
    // Kim-Wright 同一模型的 10Y 零息**拟合收益率**。单独没什么可看的,拉它是为了减出下面那条
    // 预期腿 —— 分解式 `长端 = 预期短端路径均值 + 期限溢价` 的左边一项,模型自己就发了,不必估。
    // (交接文档留的开放问题「KW 有没有配套预期短端序列」:没有直发,但 拟合 − 溢价 就是它,
    // 所以纽约联储 ACM 那个 10MB BIFF8 .xls 的 fetcher 不必为这条腿而写。)
    kwFitted10: fredSeries('THREEFY10'),
    cor1m: cboeSeries('COR1M'),
    vixeq: cboeSeries('VIXEQ'),
    // 恒定期限的即期隐含波动率指数。**和已有的 VX1/VX3 期货不是一回事**:VX3 是"三个月后那个
    // 30 天波动率"的**远期**,VIX3M 是"现在三个月"的**即期**。实测(2018-01-02~2026-08-07,
    // 2161 日)两者相关 0.876、**9.5% 的交易日符号相反**,互相替代会读反。
    vix3m: cboeSeries('VIX3M'),
    vix6m: cboeSeries('VIX6M'),
    // 即期期限结构价差的近端腿。**刻意不复用库里那条 VIX**:库里的由 daily job 维护
    // (vrpInputs 拓的,同样是 CBOE 收盘价 —— 数值完全相同),但 job 没跑那天它会停在昨天,
    // 而远端腿是实时的 → 内连接会把当天那根整根丢掉,恰好是最该看的一根。
    // 两腿同源同频才永远齐;代价只是多一次 HTTP。
    vixSpot: cboeSeries('VIX'),
    rxm: cboeSeries('RXM'),
    spx: cboeSeries('SPX'),
    fng: fetchFearGreed(),
    // 债市波动率 MOVE:日线 + meta 当日点(Yahoo 的 close 会整段返回 null,详见 fetchers/moveIndex)。
    // 库里还有 daily job 攒的补丁,在下方 db 段合并。
    move: fetchMoveSeries(new Date(HISTORY_START_DATE)).then((r) => r.points),
  };
  const names = Object.keys(src) as (keyof typeof src)[];
  // 美元指数 DXY 单独抓(要 OHLC 画蜡烛;全历史 1971→今,live 不落库)。moomoo OpenD 无 FX 行情权限。
  const usdBarsP = createYahooFetcher()
    .fetchDailyBars('DX-Y.NYB', new Date(0))
    .catch(() => null);
  // 日元 carry:USD/JPY(全历史)、JGB 2Y(美日利差的日腿)、CFTC 净持仓。均 catch→null。
  const usdjpyBarsP = createYahooFetcher()
    .fetchDailyBars('JPY=X', new Date(0))
    .catch(() => null);
  const jgbCurveP = fetchJgbCurve('2018-01-01').catch(() => null); // 一次拉,派生 2Y/10Y
  // 美债 par yield(财政部直发,当天新):一次拉,派生 10Y(利率波动率)/ 2Y(日元 carry 利差腿)。
  const ustP = fetchTreasuryCurve().catch(() => null);
  const jgbVixP = fetchJgbVix('2018-01-01').catch(() => null);
  const cftcJpyP = fetchCftcJpyNet('2018-01-01').catch(() => null);
  // VIX 期货持仓(TFF):波动率的 **positioning** 轴,和上面 VIX / 期限结构那组 **pricing** 轴互补。
  // 一次请求出两类(Asset Manager / Leveraged Money),别拆成两次。
  const vixCotP = fetchCftcVixNetOi('2018-01-01').catch(() => null);
  // 日银产出缺口 + 潜在增速(**季度更新**,1/4/7/10 月第三个工作日发)。一次 GET 拿全历史 → 不落库。
  // 起点 1994 不是 HISTORY_START_DATE:季频序列从 2018 起只剩 30 来个点,读不出泡沫破灭后那段长期负缺口。
  const bojGapP = fetchBojGap().catch(() => null);
  // 日本长端分解 + r*(中島上智模型)。**发布 2-4 个月不规律**(不是季频),两个 CSV 同日打包发。
  // 全历史 1995 起一次拿全 → 不落库;模型重估会改写整条历史,攒增量会把新旧 vintage 混成一条线。
  const nakajimaP = fetchNakajimaJgb().catch(() => null);
  // 席勒 CAPE(月频,Robert Shiller 数据集;全历史 1871→今)。
  const capeP = fetchShillerCape().catch(() => null);
  // HLW 自然利率 r*(纽约联储,**季频**,一年只发 4 次)。分解式里 L(名义长期中枢)= r* + T5YIFR 的前半。
  // 口径与陷阱见 fetchers/nyfedRstar 的文件头 —— 尤其「r* 是 L 不是减数」那条。
  const rstarP = fetchHlwRstar(HISTORY_START_DATE).catch(() => null);
  // ACM 期限溢价(纽约联储,**月频**)。给同格的 Kim-Wright 当独立对照 —— 两条的间距才是产品。
  // 源是个无文档端点(图表取数用),挂了就归 unavailable:少一条对照线,主线照画。见 fetchers/nyfedAcm。
  const acmP = fetchAcmTermPremium(HISTORY_START_DATE).catch(() => null);
  // 油品近月期货(Yahoo 连续近月,自带全历史,live 不落库)。派生油市结构 + 汽油 YoY。
  const yahooClose = (sym: string): Promise<Point[] | null> =>
    createYahooFetcher()
      .fetchDailyBars(sym, new Date(HISTORY_START_DATE))
      .then((bars) => bars.map((b) => ({ date: b.tradeDate, value: b.close })))
      .catch(() => null);
  // 各标的已 catch→null,Promise.all 不会拒绝;先建后 await(与其它源同批),
  // 别在 allSettled(src) 挂处理器前 await——否则 src 源在此窗口拒绝会成 unhandled。
  const oilP = Promise.all(['CL=F', 'BZ=F', 'HO=F', 'RB=F'].map(yahooClose));
  // EIA 周报(周三 10:30 ET 发,数据截止上周五)。六条都不落库:一次 GET 给全量历史,
  // 修订(下周会改上周值)因此自然带回来,不必攒增量。各自 catch→null,挂了只丢那一格。
  //
  // **这一条 catch 会出声,同文件另外那些不会** —— 不是随手加的:EIA 的 fetcher 会在
  // 「源给了行但一行都解析不出来」时抛错(见 fetchers/eia),那是**源还活着但响应结构变了**,
  // 与网络挂掉是两回事,且只能靠改代码修。静默吞掉的话两者都只表现为那格 unavailable,查不出区别。
  // 其余源的失败是网络/源侧不可用,unavailable 本身已经说明问题,不必再刷日志。
  const eiaKey = process.env.EIA_API_KEY ?? '';
  const eia = createEiaFetcher({ apiKey: eiaKey });
  // 没 key 就别发这六个请求 —— 每个都会往回抛同一句「缺 key」,徒增六次往返和六行日志。
  // 那不是失败,是没配;下面 hasEiaKey 也据此把这八条从缓存条件里豁免。
  if (!eiaKey) console.warn('[regime] 未配 EIA_API_KEY,「炼厂·库存」整块不可用(其余视角不受影响)');
  const eiaWeekly = (id: string): Promise<Point[] | null> =>
    eiaKey
      ? eia.fetchWeekly(id).catch((e: unknown) => {
          console.warn(`[regime] EIA ${id} 现拉失败,本次该格 unavailable: ${(e as Error).message}`);
          return null;
        })
      : Promise.resolve(null);
  const eiaP = Promise.all(
    [
      'WPULEUS3', // 炼厂开工率 %
      'WDISTUS1', // 馏分油库存 千桶
      'WGTSTUS1', // 汽油总库存 千桶
      'WDIEXUS2', // 馏分油出口 千桶/日
      'WGIRIUS2', // 炼厂原油加工量 千桶/日
      'WDIRPUS2', // 馏分油产量 千桶/日
      // 零售泵价两条($/gal,**周一发**,与上面六条周三的不是同一天)。
      // ⚠️ 柴油取 **XL0**(ULSD 0-15ppm,DOE 每周口播的 on-highway 头条数)而不是 `EMD_EPD2D_...`
      // (No.2 全类型):只有 XL0 与批发腿的 ULSD 期货同口径,减出来的加价才干净。2007 年后两条
      // 数值几乎重合,所以选错不会露馅 —— 正因为不露馅,这里写死并注明。
      'EMD_EPD2DXL0_PTE_NUS_DPG', // 零售柴油 $/gal
      'EMM_EPM0_PTE_NUS_DPG', // 零售汽油(全等级)$/gal
    ].map(eiaWeekly),
  );
  const settled = await Promise.allSettled(Object.values(src));
  const raw: Partial<Record<keyof typeof src, Point[]>> = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw[names[i]] = s.value;
  });
  const usdBars = await usdBarsP;
  const [usdjpyBars, jgbCurve, cftcJpy, vixCot, jgbVix, cape, ust, rstar, acm, bojGap, nakajima] = await Promise.all([
    usdjpyBarsP,
    jgbCurveP,
    cftcJpyP,
    vixCotP,
    jgbVixP,
    capeP,
    ustP,
    rstarP,
    acmP,
    bojGapP,
    nakajimaP,
  ]);
  const [wti, brent, diesel, rbob] = await oilP;
  const [refUtil, distStocks, gasStocks, distExports, crudeRuns, distProd, dieselRetail, gasRetail] = await eiaP;
  const jgb2y = jgbCurve?.series['2Y'] ?? null;
  const jgb10y = jgbCurve?.series['10Y'] ?? null;
  const dgs10 = ust?.['10Y'] ?? null;
  const dgs2 = ust?.['2Y'] ?? null; // 美日 2Y 利差的日腿

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  let secLag: SecLag[] = [];
  let secTrim: FundTrim[] = [];

  // 有值 → 落对外序列;否则记入 unavailable。收敛 5 处「存在性分支」,读时一目了然。
  // ⚠️ 判的是 **length 不是真值**:`[]` 在 JS 里是真的,而「源返回 200 但内容为空」
  // (CBOE 只回表头 / 解析全失败 / inner join 零重叠)必须归 unavailable —— 否则那格既不进
  // 缺失提示,面板还要拿空序列去算分位。放在这里判,调用方就不必人人记得自己 guard 一遍。
  const put = (name: SeriesKey, value: Point[] | undefined) => {
    if (value?.length) series[name] = value;
    else unavailable.push(name);
  };

  // 直接对外的序列(对外名 → 原始源名)。
  const direct: Partial<Record<RegimeSeries, keyof typeof src>> = {
    hyOas: 'hyOas',
    cor1m: 'cor1m',
    vixeq: 'vixeq',
    fng: 'fng',
    vix6m: 'vix6m',
    reverseRepo: 'rrp',
    repoUsage: 'rpo',
    wages: 'wages',
    stickyCpi: 'stickyCpi',
    t5yifr: 't5yifr',
    tp10Kw: 'tp10Kw',
  };
  // 空数组归 unavailable 由 put 统一兜(见其注释),这里直接传。
  // Object.entries 会把 key 拓宽回 string,这里断言回来 —— 真正的校验发生在上面的对象字面量。
  for (const [out, s] of Object.entries(direct) as [RegimeSeries, keyof typeof src][]) put(out, raw[s!]);

  // DXY:close 进 series(unavailable/存在性),OHLC 进 ohlc(蜡烛)。缺 → 归 unavailable。
  put('usd', usdBars?.length ? usdBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  // 日元 carry 三序列
  put('usdjpy', usdjpyBars?.length ? usdjpyBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  put('cftcJpy', cftcJpy?.length ? cftcJpy : undefined);
  // VIX 期货持仓两类(周频,周二持仓 / 周五 15:30 ET 发)
  put('vixCotAm', vixCot?.assetMgr);
  put('vixCotLm', vixCot?.levMoney);
  put('dgs10', dgs10?.length ? dgs10 : undefined); // 10Y 国债(财政部直发,利率波动率 pane)
  put('usjp2y', dgs2?.length && jgb2y?.length ? subtractAligned([dgs2, jgb2y]) : undefined); // 美日 2Y 利差 = UST2Y − JGB2Y
  // KW 预期腿 = 拟合 10Y − 期限溢价 = 未来 10 年预期短端利率的平均。
  // 用 subtractAt(inner join)而非 subtractAligned:这是同期恒等式,不是水位组合 —— 缺日就该跳过,
  // 不该配出「昨天的拟合收益率 − 今天的溢价」。两腿当前日历一致(见 subtractAt 的注释),
  // 两种写法此刻输出相同;写成 inner join 是为了不把正确性押在那个巧合上。
  // ⚠️ 判的是**派生后**的长度不是输入腿:inner join 零重叠就返回 [],空数组在 JS 里是真值,
  // 直接 put 会落成 `series.expShort10Kw = []` —— 既不进 unavailable,面板还要拿空序列去算分位。
  put('expShort10Kw', subtractAt(raw.kwFitted10 ?? [], raw.tp10Kw ?? []));
  put('jgb10y', jgb10y?.length ? jgb10y : undefined);
  put('jgbVix', jgbVix?.length ? jgbVix : undefined);
  // 日银产出缺口(日历季度)+ 潜在增速及四项贡献度(财年半期)。**两条频率不同、时间轴不是一套**,
  // 各发各的,面板上也分两格 —— 别在任何一层把它们对齐(见 fetchers/bojOutputGap 的文件头)。
  put('jpOutputGap', bojGap?.outputGap);
  put('jpPotentialGrowth', bojGap?.potentialGrowth);
  put('jpPotTfp', bojGap?.potTfp);
  put('jpPotCapital', bojGap?.potCapital);
  put('jpPotHours', bojGap?.potHours);
  put('jpPotWorkers', bojGap?.potWorkers);
  // 日本长端分解:期限溢价 + 预期短端(日频)、r* 及其 95% 区间(季频)。
  // ⭐ 实测 `期限溢价 + 预期短端 − MOF 名义 10Y` 残差恒为 0 —— 这套分解重构的就是同一条曲线,不是第三方近似。
  // **基准是 MOF 全历史 CSV(1986 起)下的 7724 个重叠日**;拿面板自己的 `jgb10y`(2018 起)复现只会得到
  // 2071 天,不是注释写错了。
  // ⚠️ r* 与这两条**不是一套口径**:它是实际利率(日银自然利子率定义),那两条是名义。别在任何一层相减或比高低。
  put('jpTp10Nakajima', nakajima?.termPremium10);
  put('jpExpShort10Nakajima', nakajima?.expectedRate10);
  put('jpRstar10Nakajima', nakajima?.rstar10);
  put('jpRstar10NakajimaLo', nakajima?.rstar10Lo);
  put('jpRstar10NakajimaHi', nakajima?.rstar10Hi);
  // ⚠️ 字段名带 `Current`:将来接 real-time 那套会撞名,且**现在就有人会误读** ——
  // current 的历史值是今天用全部数据回头重画的,不是当时看得到的值(前视偏差)。
  put('rstarHlwCurrent', rstar?.length ? rstar : undefined);
  put('tp10Acm', acm ?? undefined);
  // L 的粗代理 = HLW r*(实际中枢) + 5y5y 通胀远期(通胀锚)。**只为了和 A 并排读符号**,
  // 面板上不做 L − A、不乘 (T₂−T₁)/T₂ 系数、不出单一数字 —— 四层污染叠着,减出来的量不可识别:
  //   ① L 与 A 出自不同模型家族(HLW 宏观状态空间 vs Kim-Wright 期限结构),差里装着两模型的分歧,
  //      而那个分歧无法与真实的 L − A 分离;
  //   ② T5YIFR 是第 6-10 年,L 要的是第 11-30 年,而第 6-10 年恰好还在 A 的覆盖区间内(两边共用一段);
  //   ③ HLW r* 是**当下**的自然利率(现时状态量),不是「第 10 年以后的预期短端」。
  //   外加口径混用:THREEFY10 是零息,而要对照的 30Y−10Y 来自 par yield。
  // 符号(A 在上 = 偏差为负 = 利差低估两段溢价之差)比量级稳健得多,不依赖上面任何一条成立。
  // 按 r* 的季度日取点(见 sumAtAnchorDates):L 的分辨率由 r* 那一半决定,拉成日频是虚报精度。
  // 同上判派生后:所有锚点日都早于日频腿首个观测时 sumAtAnchorDates 返回 []。
  put('lProxyHlwT5yifr', sumAtAnchorDates(rstar ?? [], raw.t5yifr ?? []));
  // CAPE 图只画 1990+(全历史 1871 太远、可眼看互联网泡沫);分位窗口更近(前端 pctlSince 2000+)。
  const cape1990 = cape?.filter((p) => p.date >= '1990-01-01');
  put('cape', cape1990?.length ? cape1990 : undefined);
  const ohlc: Record<string, OhlcBar[]> = {};
  if (usdBars?.length) ohlc.usd = toOhlc(usdBars.map((b) => ({ ...b, date: b.tradeDate })));

  // 派生:分量齐才算,缺则整条进 unavailable。
  // RRPONTSYD 源为「十亿美元」,而 WALCL/WTREGEN 为「百万美元」——RRP 腿必须 ×1000 对齐,
  // 否则被缩小 1000 倍(历史高 RRP 期 ~$2.5T 会让净流动性严重虚高)。
  put(
    'netLiquidity',
    raw.walcl && raw.wtregen && raw.rrp ? subtractAligned([raw.walcl, raw.wtregen, scale(raw.rrp, 1000)]) : undefined,
  );
  put('repoStress', raw.iorb && raw.sofr ? subtractAligned([raw.iorb, raw.sofr]) : undefined);
  // RXM(Cboe 风险逆转指数:买 25Δ call / 卖 25Δ put 滚动策略)/ SPX:该策略相对 SPX 的累计表现比。
  put('rxmSpx', raw.rxm && raw.spx ? divideAligned(raw.rxm, raw.spx) : undefined);

  // 油市结构(物理紧张):Brent−WTI 海运 vs 内陆;柴油裂解 = ULSD×42 − WTI(HO 单位 $/gal→$/bbl)。
  put('brentWti', brent && wti ? subtractAligned([brent, wti]) : undefined);
  // 三条裂解在 analytics/oilCracks 里算(纯函数,带变异检验;口径与「为什么写成加权平均」见那边)。
  const cracks = oilCracks({ wti, diesel, rbob });
  put('dieselCrack', cracks.dieselCrack);
  put('rbobCrack', cracks.rbobCrack);
  put('crack321', cracks.crack321);
  // ULSD 批发裸价 $/gal。裂解已经用它当输入腿,这里只是把腿本身发出来 —— 零售加价那格要拿它当减数,
  // 泵价单独一条线归因不了「涨的是原油、裂解还是零售加价」。⚠️ Yahoo 腿不是 EIA 腿:
  // 缺 key 时零售那几条恒缺而这条照常有,所以**它不能进 EIA_SERIES 的豁免名单**(进了就等于
  // 把一条真失败也放行)。
  put('ulsd', diesel ?? undefined);

  // EIA 周报六条原始序列 → 八条对外线。**水位只发炼厂开工率** —— 它是有绝对刻度的(口播的"98%"就是它,
  // 且 100% 是硬顶,一眼看得出还剩多少余量)。库存/出口的裸水位单看不携带信息
  // (1.05 亿桶是高是低取决于现在是 3 月还是 9 月),所以库存两条与出口只发季节 z。
  // EIA 多拉的那几年历史(展示起点再往前垫 SEASONAL_BASELINE_YEARS 年,约 2013 起)是**给季节 z 当基准期用的**,不该画到图上(别的线都从 2018 起,
  // 混在一起会让 hover 对不上)。所以先算 z 再裁 —— 顺序反了就等于把基准期一起砍掉。
  const fromHistoryStart = (rows: Point[]) => rows.filter((p) => p.date >= HISTORY_START_DATE);
  const seasonal = (rows: Point[] | null) =>
    seasonalZFrom(rows, { years: SEASONAL_BASELINE_YEARS, from: HISTORY_START_DATE });

  put('refUtil', refUtil ? fromHistoryStart(refUtil) : undefined);
  put('refUtilZ5y', seasonal(refUtil));
  put('distStocksZ5y', seasonal(distStocks));
  put('gasStocksZ5y', seasonal(gasStocks));
  put('distExportsZ5y', seasonal(distExports));

  // 「开得更狠也不够」那条论证的两条腿。**发收率 + 两条同比,不发两条水位** ——
  // 加工量 1760 万桶/日、馏分油产量 535 万桶/日,这两个水位单看谁也答不了「够不够」;
  // 有判别力的是「一桶原油出多少柴油」(收率)和「比去年多炼了,柴油有没有跟着多出来」(同比)。
  // 开工率那格已经答了「开多狠」,这里不重复发加工量水位。
  const yieldPct = distillateYield(distProd, crudeRuns);
  put('distYield', yieldPct && fromHistoryStart(yieldPct));
  put('crudeRunsYoy', crudeRuns ? fromHistoryStart(yoyPct(crudeRuns)) : undefined);
  put('distProdYoy', distProd ? fromHistoryStart(yoyPct(distProd)) : undefined);
  // 零售泵价与零售加价。**加价才是可测量,泵价水位不是** —— 家庭体感钉的是泵价,
  // 但泵价里同时装着原油、裂解、零售加价三层,只发水位则涨跌归因不了。
  // 加价 = 泵价 − 同口径批发($/gal 直接减,不 ×42),锚在零售的周一上(见 analytics/retailMargin)。
  // ⚠️ 汽油那条是判别腿:柴油加价走阔时,对照汽油才分得清「全行业零售在加价」还是「柴油独有」。
  //    材料整条论证(柴油打供应链、汽油打家庭出行)靠的正是「柴油独有」。
  const dieselRetailS = dieselRetail && fromHistoryStart(dieselRetail);
  const gasRetailS = gasRetail && fromHistoryStart(gasRetail);

  put('dieselRetail', dieselRetailS ?? undefined);
  put('gasRetail', gasRetailS ?? undefined);
  put('dieselRetailMargin', retailMargin(dieselRetailS, diesel));
  put('gasRetailMargin', retailMargin(gasRetailS, rbob));
  // 汽油 RBOB 同比:CPI 汽油分项的高频前瞻,进「通胀来源」与薪资/核心黏性 CPI 并读。
  const rbobYoyS = rbob ? yoyPct(rbob) : null;
  put('rbobYoy', rbobYoyS?.length ? rbobYoyS : undefined);

  // VIX / VXN 已在库里(market_series,daily job 维护)→ 直接读,不外拉。
  const db = openDb();
  try {
    const dbBacked = readDbBacked(db, raw.move ?? []);
    Object.assign(series, dbBacked.series);
    Object.assign(ohlc, dbBacked.ohlc);
    unavailable.push(...dbBacked.unavailable);

    const spotTerm = nearMinusFar({ near: raw.vixSpot ?? [], far: raw.vix3m ?? [] });
    put('vixSpotTerm', spotTerm.length ? spotTerm : undefined);

    const sec = readSecSeries(db);
    // 基本面是按名单派生的动态键(fund:NVDA:fcf / fund:buyerFcf),枚举不了,由 FundSeries 覆盖。
    for (const [out, rows] of Object.entries(sec.series) as [FundSeries, Point[]][]) put(out, rows);
    unavailable.push(...sec.unavailable);
    secLag = sec.lag;
    secTrim = sec.trims;
  } finally {
    db.close();
  }

  const body: RegimeBody = { series, unavailable, ohlc, secLag, secTrim };
  // 只缓存全成功(降级响应不缓存,下次重试)。例外:SEC 那几条是季频、GPU 那几条(gpu 前缀)
  // 是新接的 experimental 源(B300 允许缺、库还没跑过 job 时四条都缺)—— 两者都靠独立 job 逐日/逐季攒,
  // 从没跑过 job 的库里必然缺——不能让这类常态把整条路由的缓存永久关掉。
  // 没配 key 时 EIA 那八条恒缺 —— 与 SEC/GPU 同属「必然缺」,不能让它把缓存永久关掉。
  // 配了 key 才缺则是真失败(网络/源结构变了),照旧挡住缓存等下次重试。
  if (shouldCache(unavailable, { hasEiaKey: Boolean(eiaKey) }))
    cache = { at: Date.now(), body, moveLive: raw.move ?? [] };
  return c.json(body);
});
