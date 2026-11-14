import { Hono } from 'hono';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config';
import { createSwrCache } from './swrCache';
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
import { fetchBojSeries, TANKAN_INFL_EXP } from '../fetchers/bojStat';
import { fetchCoreCoreCpiYoy } from '../fetchers/estatCpi';
import { BOJ_HIKES, betaLegs, depositBeta, jpBankSpreads, monthlyMean } from '../analytics/jpBanks';
import { fetchMoveSeries } from '../fetchers/moveIndex';
import { fetchShillerCape } from '../fetchers/capeShiller';
import { fetchHlwRstar } from '../fetchers/nyfedRstar';
import { fetchAcmTermPremium } from '../fetchers/nyfedAcm';
import { fetchTreasuryCurve } from '../fetchers/usTreasuryPar';
import { fetchHormuzTransits } from '../fetchers/portwatch';
import { fetchMofWeeklyFlows } from '../fetchers/mofSecurities';
import { fetchFinraMargin } from '../fetchers/finraMargin';
import { fetchJpxMarginBuy } from '../fetchers/jpxMargin';
import {
  subtractAligned,
  subtractAt,
  netLiquidityWeekly,
  scale,
  divideAligned,
  yoyPct,
  yoyPctWeekly,
  rollingMean,
  sumAtAnchorDates,
  seasonalZFrom,
  oilCracks,
  distillateYield,
  retailMargin,
  monthlyAnnualizedPct,
  releaseMarkers,
  eqwDdSpread,
  type Point,
} from '../analytics/regime';
import type { RegimeSeries, FundSeries, SeriesKey, RegimeOhlcKey } from '../../shared/regimeSeries';
import { rollMismatchFlags } from '../../shared/calc/oilRoll';
import { nearMinusFar } from '../analytics/termStructure';
import { openDb } from '../storage/db';
import { getSecLatestFiled } from '../storage/repository';
import { HISTORY_START_DATE, SEASONAL_BASELINE_YEARS } from '../config';
import type { FundTrim, SecFiled, SecLag } from '../../shared/aiChain';
import {
  type RegimeBody,
  type RegimeCached,
  mergeDbRead,
  resolveSofr,
  resolveJgbVix,
  fillFromPrev,
  shouldCache,
} from './regimePolicy';
import { toOhlc, readDbBacked, readSecSeries } from './regimeDb';
import type { OhlcBar } from './regimeKeys';

// stale-while-revalidate(见 swrCache):有旧值先回、过期后台刷新,单个慢源(EIA 偶发卡 40s)不再拖住整页。
// EOD 日频数据盘中不变,TTL 取 6h 安全;降级结果 10 分钟后重试(不粘 6h,也不每个请求打一轮全套上游)。
// 完整结果落盘 → dev `--watch` 重启后也是先回盘上那份。
const regimeCache = createSwrCache<RegimeCached>({
  ttlMs: 6 * 60 * 60 * 1000,
  retryMs: 10 * 60 * 1000,
  snapshotPath: resolve(PROJECT_ROOT, 'data', 'cache', 'regime.json.gz'),
  load: (prev) => fetchFresh(prev ?? undefined),
});

/**
 * 宏观 / regime 指标:现拉外部源(零存储,见 spec),并行 + 优雅降级 + 内存 TTL 缓存。
 * 单源失败(FRED key 缺 / CBOE 符号 404 / CNN 反爬)→ 归入 unavailable,其余照常返回,不整体 500。
 * 净流动性 / 回购利差为读时派生(净流动性锚在周三、回购利差锚在 SOFR 营业日,见各自注释)。
 */
export const regimeRoute = new Hono().get('/', async (c) => {
  const { value: cache, refreshing, partial } = await regimeCache.get();

  // 每次都重读 SEC 与库里那几条:它们由独立的 job 天天写库,进程内缓存看不到跨进程的写入,
  // 否则刚跑完 job 最长还要等 6h 才在面板上出现。读库很便宜,不值得为它整体失效缓存。
  const db = openDb();
  try {
    const sec = readSecSeries(db);
    const job = readDbBacked(db, cache.moveLive, cache.sofrLive, cache.hyOasLive ?? []);
    return c.json({
      ...cache.body,
      ...mergeDbRead(cache.body, [sec, job]),
      secLag: sec.lag,
      secTrim: sec.trims,
      secFiled: getSecLatestFiled(db),
      refreshing,
      partial,
    });
  } finally {
    db.close();
  }
});

/** 并行现拉全部外部源 + 读库派生。全成功才算 complete(见 shouldCache);缺的用 prev 顶上(见 fillFromPrev)。 */
async function fetchFresh(prev: RegimeCached | undefined): Promise<{ value: RegimeCached; complete: boolean }> {
  const t0 = performance.now();
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
    // TGA 取**周三时点** WDTGAL,与 WALCL(周三时点)同口径。别换回 WTREGEN:那是含周末的周平均,
    // 相减会把缴税日这类单日抽水摊平并滞后一周(实测 2026-09-09→16 准备金 −115B,用 WTREGEN 算反而 +12B)。
    wdtgal: fredSeries('WDTGAL'),
    // 准备金余额,周三时点(源为百万美元,对外 ÷1000 成十亿美元,见下方 put)。不用周平均 WRESBAL,理由同上。
    reserves: fredSeries('WRBWFRBL'),
    rrp: fredSeries('RRPONTSYD'),
    rpo: fredSeries('RPONTSYD'),
    sofr: fredSeries('SOFR'),
    iorb: fredSeries('IORB'),
    // FRED 只留 3 年:长历史在库里(daily 的 credit_spread 组镜像),在下方 db 段合并,同 MOVE
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
    // 政策利率目标区间(日频 %)。只当参照:算加息次数的基准是 SOFR 隔夜,不是区间中值(见 shared/calc/policyPath)。
    fedTargetUpper: fredSeries('DFEDTARU'),
    fedTargetLower: fredSeries('DFEDTARL'),
    // SEP 点阵图中值。⚠️ FEDTARMD 的日期轴是「预测哪一年」(YYYY-01-01),FRED 只留最新一版 → 下面改记为年底。
    sepMedian: fredSeries('FEDTARMD'),
    sepMedianLr: fredSeries('FEDTARMDLR'),
    cor1m: cboeSeries('COR1M'),
    cor3m: cboeSeries('COR3M'),
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
  // 市值集中度:标普 500 与标普 500 等权两个**价格指数**(都不含分红、不扣费,口径一致;比 SPY/RSP 干净)。
  // 等权指数 2006-12 起。live 不落库。
  const spxCapP = createYahooFetcher()
    .fetchDailyBars('^GSPC', new Date('2006-12-01'))
    .catch(() => null);
  const spxEqwP = createYahooFetcher()
    .fetchDailyBars('^SPXEW', new Date('2006-12-01'))
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
  // MOF 周度跨境证券流(carry 的资金流上游)。一个 CSV 2005 起全历史 → 不落库
  const mofFlowsP = fetchMofWeeklyFlows().catch(() => null);
  // FINRA 保证金债务(美股融资余额,月频,1997 起一个 xlsx)。同比要往前垫一年,所以全量拉、算完再裁
  // 两条杠杆源的 catch 出声(同 EIA):解析器会在表头 / 年月 / 交接处 / 数值对不上时抛错,那是「源改版了、只能改代码修」,
  // 静默吞掉的话界面上和网络失败一样只显示 unavailable,分不出原因
  const warnNull = (name: string) => (e: unknown) => {
    console.warn(`[regime] ${name} 现拉失败,本次该格 unavailable: ${(e as Error).message}`);
    return null;
  };
  const marginP = fetchFinraMargin().catch(warnNull('FINRA 保证金'));
  // JPX 信用买残(日本版融资余额,周频,2002 起;三份官方文件拼接,见 fetchers/jpxMargin)
  const jpMarginP = fetchJpxMarginBuy().catch(warnNull('JPX 信用残'));
  // VIX 期货持仓(TFF):波动率的 **positioning** 轴,和上面 VIX / 期限结构那组 **pricing** 轴互补。
  // 一次请求出两类(Asset Manager / Leveraged Money),别拆成两次。
  const vixCotP = fetchCftcVixNetOi('2018-01-01').catch(() => null);
  // 日银产出缺口 + 潜在增速(**季度更新**,1/4/7/10 月第三个工作日发)。一次 GET 拿全历史 → 不落库。
  // 起点 1994 不是 HISTORY_START_DATE:季频序列从 2018 起只剩 30 来个点,读不出泡沫破灭后那段长期负缺口。
  const bojGapP = fetchBojGap().catch(() => null);
  // 日本长端分解 + r*(中島上智模型)。**发布 2-4 个月不规律**(不是季频),两个 CSV 同日打包发。
  // 全历史 1995 起一次拿全 → 不落库;模型重估会改写整条历史,攒增量会把新旧 vintage 混成一条线。
  const nakajimaP = fetchNakajimaJgb().catch(() => null);
  // 日本银行业利率传导(日银统计 API,月频;跨 DB 只能分开请求)。能回填全历史 → 读时现拉、不落库。
  // 存款 2022-04 才开始有,所以都从 2022 起拉:贷款利率虽然 1993 起就有,单看水平不是这格要读的东西。
  const bojBankP = Promise.all([
    fetchBojSeries('IR02', ['DLDR121N'], '202201'),
    fetchBojSeries('IR04', ['DLLR2CIDBST1'], '202201'),
    fetchBojSeries('FM01', ['STRDCLUCON'], '202201'),
  ]).catch(() => null);
  // 日本通胀两条(「日本 · 通胀」那格)。CGPI:日银 PR01 月度指数,多拉一年给同比垫对照期;
  // 新核心核心 CPI:e-Stat(要 appId),表里现成有同比列,从展示起点拉即可。没配 appId 不发请求,归 unavailable。
  const cgpiP = fetchBojSeries('PR01', ['PRCG20_2200000000'], '201701').catch(() => null);
  // 短観企业物价预期(季频,`YYYYQQ`;2014Q1 起才有这一问)。从展示起点那一季拉
  const tankanP = fetchBojSeries('CO', TANKAN_INFL_EXP, '201801', { quarterly: true }).catch(() => null);
  const estatKey = process.env.ESTAT_APP_ID ?? '';
  const coreCoreCpiP = estatKey
    ? // 这条 catch 出声(同 EIA):配了 appId 还失败会一直挡缓存,静默的话查不到是 key 过期还是源挂了。
      // fetcher 保证 message 里不含 appId,可以直接打。
      fetchCoreCoreCpiYoy(estatKey, HISTORY_START_DATE.slice(0, 7)).catch((e: unknown) => {
        console.warn(`[regime] e-Stat 新核心核心 CPI 现拉失败,本次该格 unavailable: ${(e as Error).message}`);
        return null;
      })
    : Promise.resolve(null);
  const mufgBarsP = createYahooFetcher()
    .fetchDailyBars('8306.T', new Date(HISTORY_START_DATE))
    .catch(() => null);
  // 席勒 CAPE(月频,Robert Shiller 数据集;全历史 1871→今)。
  const capeP = fetchShillerCape().catch(() => null);
  // HLW 自然利率 r*(纽约联储,**季频**,一年只发 4 次)。分解式里 L(名义长期中枢)= r* + T5YIFR 的前半。
  // 口径与陷阱见 fetchers/nyfedRstar 的文件头 —— 尤其「r* 是 L 不是减数」那条。
  const rstarP = fetchHlwRstar(HISTORY_START_DATE).catch(() => null);
  // ACM 期限溢价(纽约联储,**月频**)。给同格的 Kim-Wright 当独立对照 —— 两条的间距才是产品。
  // 源是个无文档端点(图表取数用),挂了就归 unavailable:少一条对照线,主线照画。见 fetchers/nyfedAcm。
  const acmP = fetchAcmTermPremium(HISTORY_START_DATE).catch(() => null);
  // 核心 CPI / PCE 指数 + 各自的例行发布日。指数多拉一年给同比垫对照期;任一腿失败整组归 unavailable。
  const yearBeforeStart = `${Number(HISTORY_START_DATE.slice(0, 4)) - 1}${HISTORY_START_DATE.slice(4)}`;
  const coreInflP = Promise.all(
    ['CPILFESL', 'PCEPILFE'].map((id) =>
      Promise.all([fred.fetchSeries(id, yearBeforeStart), fred.fetchFirstReleaseDates(id, HISTORY_START_DATE)]).catch(
        () => null,
      ),
    ),
  );
  // 油品近月期货(Yahoo 连续近月,自带全历史,live 不落库)。派生油市结构 + 汽油 YoY。
  const yahooClose = (sym: string): Promise<Point[] | null> =>
    createYahooFetcher()
      .fetchDailyBars(sym, new Date(HISTORY_START_DATE))
      .then((bars) => bars.map((b) => ({ date: b.tradeDate, value: b.close })))
      .catch(() => null);
  // 各标的已 catch→null,Promise.all 不会拒绝;先建后 await(与其它源同批),
  // 别在 allSettled(src) 挂处理器前 await——否则 src 源在此窗口拒绝会成 unhandled。
  const oilP = Promise.all(['CL=F', 'BZ=F', 'HO=F', 'RB=F'].map(yahooClose));
  // 霍尔木兹海峡每日过船数(IMF PortWatch,2019 起全历史一次拉全,约滞后 5 天)。不落库。
  const hormuzP = fetchHormuzTransits().catch(() => null);
  // EIA 周报(周三 10:30 ET 发,数据截止上周五)。全都不落库:一次 GET 给全量历史,
  // 修订(下周会改上周值)因此自然带回来,不必攒增量。各自 catch→null,挂了只丢那一格。
  //
  // **这一条 catch 会出声,同文件另外那些不会** —— 不是随手加的:EIA 的 fetcher 会在
  // 「源给了行但一行都解析不出来」时抛错(见 fetchers/eia),那是**源还活着但响应结构变了**,
  // 与网络挂掉是两回事,且只能靠改代码修。静默吞掉的话两者都只表现为那格 unavailable,查不出区别。
  // 其余源的失败是网络/源侧不可用,unavailable 本身已经说明问题,不必再刷日志。
  const eiaKey = process.env.EIA_API_KEY ?? '';
  const eia = createEiaFetcher({ apiKey: eiaKey });
  // 没 key 就别发这十个请求 —— 每个都会往回抛同一句「缺 key」,徒增十次往返和十行日志。
  // 那不是失败,是没配;下面 hasEiaKey 也据此把 EIA 那 14 条(见 EIA_SERIES)从缓存条件里豁免。
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
      // 表观需求(product supplied = 产量 + 进口 − 出口 − 库存变动,EIA 的需求代理)千桶/日,与实物六条同批周三发
      'WDIUPUS2', // 馏分油
      'WGFUPUS2', // 汽油(成品车用汽油)
    ].map(eiaWeekly),
  );
  // 记每个源从发起到 settle 的耗时,冷拉结束打一行,方便定位拖慢冷启动的源。
  // 必须在第一个 await 之前挂上:此前全是同步发起,没有源来得及 settle,计时才准。
  // then(rec, rec) 而不是 finally:finally 派生的新 promise 会把拒绝原样传下去,没人接就成 unhandled。
  const timings: [string, number][] = [];
  const pending: Record<string, Promise<unknown>> = {
    ...src,
    dxy: usdBarsP,
    spxCap: spxCapP,
    spxEqw: spxEqwP,
    usdjpy: usdjpyBarsP,
    jgbCurve: jgbCurveP,
    ust: ustP,
    jgbVix: jgbVixP,
    cftcJpy: cftcJpyP,
    mofFlows: mofFlowsP,
    margin: marginP,
    jpMargin: jpMarginP,
    vixCot: vixCotP,
    bojGap: bojGapP,
    nakajima: nakajimaP,
    bojBank: bojBankP,
    cgpi: cgpiP,
    tankan: tankanP,
    coreCoreCpi: coreCoreCpiP,
    mufg: mufgBarsP,
    cape: capeP,
    rstar: rstarP,
    acm: acmP,
    coreInfl: coreInflP,
    oil: oilP,
    eia: eiaP,
    hormuz: hormuzP,
  };
  Object.entries(pending).forEach(([name, p]) => {
    const rec = () => timings.push([name, performance.now() - t0]);
    p.then(rec, rec);
  });

  const settled = await Promise.allSettled(Object.values(src));
  const raw: Partial<Record<keyof typeof src, Point[]>> = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw[names[i]] = s.value;
  });
  const usdBars = await usdBarsP;
  const [spxCap, spxEqw] = await Promise.all([spxCapP, spxEqwP]);
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
  const [bojBank, mufgBars, cgpi, coreCoreCpi] = await Promise.all([bojBankP, mufgBarsP, cgpiP, coreCoreCpiP]);
  const [wti, brent, diesel, rbob] = await oilP;
  const tankan = await tankanP;
  const hormuz = await hormuzP;
  const mofFlows = await mofFlowsP;
  const margin = await marginP;
  const jpMargin = await jpMarginP;
  const [coreCpi, corePce] = await coreInflP;
  const [
    refUtil,
    distStocks,
    gasStocks,
    distExports,
    crudeRuns,
    distProd,
    dieselRetail,
    gasRetail,
    distDemand,
    gasDemand,
  ] = await eiaP;
  const jgb2y = jgbCurve?.series['2Y'] ?? null;
  const jgb10y = jgbCurve?.series['10Y'] ?? null;
  const dgs10 = ust?.['10Y'] ?? null;
  const dgs2 = ust?.['2Y'] ?? null; // 美日 2Y 利差的日腿

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  let secLag: SecLag[] = [];
  let secTrim: FundTrim[] = [];
  let secFiled: Record<string, SecFiled> = {};

  // 有值 → 落对外序列;否则记入 unavailable。收敛 5 处「存在性分支」,读时一目了然。
  // ⚠️ 判的是 **length 不是真值**:`[]` 在 JS 里是真的,而「源返回 200 但内容为空」
  // (CBOE 只回表头 / 解析全失败 / inner join 零重叠)必须归 unavailable —— 否则那格既不进
  // 缺失提示,面板还要拿空序列去算分位。放在这里判,调用方就不必人人记得自己 guard 一遍。
  const put = (name: SeriesKey, value: Point[] | undefined) => {
    if (value?.length) series[name] = value;
    else unavailable.push(name);
  };

  // 多拉的对照期(季节 z 的基准年、同比的前一年)不画到图上:别的线都从 HISTORY_START_DATE 起,混着会让 hover 对不上。
  const fromHistoryStart = (rows: Point[]) => rows.filter((p) => p.date >= HISTORY_START_DATE);

  // 直接对外的序列(对外名 → 原始源名)。
  const direct: Partial<Record<RegimeSeries, keyof typeof src>> = {
    cor1m: 'cor1m',
    cor3m: 'cor3m',
    vixeq: 'vixeq',
    fng: 'fng',
    vix6m: 'vix6m',
    reverseRepo: 'rrp',
    repoUsage: 'rpo',
    wages: 'wages',
    stickyCpi: 'stickyCpi',
    t5yifr: 't5yifr',
    tp10Kw: 'tp10Kw',
    sofr: 'sofr',
    fedTargetUpper: 'fedTargetUpper',
    fedTargetLower: 'fedTargetLower',
    sepMedianLr: 'sepMedianLr',
    // 下面几条原本只当派生量的腿在内部用(repoStress / vixSpotTerm / rxmSpx),现在原样发出来:
    // 前端用 ChartDoc 的 calc 现算差 / 比值,注册表下拉只放原始序列(派生的那几条仍照算、照发,见下)
    iorb: 'iorb',
    vix3m: 'vix3m',
    rxm: 'rxm',
    // 现拉的 CBOE VIX(与库里那条 vix 同值,但当天收盘一出就有,不等 daily job):VIX − VIX3M、VIXEQ / VIX
    // 这类与现拉腿内连接的计算要用它,否则 job 没跑时当天那根会被整根丢掉(见上面 src.vixSpot 的注释)
    vixSpot: 'vixSpot',
  };
  // 空数组归 unavailable 由 put 统一兜(见其注释),这里直接传。
  // Object.entries 会把 key 拓宽回 string,这里断言回来 —— 真正的校验发生在上面的对象字面量。
  (Object.entries(direct) as [RegimeSeries, keyof typeof src][]).forEach(([out, s]) => {
    put(out, raw[s!]);
  });

  // 市值 / 等权比值:两腿按日期内连接(同一指数公司、同一交易日历,缺日就跳过,不前向填充)。任一腿缺 → unavailable。
  const eqwAt = new Map((spxEqw ?? []).map((b) => [b.tradeDate, b.close]));
  put(
    'spxEqw',
    (spxCap ?? []).flatMap((b) => {
      const e = eqwAt.get(b.tradeDate);
      return e ? [{ date: b.tradeDate, value: b.close / e }] : [];
    }),
  );
  // 两条腿原样发出(前端 calc 现算 spxEqw 的同一个比值;标普 500 统一用这条 2006 起的 Yahoo ^GSPC,
  // 不另发 CBOE 的 SPX —— 同一个指数两个源,下拉里只该有一条)
  put(
    'spx',
    (spxCap ?? []).map((b) => ({ date: b.tradeDate, value: b.close })),
  );
  put(
    'spxew',
    (spxEqw ?? []).map((b) => ({ date: b.tradeDate, value: b.close })),
  );
  // 等权回撤 − 加权回撤:宽度透支的回撤口径(见 eqwDdSpread),与上面的比值同两腿。
  const bars = (b: typeof spxCap) => (b ?? []).map((x) => ({ date: x.tradeDate, value: x.close }));
  put('eqwDdSpread', eqwDdSpread(bars(spxEqw), bars(spxCap))); // 任一腿缺 → 空 → put 归 unavailable
  // 隐含集中度:VIXEQ / VIX。用比值不用差:差值随波动率水位整体缩放(恐慌期 VIX 翻倍,价差跟着翻倍),
  // 比值 ≈ 1/√平均相关性,剥掉了水位。同期内连接,缺日跳过;VIX ≤ 0(坏行)丢点。任一腿缺 → 空 → unavailable。
  const vixAt = new Map((raw.vixSpot ?? []).map((p) => [p.date, p.value]));
  put(
    'vixeqVix',
    (raw.vixeq ?? []).flatMap((p) => {
      const v = vixAt.get(p.date);
      return v && v > 0 ? [{ date: p.date, value: p.value / v }] : [];
    }),
  );
  // DXY:close 进 series(unavailable/存在性),OHLC 进 ohlc(蜡烛)。缺 → 归 unavailable。
  put('usd', usdBars?.length ? usdBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  // 日元 carry 三序列
  put('usdjpy', usdjpyBars?.length ? usdjpyBars.map((b) => ({ date: b.tradeDate, value: b.close })) : undefined);
  put('cftcJpy', cftcJpy?.length ? cftcJpy : undefined);
  // 发 52 周累计(≈ 过去一年的净流向),億円 → 兆円。先累计再裁到展示起点(源 2005 起,2018 的点也有满窗)。
  // 不用短窗:4 周累计在 0 上下来回翻(相邻周同号仅 80~88%),2022 年寿险抛外债 21.7 兆这种结构性反转被周度噪声盖住;
  // 52 周相邻周同号 97~99%,一段段波段就是资金流的 regime
  const flow52w = (k: 'outBonds' | 'outEquity' | 'inEquity' | 'inBonds') =>
    mofFlows &&
    fromHistoryStart(
      rollingMean(
        mofFlows.flatMap((w) => (Number.isFinite(w[k]) ? [{ date: w.date, value: w[k] }] : [])),
        52,
      ).map((p) => ({ date: p.date, value: (p.value * 52) / 1e4 })),
    );
  // 融资余额看同比不看水位:水位随市值一起涨(1997 年 1 千亿 → 2026 年 1.45 万亿)
  put(
    'marginDebtYoy',
    margin
      ? fromHistoryStart(
          monthlyAnnualizedPct(
            margin.map((m) => ({ date: m.date, value: m.debit })),
            12,
          ),
        )
      : undefined,
  );
  // 周频同比比 52 周前同一周。申込日会因假日挪动(周五放假提前到周四、年末记 12-30),所以带 ±3 天容差找最近的一周;
  // 严格同一天的话 2018 起约 6% 的周对不上(449 周缺 27 周),带容差后剩 3 周:黄金周 / 年末偶有整周不发,或去年那周挪得超过 3 天
  put('jpMarginBuyYoy', jpMargin ? fromHistoryStart(yoyPctWeekly(jpMargin, 3)) : undefined);
  put('jpFlowOutBonds', flow52w('outBonds') ?? undefined);
  put('jpFlowOutEquity', flow52w('outEquity') ?? undefined);
  put('jpFlowInEquity', flow52w('inEquity') ?? undefined);
  put('jpFlowInBonds', flow52w('inBonds') ?? undefined);
  // VIX 期货持仓两类(周频,周二持仓 / 周五 15:30 ET 发)
  put('vixCotAm', vixCot?.assetMgr);
  put('vixCotLm', vixCot?.levMoney);
  put('dgs10', dgs10?.length ? dgs10 : undefined); // 10Y 国债(财政部直发,利率波动率 pane)
  // 美日 2Y 利差 = UST2Y − JGB2Y。**有意用并集前向填充**(见 analytics/regime 文件头):两国节假日错开时
  // 休市那边利率确实没变,沿用旧值是对的;交集会删掉约一成真实交易日。代价:MOF 次日早上才发,最新一天常是旧 JGB。
  put('usjp2y', dgs2?.length && jgb2y?.length ? subtractAligned([dgs2, jgb2y]) : undefined);
  // KW 预期腿 = 拟合 10Y − 期限溢价 = 未来 10 年预期短端利率的平均。
  // 用 subtractAt(inner join)而非 subtractAligned:这是同期恒等式,不是水位组合 —— 缺日就该跳过,
  // 不该配出「昨天的拟合收益率 − 今天的溢价」。两腿当前日历一致(见 subtractAt 的注释),
  // 两种写法此刻输出相同;写成 inner join 是为了不把正确性押在那个巧合上。
  // ⚠️ 判的是**派生后**的长度不是输入腿:inner join 零重叠就返回 [],空数组在 JS 里是真值,
  // 直接 put 会落成 `series.expShort10Kw = []` —— 既不进 unavailable,面板还要拿空序列去算分位。
  put('expShort10Kw', subtractAt(raw.kwFitted10 ?? [], raw.tp10Kw ?? []));
  put('jgb2y', jgb2y?.length ? jgb2y : undefined);
  put('jgb10y', jgb10y?.length ? jgb10y : undefined);
  // 单源降级:历史沿用上一份、新点用活着的源补(见 resolveJgbVix);不算完整,见下面 complete
  const jgb = resolveJgbVix(jgbVix, prev?.body.series.jgbVix);
  put('jgbVix', jgb.points?.length ? jgb.points : undefined);
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
  // 日本银行业:存款 / 贷款 / 拆借(月频)+ 贝塔与两条利差。三个请求任一失败整组归 unavailable ——
  // 派生量都要跨腿,缺一腿就出不来,各自降级没有意义。
  const [bojDep, bojLoan, bojCall] = bojBank ?? [];
  const jpDeposit = bojDep?.DLDR121N;
  const jpCallDaily = bojCall?.STRDCLUCON;
  const jpCall = jpCallDaily && monthlyMean(jpCallDaily);
  const jpLoanStock = bojLoan?.DLLR2CIDBST1;
  const jpSpreads =
    jpDeposit && jpLoanStock && jpCallDaily && jgb2y
      ? jpBankSpreads({ deposit: jpDeposit, loanStock: jpLoanStock, jgb2y, callDaily: jpCallDaily })
      : undefined;
  const jpBeta = jpDeposit && jpCall ? betaLegs(jpDeposit, jpCall) : undefined;
  put('jpDepositRate', jpDeposit);
  put('jpLoanRateStock', jpLoanStock);
  put('jpCallRate', jpCall);
  put('jpDepositBeta', jpDeposit && jpCall ? depositBeta(jpDeposit, jpCall) : undefined);
  put('jpDepositDelta', jpBeta?.depositDelta);
  put('jpCallDelta60', jpBeta?.callDelta60);
  put('jpLoanDepositSpread', jpSpreads?.loanDeposit);
  put('jp2yMinusDeposit', jpSpreads?.jgb2yDeposit);
  put('jpCallMinusDeposit', jpSpreads?.callDeposit);
  put('jp2yMinusCall', jpSpreads?.jgb2yCall);
  put('bojHikeDates', [...BOJ_HIKES]);
  // 企业物价同比(对照月精确命中,不往前贴 —— 见 monthlyAnnualizedPct)。指数最新月可能是 null,解析时已跳过。
  put('jpCgpiYoy', cgpi ? fromHistoryStart(monthlyAnnualizedPct(cgpi.PRCG20_2200000000, 12)) : undefined);
  put('jpCoreCoreCpiYoy', coreCoreCpi ?? undefined);
  put('jpInflExp1y', tankan?.[TANKAN_INFL_EXP[0]]);
  put('jpInflExp5y', tankan?.[TANKAN_INFL_EXP[1]]);
  put(
    'mufg',
    mufgBars?.map((b) => ({ date: b.tradeDate, value: b.close })),
  );
  // ⚠️ 字段名带 `Current`:将来接 real-time 那套会撞名,且**现在就有人会误读** ——
  // current 的历史值是今天用全部数据回头重画的,不是当时看得到的值(前视偏差)。
  put('rstarHlwCurrent', rstar?.length ? rstar : undefined);
  put('tp10Acm', acm ?? undefined);
  // 联储自己定价的 r*:长期名义中性利率 − 2% 通胀目标,与 HLW 同为实际口径才能并排。
  // 取整到 0.01:SEP 本身只给到 0.1,不取整会冒出 1.1000000000000001 这种浮点尾巴。
  put(
    'rstarSepImplied',
    raw.sepMedianLr?.map((p) => ({ date: p.date, value: Math.round((p.value - 2) * 100) / 100 })),
  );
  // 点阵图:日期改记为预测年的年底,和 OIS 远期落在同一条日期轴上才能比。
  put(
    'sepMedian',
    raw.sepMedian?.map((p) => ({ date: `${p.date.slice(0, 4)}-12-31`, value: p.value })),
  );
  // 核心通胀:同比 + 3 个月年化(日期 = 所属月份),外加例行发布日标记(日期 = 发布日)。
  // 标记的值取当前修订后的同比,不是首发值 —— 我们只要发布日来对齐日线断点,不做意外差。
  const inflation = (leg: typeof coreCpi) => {
    if (!leg) return { yoy: undefined, ann3m: undefined, releases: undefined };

    const [index, releases] = leg;
    const pts = index.map((r) => ({ date: r.obsDate, value: r.value }));
    const yoy = fromHistoryStart(monthlyAnnualizedPct(pts, 12));

    return { yoy, ann3m: fromHistoryStart(monthlyAnnualizedPct(pts, 3)), releases: releaseMarkers(releases, yoy) };
  };
  const cpi = inflation(coreCpi);
  const pce = inflation(corePce);
  put('coreCpiYoy', cpi.yoy);
  put('coreCpi3m', cpi.ann3m);
  put('coreCpiRelease', cpi.releases);
  put('corePceYoy', pce.yoy);
  put('corePce3m', pce.ann3m);
  put('corePceRelease', pce.releases);
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
  // 收盘进 series 的那几条,整根日 K 同键进 ohlc(前端画蜡烛用)。表的键 = REGIME_OHLC_KEYS,漏一条编译报错
  const ohlcBars: Record<RegimeOhlcKey, typeof usdBars> = { usd: usdBars, mufg: mufgBars };
  Object.entries(ohlcBars).forEach(([key, b]) => {
    if (b?.length) ohlc[key] = toOhlc(b.map((x) => ({ ...x, date: x.tradeDate })));
  });

  // 派生:分量齐才算,缺则整条进 unavailable。净流动性只出周三点、RRP 单位换算,均见 netLiquidityWeekly。
  put(
    'netLiquidity',
    raw.walcl && raw.wdtgal && raw.rrp ? netLiquidityWeekly(raw.walcl, raw.wdtgal, raw.rrp) : undefined,
  );
  // 对外统一十亿美元:百万美元的七位数在价格轴上读不出来,且与逆回购同单位才能直接比。
  put('reserves', raw.reserves && scale(raw.reserves, 0.001));
  // 交集相减,锚在 SOFR 的营业日:IORB 是 FRED「Daily, 7-Day」—— 连周末都有,还会提前挂出未来几天
  // (2026-10-24 已挂到 10-26)。并集前向填充会造出约 550 个周末点 + 未来日期点(都用旧 SOFR),
  // 塞进时间轴还把周五的值在分位里算三遍。IORB 天天有值,交集即 SOFR 的日期,不丢真实观测。
  put('repoStress', raw.iorb && raw.sofr ? subtractAt(raw.iorb, raw.sofr) : undefined);
  // 隐含相关性期限结构 COR3M − COR1M(百分点):同源,日历偶有不齐(2018 起 4 天只有 1M),内连接、缺日跳过,不前向填充。任一腿缺 → 空 → unavailable。
  put('corTermSpread', subtractAt(raw.cor3m ?? [], raw.cor1m ?? []));
  // RXM(Cboe 风险逆转指数:买 25Δ call / 卖 25Δ put 滚动策略)/ SPX:该策略相对 SPX 的累计表现比。
  put('rxmSpx', raw.rxm && raw.spx ? divideAligned(raw.rxm, raw.spx) : undefined);

  // 油市结构(物理紧张):Brent−WTI 海运 vs 内陆;柴油裂解 = ULSD×42 − WTI(HO 单位 $/gal→$/bbl)。
  // 交集相减(同裂解,见 oilCracks):Brent 在 2023-11-23 感恩节有行、WTI 无,前向填充会造假点
  put('brentWti', brent && wti ? subtractAt(brent, wti) : undefined);
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
  // 另外三条油品期货腿原样发出(Brent − WTI、汽油零售加价改由前端 calc 现算;单位:原油 $/桶、RBOB $/gal)
  put('wti', wti ?? undefined);
  put('brent', brent ?? undefined);
  put('rbob', rbob ?? undefined);
  // 换月错配日(0 / 1,画背景色带):到期日按 WTI 自己的交易日推,两种错配都只由 WTI 到期日决定
  const roll = wti && rollMismatchFlags(wti.map((p) => p.date));
  put('oilRollCrack', roll?.crack);
  put('oilRollBrentWti', roll?.brentWti);
  // 单日艘数小、噪声大(危机期 0~8 艘来回跳),发 7 日均。源连续每日(含周末),按点数取窗即按天。
  // ponytail: 不校验日期连续(2019 起实测一天不缺);源若冒出缺日,只是那几点的窗口跨过 7 天以上、平滑变宽,不会画错值
  const hormuz7d = (k: 'total' | 'tanker') =>
    hormuz &&
    rollingMean(
      hormuz.map((d) => ({ date: d.date, value: d[k] })),
      7,
    );
  put('hormuzTransits', hormuz7d('total') ?? undefined);
  put('hormuzTankers', hormuz7d('tanker') ?? undefined);

  // EIA 周报八条实物原始序列 → 十条对外线。**水位只发炼厂开工率** —— 它是有绝对刻度的(口播的"98%"就是它,
  // 且 100% 是硬顶,一眼看得出还剩多少余量)。库存/出口的裸水位单看不携带信息
  // (1.05 亿桶是高是低取决于现在是 3 月还是 9 月),所以库存两条与出口只发季节 z。
  // EIA 多拉的那几年历史(展示起点再往前垫 SEASONAL_BASELINE_YEARS 年,约 2013 起)是**给季节 z 当基准期用的**,不该画到图上(别的线都从 2018 起,
  // 混在一起会让 hover 对不上)。所以先算 z 再裁 —— 顺序反了就等于把基准期一起砍掉。
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
  put('crudeRunsYoy', crudeRuns ? fromHistoryStart(yoyPctWeekly(crudeRuns)) : undefined);
  put('distProdYoy', distProd ? fromHistoryStart(yoyPctWeekly(distProd)) : undefined);
  // 表观需求只发 4 周均同比(EIA 周报自己的头条口径):单周噪声大(周变化中位数:馏分油约 7.7%、汽油约 2.9%),
  // 水位又带强季节(汽油夏高冬低),单看答不了「需求比去年强还是弱」。
  const demandYoy = (rows: Point[] | null) => (rows ? fromHistoryStart(yoyPctWeekly(rollingMean(rows, 4))) : undefined);
  put('distDemandYoy', demandYoy(distDemand));
  put('gasDemandYoy', demandYoy(gasDemand));
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

  const { sofrLive, fallback: sofrFallback } = resolveSofr(raw.sofr, prev?.sofrLive);

  // VIX / VXN 已在库里(market_series,daily job 维护)→ 直接读,不外拉。
  const db = openDb();
  try {
    const dbBacked = readDbBacked(db, raw.move ?? [], sofrLive, raw.hyOas ?? []);
    Object.assign(series, dbBacked.series);
    Object.assign(ohlc, dbBacked.ohlc);
    unavailable.push(...dbBacked.unavailable);

    const spotTerm = nearMinusFar({ near: raw.vixSpot ?? [], far: raw.vix3m ?? [] });
    put('vixSpotTerm', spotTerm.length ? spotTerm : undefined);

    const sec = readSecSeries(db);
    // 基本面是按名单派生的动态键(fund:NVDA:fcf / fund:buyerFcf),枚举不了,由 FundSeries 覆盖。
    (Object.entries(sec.series) as [FundSeries, Point[]][]).forEach(([out, rows]) => {
      put(out, rows);
    });
    unavailable.push(...sec.unavailable);
    secLag = sec.lag;
    secTrim = sec.trims;
    secFiled = getSecLatestFiled(db);
  } finally {
    db.close();
  }

  const fresh: RegimeBody = { series, unavailable, ohlc, secLag, secTrim, secFiled };
  // 全成功才算 complete(降级结果只短暂缓存、不落盘,见 swrCache)。例外:SEC 那几条是季频、GPU 那几条(gpu 前缀)
  // 是新接的 experimental 源(B300 允许缺、库还没跑过 job 时四条都缺)—— 两者都靠独立 job 逐日/逐季攒,
  // 从没跑过 job 的库里必然缺——不能让这类常态把整条路由的缓存永久关掉。
  // 没配 key 时 EIA 那 14 条恒缺 —— 与 SEC/GPU 同属「必然缺」,不能让它把缓存永久关掉。
  // 配了 key 才缺则是真失败(网络/源结构变了),照旧挡住缓存等下次重试。
  const complete =
    shouldCache(unavailable, { hasEiaKey: Boolean(eiaKey), hasEstatKey: Boolean(estatKey) }) && !jgbVix?.degraded;
  const filled = complete ? fresh : fillFromPrev(fresh, prev?.body);
  // 加息次数是库读派生量、不经 fillFromPrev,但基准沿用了上一份 SOFR → 同样标「沿用上次」。
  // JGB VIX 单源降级时历史沿用了上一份,同样标「沿用上次」
  const extraFallback = [...sofrFallback, ...(jgb.usedPrev ? ['jgbVix'] : [])];
  const body = extraFallback.length ? { ...filled, fallback: [...(filled.fallback ?? []), ...extraFallback] } : filled;

  // 全部源都打(按耗时降序),一行:定位慢源要看到每一个,不只最慢几个。
  const bySlowest = timings.sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`);
  console.log(`[regime] 现拉 ${((performance.now() - t0) / 1000).toFixed(1)}s;各源耗时:${bySlowest.join(', ')}`);
  return { value: { body, moveLive: raw.move ?? [], sofrLive, hyOasLive: raw.hyOas ?? [] }, complete };
}
