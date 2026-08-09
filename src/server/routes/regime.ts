import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { createFredFetcher } from '../fetchers/fred';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchFearGreed } from '../fetchers/cnnFearGreed';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchJgbCurve } from '../fetchers/mofJgb';
import { fetchJgbVix } from '../fetchers/jpxJgbVix';
import { fetchCftcJpyNet } from '../fetchers/cftcCot';
import { fetchMoveSeries, mergeMove } from '../fetchers/moveIndex';
import { fetchShillerCape } from '../fetchers/capeShiller';
import { fetchTreasuryCurve } from '../fetchers/usTreasuryPar';
import { subtractAligned, divideAligned, yoyPct, scale, type Point } from '../analytics/regime';
import { computeSpread } from '../analytics/termStructure';
import { openDb } from '../storage/db';
import { getMarketSeries, getSecLag } from '../storage/repository';
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
let cache: { at: number; body: RegimeBody } | null = null;

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
  revM: (t) => twseSeriesId(t, 'revM'),
  revYoy: (t) => twseSeriesId(t, 'revYoy'),
};

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
      return c.json({
        ...cache.body,
        series: { ...cache.body.series, ...sec.series },
        unavailable: [...cache.body.unavailable.filter((n) => !n.startsWith(FUND_KEY_PREFIX)), ...sec.unavailable],
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
    stickyCpi: fredSeries('CORESTICKM159SFRBATL'), // Sticky Price CPI(服务黏性,YoY%,月频)
    cor1m: cboeSeries('COR1M'),
    vixeq: cboeSeries('VIXEQ'),
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
  // 席勒 CAPE(月频,Robert Shiller 数据集;全历史 1871→今)。
  const capeP = fetchShillerCape().catch(() => null);
  // 油品近月期货(Yahoo 连续近月,自带全历史,live 不落库)。派生油市结构 + 汽油 YoY。
  const yahooClose = (sym: string): Promise<Point[] | null> =>
    createYahooFetcher()
      .fetchDailyBars(sym, new Date(HISTORY_START_DATE))
      .then((bars) => bars.map((b) => ({ date: b.tradeDate, value: b.close })))
      .catch(() => null);
  // 各标的已 catch→null,Promise.all 不会拒绝;先建后 await(与其它源同批),
  // 别在 allSettled(src) 挂处理器前 await——否则 src 源在此窗口拒绝会成 unhandled。
  const oilP = Promise.all(['CL=F', 'BZ=F', 'HO=F', 'RB=F'].map(yahooClose));
  const settled = await Promise.allSettled(Object.values(src));
  const raw: Partial<Record<keyof typeof src, Point[]>> = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw[names[i]] = s.value;
  });
  const usdBars = await usdBarsP;
  const [usdjpyBars, jgbCurve, cftcJpy, jgbVix, cape, ust] = await Promise.all([
    usdjpyBarsP,
    jgbCurveP,
    cftcJpyP,
    jgbVixP,
    capeP,
    ustP,
  ]);
  const [wti, brent, diesel, rbob] = await oilP;
  const jgb2y = jgbCurve?.series['2Y'] ?? null;
  const jgb10y = jgbCurve?.series['10Y'] ?? null;
  const dgs10 = ust?.['10Y'] ?? null;
  const dgs2 = ust?.['2Y'] ?? null; // 美日 2Y 利差的日腿

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  let secLag: SecLag[] = [];
  let secTrim: FundTrim[] = [];

  // 有值 → 落对外序列;否则记入 unavailable。收敛 5 处「存在性分支」,读时一目了然。
  // (传 undefined 表示该序列缺失/为空;直接源用存在性、派生/库源用长度决定是否传值。)
  const put = (name: string, value: Point[] | undefined) => {
    if (value) series[name] = value;
    else unavailable.push(name);
  };

  // 直接对外的序列(对外名 → 原始源名)。
  const direct: Record<string, keyof typeof src> = {
    hyOas: 'hyOas',
    cor1m: 'cor1m',
    vixeq: 'vixeq',
    fng: 'fng',
    reverseRepo: 'rrp',
    repoUsage: 'rpo',
    wages: 'wages',
    stickyCpi: 'stickyCpi',
  };
  for (const [out, s] of Object.entries(direct)) put(out, raw[s]);

  // DXY:close 进 series(unavailable/存在性),OHLC 进 ohlc(蜡烛)。缺 → 归 unavailable。
  put('usd', usdBars?.length ? usdBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  // 日元 carry 三序列
  put('usdjpy', usdjpyBars?.length ? usdjpyBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  put('cftcJpy', cftcJpy?.length ? cftcJpy : undefined);
  put('dgs10', dgs10?.length ? dgs10 : undefined); // 10Y 国债(财政部直发,利率波动率 pane)
  put('usjp2y', dgs2?.length && jgb2y?.length ? subtractAligned([dgs2, jgb2y]) : undefined); // 美日 2Y 利差 = UST2Y − JGB2Y
  put('jgb10y', jgb10y?.length ? jgb10y : undefined);
  put('jgbVix', jgbVix?.length ? jgbVix : undefined);
  // CAPE 图只画 1990+(全历史 1871 太远、可眼看互联网泡沫);分位窗口更近(前端 pctlSince 2000+)。
  const cape1990 = cape?.filter((p) => p.date >= '1990-01-01');
  put('cape', cape1990?.length ? cape1990 : undefined);
  const ohlc: Record<string, OhlcBar[]> = {};
  if (usdBars?.length) {
    ohlc.usd = usdBars.map((b) => ({
      time: b.tradeDate,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
    }));
  }

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
  const dieselBbl = diesel ? scale(diesel, 42) : null; // ULSD $/gal → $/bbl
  put('dieselCrack', dieselBbl && wti ? subtractAligned([dieselBbl, wti]) : undefined);
  // 汽油 RBOB 同比:CPI 汽油分项的高频前瞻,进「通胀来源」与薪资/服务黏性并读。
  const rbobYoyS = rbob ? yoyPct(rbob) : null;
  put('rbobYoy', rbobYoyS?.length ? rbobYoyS : undefined);

  // VIX / VXN 已在库里(market_series,daily job 维护)→ 直接读,不外拉。
  const db = openDb();
  try {
    for (const [out, sym] of [
      ['vix', 'VIX'],
      ['vxn', 'VXN'],
    ] as const) {
      const rows = getMarketSeries(db, sym);
      put(out, rows.length ? rows : undefined);
    }
    // VX1−V3 期限结构价差(读 VX1/VX3 现算),给情绪视角画符号柱状图。
    const spread = computeSpread(getMarketSeries(db, 'VX1'), getMarketSeries(db, 'VX3'));
    put('vxTermSpread', spread.length ? spread.map((r) => ({ date: r.date, value: r.spread })) : undefined);

    // MOVE:实时拉的优先,库里的补丁只填 Yahoo 断供的那些天。
    const move = mergeMove(raw.move ?? [], getMarketSeries(db, 'MOVE'));
    put('move', move.length ? move : undefined);

    const sec = readSecSeries(db);
    for (const [out, rows] of Object.entries(sec.series)) put(out, rows);
    unavailable.push(...sec.unavailable);
    secLag = sec.lag;
    secTrim = sec.trims;
  } finally {
    db.close();
  }

  const body: RegimeBody = { series, unavailable, ohlc, secLag, secTrim };
  // 只缓存全成功(降级响应不缓存,下次重试)。例外:SEC 那几条是季频、靠单独的 job 逐季攒,
  // 从没跑过 job 的库里它们必然缺——不能让这个常态把整条路由的缓存永久关掉。
  if (unavailable.every((n) => n.startsWith(FUND_KEY_PREFIX))) cache = { at: Date.now(), body };
  return c.json(body);
});
