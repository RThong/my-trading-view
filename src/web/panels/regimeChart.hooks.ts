// 宏观 regime 视角的数据层:取数 + 各维度的 pane 配置 + spec 构造。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../lib/chart';
import { percentile, percentileRank } from '../../shared/stats';
import type { Interval } from '../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, CandleSpec, Spec } from './assetChart.hooks';

// 分位带阈值(自身历史):想改 5/95 更严就动这里。
const PCTL_LO = 5;
const PCTL_HI = 95;
// 极端期背景带的半透明色:风险端红、机会端绿(方向由各序列 riskTail 决定)。
const BG_RED = 'rgba(239,68,68,0.45)';
const BG_GREEN = 'rgba(34,197,94,0.45)';
const BG_NONE = 'rgba(0,0,0,0)';
// 符号柱状图(期限结构):正=backwardation 绿、负=contango 红。
const SIGNED_UP = '#22c55e';
const SIGNED_DOWN = '#ef4444';

export type RegimePoint = { date: string; value: number };
export type RegimeData = { series: Record<string, RegimePoint[]>; unavailable: string[]; ohlc?: Record<string, Bar[]> };

const NO_DATA: RegimeData = { series: {}, unavailable: [] }; // 稳定空引用,避免 render 抖动
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** 三个 regime 视角共用;SWR 按 URL 去重,只发一次 /api/regime。 */
export function useRegimeData() {
  const { data = NO_DATA, error, isLoading } = useSWR('/api/regime', getJson<RegimeData>, SWR_OPTS);
  return { data, error: error as Error | undefined, isLoading };
}

export type RegimeDim = 'credit' | 'liquidity' | 'sentiment' | 'macro' | 'vol' | 'ratesVol' | 'inflSource' | 'jpy' | 'jgbVol' | 'valuation' | 'oil';

type DimConfig = {
  paneDefs: PaneDef[];               // 一序列一 pane;key = series key
  seriesName: Record<string, string>;
  colors: Record<string, string>;
  baseline?: Record<string, number>; // 会穿零的序列画 0 基线(如回购压力)
  percentiles?: boolean;             // 该维度画 P5/P95 分位带 + 显示当前分位徽标(目前仅情绪)
  riskTail?: Record<string, 'low' | 'high'>; // 哪一端是"风险"(红),另一端为"机会"(绿)
  signed?: string[];                 // 这些序列画符号柱状图(正绿负红,0 基线),不套分位带/徽标(如期限结构)
  candle?: string[];                 // 这些序列画蜡烛(需 data.ohlc 提供 OHLC,如 DXY),不套分位/背景带
  pctlSince?: Record<string, string>; // 分位只用该 ISO 日期起的子窗口算(线仍画全部);如 CAPE:图看长历史,但百分位只近年才有说服力
  bands?: Record<string, { lo: number; hi: number }>; // 固定常态带(基本面锚,替代 P5/P95):画上下参考线。出带=异常/告警,非确诊
  desc?: Record<string, string>;     // 每 pane 的指标说明(hover ⓘ 显示);写谦虚版读法,别下强因果结论
};

export const REGIME_DIMS: Record<RegimeDim, DimConfig> = {
  credit: {
    paneDefs: [{ key: 'hyOas', label: '信用利差', series: ['hyOas'] }],
    seriesName: { hyOas: 'HY 信用利差' },
    colors: { hyOas: '#f59e0b' },
    desc: {
      hyOas: '定义:高收益债 vs 美债利差(OAS)。\n信用风险 / 融资环境的温度计。\n走阔 = 违约担忧升、钱变贵、risk-off;收窄 = 信用宽松、risk-on。',
    },
  },
  liquidity: {
    paneDefs: [
      { key: 'netLiquidity', label: '净流动性', series: ['netLiquidity'] },
      { key: 'reverseRepo', label: '逆回购', series: ['reverseRepo'] },
      { key: 'repoUsage', label: '回购用量', series: ['repoUsage'] },
      { key: 'repoStress', label: '回购压力', series: ['repoStress'] },
    ],
    seriesName: {
      netLiquidity: '净流动性 (WALCL−TGA−RRP)', reverseRepo: '逆回购 RRP',
      repoUsage: '回购用量 SRF', repoStress: '回购压力 (IORB−SOFR)',
    },
    colors: { netLiquidity: '#22c55e', reverseRepo: '#14b8a6', repoUsage: '#ec4899', repoStress: '#a855f7' },
    baseline: { repoStress: 0 },
    desc: {
      netLiquidity: '定义:美联储净流动性 = 总资产 WALCL − 财政部账户 TGA − 逆回购 RRP。\n真正流到市场的美元量。\n升 = 宽松(利多风险资产);降 = 收紧。粗略代理,非因果。',
      reverseRepo: '定义:货币基金等把现金隔夜停在美联储的量(ON RRP)。\n过剩流动性的蓄水池。\n快速抽干 = 流动性被吸走(常伴 TGA 重建 / QT)。',
      repoUsage: '定义:美联储常备回购便利(SRF)动用量。\n平时为 0;一旦有量 = 回购市场缺钱来借,短端压力信号。',
      repoStress: '定义:准备金利率 IORB − 实际隔夜利率 SOFR。\n回购市场松紧。\n正常为正且平稳;收窄 / 转负 = 准备金变稀缺、回购承压(2019 钱荒)。',
    },
  },
  vol: {
    paneDefs: [
      { key: 'vix', label: 'VIX', series: ['vix'] },
      { key: 'vxn', label: 'VXN', series: ['vxn'] },
      { key: 'vixeq', label: 'VIXEQ', series: ['vixeq'] },
      { key: 'vxTerm', label: 'VX1−V3', series: ['vxTermSpread'] },
    ],
    seriesName: { vix: 'VIX', vxn: 'VXN (纳指波动率)', vixeq: '成分股波动率 VIXEQ', vxTermSpread: 'VX1−V3 期限结构' },
    colors: { vix: '#eab308', vxn: '#f97316', vixeq: '#ec4899' },
    percentiles: true,
    // 波动率类一律 低=压扁=自满=风险(逆向,恐慌飙高=机会)。
    riskTail: { vix: 'low', vxn: 'low', vixeq: 'low' },
    signed: ['vxTermSpread'], // 期限结构:符号柱状图,不套分位带
    desc: {
      vix: '定义:标普 500 隐含波动率(未来 30 天)。\n股市恐慌 / 自满。\n飙高 = 恐慌(常是机会);极低 = 压扁自满(风险端,红)。',
      vxn: '定义:纳指 100 隐含波动率(VXN)。\n科技股版 VIX,通常更高。低 = 自满。',
      vixeq: '定义:标普成分股平均单股波动率(VIXEQ)。\n配 VIX / COR1M 看指数波动 vs 个股波动。低 = 自满。',
      vxTerm: '定义:VIX 期货近月 − 三月。\n期限结构(柱子绿正红负,仅表符号)。\n红 / 负(contango,近低远高)= 常态;绿 / 正(backwardation,近端翘高)= 近端恐慌 / 应激。',
    },
  },
  sentiment: {
    paneDefs: [
      { key: 'fng', label: 'Fear&Greed', series: ['fng'] },
      { key: 'cor1m', label: 'COR1M', series: ['cor1m'] },
      { key: 'rxmSpx', label: 'RXM/SPX', series: ['rxmSpx'] },
    ],
    seriesName: { fng: 'Fear & Greed', cor1m: '隐含相关性 COR1M', rxmSpx: 'RXM/SPX 期权情绪' },
    colors: { fng: '#3b82f6', cor1m: '#22c55e', rxmSpx: '#a855f7' },
    percentiles: true,
    // F&G 高=贪婪=风险;COR1M 低=自满=风险;RXM/SPX 低=melt-up/晚周期=风险。
    riskTail: { fng: 'high', cor1m: 'low', rxmSpx: 'low' },
    desc: {
      fng: '定义:CNN Fear & Greed 综合情绪(0-100)。\n高 = 贪婪(风险端,红);低 = 恐惧(常是机会)。多因子合成,粗略。',
      cor1m: '定义:标普隐含相关性(COR1M)。\n成分股齐动程度。低 = 个股分化 / 自满(风险端);高 = 齐跌 / 系统性恐慌。',
      rxmSpx: '定义:CBOE PutWrite 指数 RXM / SPX 比值。\n期权卖方情绪 / 周期成熟度。低 = melt-up / 晚周期 / 自满(风险端)。',
    },
  },
  macro: {
    paneDefs: [{ key: 'usd', label: '美元 DXY', series: ['usd'] }],
    seriesName: { usd: '美元指数 DXY' },
    colors: { usd: '#38bdf8' },
    candle: ['usd'], // DXY 画蜡烛(用 data.ohlc.usd)
    desc: {
      usd: '定义:美元指数 DXY(对一篮子货币),蜡烛图。\n全球美元强弱 / 流动性。\n走强 = 压新兴市场 / 商品 / 风险资产;走弱 = 宽松。源:Yahoo DX-Y.NYB。',
    },
  },
  // 日元 carry:价格(USD/JPY)+ 收益驱动(美日2Y利差)+ 拥挤度(CFTC 净持仓)。
  jpy: {
    paneDefs: [
      { key: 'usdjpy', label: 'USD/JPY', series: ['usdjpy'] },
      { key: 'usjp2y', label: '美日2Y利差', series: ['usjp2y'] },
      { key: 'cftcJpy', label: 'CFTC 净持仓', series: ['cftcJpy'] },
    ],
    seriesName: { usdjpy: 'USD/JPY', usjp2y: '美日 2Y 利差 (DGS2−JGB2Y)', cftcJpy: 'CFTC 日元净持仓 (多−空)' },
    colors: { usdjpy: '#3987e5', usjp2y: '#c98500' },
    signed: ['cftcJpy'], // 净持仓符号柱:净多绿、净空红、0 基线(拥挤度)
    desc: {
      usdjpy: '定义:美元兑日元汇率。\n日元套息(carry)的价格腿。走高(日元贬)= carry 顺风 / risk-on;急跌 = carry 平仓 / 避险。',
      usjp2y: '定义:美日 2 年期利差(DGS2 − JGB2Y)。\ncarry 的收益驱动。走阔 = 借日元买美元更划算 = 支撑 USD/JPY。',
      cftcJpy: '定义:CFTC 投机盘日元净持仓(多 − 空)。\n拥挤度。极端净空 = 大家都空日元 = 一旦反转平仓凶。绿净多、红净空。',
    },
  },
  // 利率水平 + 利率波动率:MOVE 是债市波动率,与利率同宗(和股市 VIX 相关性一般),故与 10Y 收益率配对。
  ratesVol: {
    paneDefs: [
      { key: 'dgs10', label: '10Y 国债', series: ['dgs10'] },
      { key: 'move', label: 'MOVE', series: ['move'] },
    ],
    seriesName: { dgs10: '10Y 国债收益率', move: 'MOVE (债市波动率)' },
    colors: { dgs10: '#22d3ee', move: '#f43f5e' },
    percentiles: true,
    riskTail: { move: 'low' }, // MOVE 压扁=自满=风险;10Y 收益率方向不单一,不设风险端
    desc: {
      dgs10: '定义:美国 10 年期国债收益率。\n长端利率锚。方向不单一(增长 or 通胀 / 供给都能推),故不设风险端,只给 P5/P95 参考。',
      move: '定义:美债期权隐含波动率(MOVE),债市版 VIX。\n利率市场不确定性。低 = 自满(风险端,红);飙高 = 利率动荡。',
    },
  },
  // 通胀来源(供给侧):薪资增速 + 服务黏性 + 汽油同比。与 BEI(市场前瞻预期)并读。高=通胀压力=风险。
  // RBOB YoY:CPI 汽油分项的高频前瞻(汽油是 headline CPI 波动最大的分项),领先约 0-1 月。
  inflSource: {
    paneDefs: [
      { key: 'wages', label: '薪资增速', series: ['wages'] },
      { key: 'stickyCpi', label: '服务黏性', series: ['stickyCpi'] },
      { key: 'rbobYoy', label: '汽油同比', series: ['rbobYoy'] },
    ],
    seriesName: { wages: '薪资增速 (Atlanta Fed)', stickyCpi: 'Sticky CPI (服务黏性)', rbobYoy: 'RBOB 汽油 YoY%' },
    colors: { wages: '#f59e0b', stickyCpi: '#8b5cf6', rbobYoy: '#fb923c' },
    baseline: { rbobYoy: 0 }, // YoY 会穿零
    percentiles: true,
    riskTail: { wages: 'high', stickyCpi: 'high', rbobYoy: 'high' }, // 高=通胀压力=风险(红);低=缓解=绿
    desc: {
      wages: '定义:亚特兰大联储薪资增速 tracker(3mma,%)。\n工资-通胀螺旋的供给侧。高 = 通胀黏、难降(风险端,红)。月频。',
      stickyCpi: '定义:亚特兰大联储 Sticky Price CPI(YoY%)。\n价格黏性大的那半篮子(服务为主),转向慢。高 = 核心通胀顽固(风险端)。月频。',
      rbobYoy: [
        '定义:RBOB 汽油近月期货的同比(YoY%)。',
        '用途:CPI 汽油分项的高频前瞻——汽油是 headline CPI 波动最大的分项,领先约 0-1 月。',
        '只管 headline / 能源,不碰核心 CPI(core)。',
        '高 = 能源在给通胀加压;低于 0 = 拖累。',
      ].join('\n'),
    },
  },
  // 油市结构(物理紧张):Brent−WTI(海运 vs 内陆)+ 柴油裂解(炼厂利润/工业需求)。
  // 长期结构指标:海峡恢复后切回本职——读油市松紧、工业需求强弱。$/桶。
  // 用固定常态带(平静期实测:剔除 2020/2022/2026 三段危机后的取值范围,长周期锚)替代 P5/P95——
  // 后者是自指的(永远 5% 在外)。出带=异常/告警,非确诊;柴油裂解中枢会结构性抬升,需人工重定基。
  oil: {
    paneDefs: [
      { key: 'brentWti', label: 'Brent−WTI', series: ['brentWti'] },
      { key: 'dieselCrack', label: '柴油裂解', series: ['dieselCrack'] },
    ],
    seriesName: { brentWti: 'Brent − WTI ($/桶)', dieselCrack: '柴油裂解 (ULSD×42 − WTI, $/桶)' },
    colors: { brentWti: '#38bdf8', dieselCrack: '#f97316' },
    bands: { brentWti: { lo: 1.5, hi: 10 }, dieselCrack: { lo: 10, hi: 48 } },
    desc: {
      brentWti: [
        '定义:国际海运原油(Brent)− 美国内陆原油(WTI),$/桶。',
        '读法:看「紧张在哪、桶往哪流」。',
        '走阔 = 国际紧 / 美国相对绝缘。',
        '贴 0 或转负 = 美油被跨洋抢,或 Cushing 扭曲。',
        '注意:常被美国出口 / 管输 / 库容主导,别当纯国际风险读。',
        '常态带 1.5~10;出带需配 Cushing 库存 + 月差交叉确认(告警,非确诊)。',
      ].join('\n'),
      dieselCrack: [
        '定义:炼柴油的毛利(ULSD×42 − WTI,$/桶),看下游 / 实体经济。',
        '高 = 产品端比原油紧:需求强 or 炼厂 / 供应紧,单独分不清。',
        '低 = 毛利崩、需求走弱。',
        '常态带 10~48;中枢会结构性抬升(西方炼厂关停 / IMO 2020)。',
        '长期站上带上沿 → 更可能是 regime 变了而非危机,需人工重定基。',
        '用法:配库存 + 月差交叉确认(告警,非确诊)。',
      ].join('\n'),
    },
  },
  // 日债 level + vol:10Y 收益率 + JGB VIX(对称美债 ratesVol 的 10Y+MOVE)。
  jgbVol: {
    paneDefs: [
      { key: 'jgb10y', label: '10Y 国债', series: ['jgb10y'] },
      { key: 'jgbVix', label: 'JGB VIX', series: ['jgbVix'] },
    ],
    seriesName: { jgb10y: 'JGB 10Y 收益率', jgbVix: 'S&P/JPX JGB VIX (日债波动率)' },
    colors: { jgb10y: '#22d3ee', jgbVix: '#f43f5e' },
    percentiles: true,
    riskTail: { jgbVix: 'low' }, // 波动率压扁=自满=风险(同 MOVE);10Y 收益率方向不单一,不设风险端
    desc: {
      jgb10y: '定义:日本 10 年期国债收益率。\nBOJ 政策 / YCC 的长端。方向不单一,只给参考线。',
      jgbVix: '定义:S&P/JPX JGB VIX,日债期权隐含波动率。\n日债不确定性(对称美债 MOVE)。低 = 自满(风险端);飙高 = 日债动荡、或外溢全球利率。',
    },
  },
  // 估值:席勒 CAPE(PE10)。高=贵=未来回报低=风险(红);低=便宜=机会(绿)。
  valuation: {
    paneDefs: [{ key: 'cape', label: '席勒 CAPE', series: ['cape'] }],
    seriesName: { cape: '席勒 CAPE (PE10 周期调整市盈率)' },
    colors: { cape: '#eab308' },
    percentiles: true,
    riskTail: { cape: 'high' },
    // 图看 1990+(含互联网泡沫),但 CAPE 结构性抬升,分位只用 2000+ 才有说服力。
    pctlSince: { cape: '2000-01-01' },
    desc: {
      cape: '定义:席勒 CAPE(周期调整市盈率 PE10)。\n股市长期估值。高 = 贵 = 未来 10 年回报低(风险端,红);低 = 便宜。\n分位只用 2000+ 算(CAPE 结构性抬升,长历史比不公平)。',
    },
  },
};

const toLine = (rows: RegimePoint[]): LinePoint[] => rows.map((r) => ({ time: r.date, value: r.value }));

/** 一序列一 pane:pane 下标 = paneDefs 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。
 *  开启 percentiles 的维度:每序列按原始日频值算 P5/P95 作参考线(与显示 interval 无关)。 */
export function buildRegimeSpecs(data: RegimeData, dim: RegimeDim, interval: Interval): Spec[] {
  const cfg = REGIME_DIMS[dim];
  return cfg.paneDefs.flatMap((def, pane): Spec[] => {
    const key = def.series[0];
    if (data.unavailable.includes(key)) return []; // unavailable 权威:不建 spec

    // 蜡烛:用 ohlc(按 interval 聚合 OHLC),涨绿跌红(addSeries 内置)。不套分位/背景带。
    if (cfg.candle?.includes(key)) {
      const bars = data.ohlc?.[key];
      if (!bars?.length) return [];
      const candle: CandleSpec = { key, pane, kind: 'candle', title: cfg.seriesName[key], data: aggregateBars(bars, interval) };
      return [candle];
    }

    const rows = data.series[key];
    if (!rows) return [];
    const line = aggregate(toLine(rows), interval);

    // 符号柱状图(期限结构):正绿负红、0 基线,不套分位带/徽标。
    if (cfg.signed?.includes(key)) {
      const bars: HistoPoint[] = line.map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? SIGNED_UP : SIGNED_DOWN }));
      const histo: HistoSpec = { key, pane, kind: 'histogram', title: cfg.seriesName[key], data: bars, baseline: 0 };
      return [histo];
    }

    const lineSpec: LineSpec = {
      key, pane, kind: 'line', color: cfg.colors[key], title: cfg.seriesName[key], data: line,
      ...(cfg.baseline?.[key] !== undefined ? { baseline: cfg.baseline[key] } : {}),
    };
    // 固定常态带:画上下参考线(基本面锚,替代自指的 P5/P95;出带=告警非确诊)。
    const band = cfg.bands?.[key];
    if (band) lineSpec.refLines = [
      { price: band.lo, title: '常态下限' },
      { price: band.hi, title: '常态上限' },
    ];

    if (!cfg.percentiles) return [lineSpec];

    // 分位:P5/P95 参考线用原始日频算(与显示 interval 无关);极端期画满高背景带。
    // pctlSince 给了则只用该子窗口算阈值(线仍画全部 rows);阈值再铺回整条线。
    const since = cfg.pctlSince?.[key];
    const vals = (since ? rows.filter((r) => r.date >= since) : rows).map((r) => r.value);
    const lo = percentile(vals, PCTL_LO);
    const hi = percentile(vals, PCTL_HI);
    lineSpec.refLines = [{ price: lo, title: `P${PCTL_LO}` }, { price: hi, title: `P${PCTL_HI}` }];
    const risk = cfg.riskTail?.[key];
    // 背景带 = 风险/机会信号,需已知风险端;无 riskTail 的序列(如 10Y 收益率,高低方向不单一)只留 P5/P95 线,不染背景。
    if (risk === undefined) return [lineSpec];
    // 背景带按原始日频逐日判定极端(不用聚合点),保证与显示 interval 无关。
    const bgData: HistoPoint[] = rows.map((r) => {
      if (r.value < lo) return { time: r.date, value: 1, color: risk === 'low' ? BG_RED : BG_GREEN };
      if (r.value > hi) return { time: r.date, value: 1, color: risk === 'high' ? BG_RED : BG_GREEN };
      return { time: r.date, value: 0, color: BG_NONE };
    });
    const bgSpec: HistoSpec = { key: `${key}-bg`, pane, kind: 'histogram', title: '', data: bgData, priceScaleId: `bg-${key}` };
    return [bgSpec, lineSpec]; // bg 先建 → 画在线的下层
  });
}

/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentiles 维度产出。 */
export function regimePercentiles(data: RegimeData, dim: RegimeDim): Record<string, string> {
  const cfg = REGIME_DIMS[dim];
  if (!cfg.percentiles) return {};

  return Object.fromEntries(
    cfg.paneDefs.flatMap((def) => {
      const key = def.series[0];
      if (cfg.signed?.includes(key)) return []; // 符号柱状图无分位徽标
      if (data.unavailable.includes(key)) return [];
      const rows = data.series[key];
      if (!rows?.length) return [];
      // 徽标 = 最新值在分位窗口内的排名(pctlSince 给了就只对子窗口排,与 buildRegimeSpecs 阈值同源)。
      const since = cfg.pctlSince?.[key];
      const base = since ? rows.filter((r) => r.date >= since) : rows;
      const rank = percentileRank(base.map((r) => r.value), rows[rows.length - 1].value);
      return Number.isNaN(rank) ? [] : [[key, `P${rank}`]];
    }),
  );
}
