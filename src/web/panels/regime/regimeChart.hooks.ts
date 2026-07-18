// 宏观 regime 视角的数据层:取数 + 各维度的 pane 配置 + spec 构造。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../../lib/chart';
import { percentile, percentileRank } from '../../../shared/stats';
import type { Interval } from '../../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, Spec } from '../chart/paneChart.types';

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

export type RegimeDim =
  | 'credit'
  | 'liquidity'
  | 'sentiment'
  | 'macro'
  | 'vol'
  | 'ratesVol'
  | 'inflSource'
  | 'jpy'
  | 'jgbVol'
  | 'valuation'
  | 'oil';

// 每个 pane 自带完整定义:单一 key 既是 pane 身份,也是 data.series[key]/data.ohlc[key] 的数据键。
// 取代原来 ~10 张按同一 key 索引的平行 map(paneDefs/seriesName/colors/baseline/riskTail/
// signed/candle/pctlSince/bands/desc)——避免 key desync 与"signed 却忘配颜色"这类不可表达状态。
type PaneSpec = {
  key: string;
  label: string; // 工具条 chip 名
  title: string; // 图例 / 命名
  color?: string; // 线色 / 图例色;符号柱与部分蜡烛不需要(留空则图例用默认色)
  desc?: string; // hover ⓘ 说明(谦虚版读法)
  render?: // 图形,默认 line
    | { kind: 'line'; baseline?: number } // baseline:会穿零的序列画 0 基线(如回购压力 / YoY)
    | { kind: 'signed' } // 符号柱状图(正绿负红,0 基线),不套分位/徽标
    | { kind: 'candle' }; // 蜡烛(用 data.ohlc[key]),不套分位/背景带
  band?: { lo: number; hi: number }; // 固定常态带 → 上下参考线(基本面锚,替代自指的 P5/P95)
  percentile?: { riskTail?: 'low' | 'high'; since?: string }; // 有=画 P5/P95+徽标;riskTail 决定背景带红/绿方向;since 限定分位窗口
};

type DimConfig = { panes: PaneSpec[] };

export const REGIME_DIMS: Record<RegimeDim, DimConfig> = {
  credit: {
    panes: [
      {
        key: 'hyOas',
        label: '信用利差',
        title: 'HY 信用利差',
        color: '#f59e0b',
        desc: '定义:高收益债 vs 美债利差(OAS)。\n信用风险 / 融资环境的温度计。\n走阔 = 违约担忧升、钱变贵、risk-off;收窄 = 信用宽松、risk-on。',
      },
    ],
  },
  liquidity: {
    panes: [
      {
        key: 'netLiquidity',
        label: '净流动性',
        title: '净流动性 (WALCL−TGA−RRP)',
        color: '#22c55e',
        desc: '定义:美联储资产负债表净流动性(粗略代理)= 总资产 WALCL − 财政部账户 TGA − 逆回购 RRP(三腿已统一到百万美元)。\n升 = 宽松倾向(利多风险资产);降 = 收紧倾向。是启发式代理,非实际流入市场的资金量。',
      },
      {
        key: 'reverseRepo',
        label: '逆回购',
        title: '逆回购 RRP',
        color: '#14b8a6',
        desc: '定义:货币基金等把现金隔夜停在美联储的量(ON RRP)。\n过剩流动性的蓄水池。\nRRP 下降本身 = 这部分资金回流准备金 / 货币市场(是释放);但常与 TGA 重建 / QT 同时发生,后两者才是真正收紧。',
      },
      {
        key: 'repoUsage',
        label: '回购用量',
        title: '回购用量 (隔夜正回购 RPONTSYD)',
        color: '#ec4899',
        desc: '定义:美联储隔夜正回购操作总量(RPONTSYD,含 2021 起的常备回购便利 SRF)。\n平时接近 0;一旦有量 = 回购市场缺钱来借,短端压力信号(如 2019-09 钱荒)。',
      },
      {
        key: 'repoStress',
        label: '回购压力',
        title: '回购压力 (IORB−SOFR)',
        color: '#a855f7',
        render: { kind: 'line', baseline: 0 },
        desc: '定义:准备金利率 IORB − 实际隔夜利率 SOFR。\n回购市场松紧。\n正常为正且平稳;收窄 / 转负 = 准备金变稀缺、回购承压(2019 钱荒)。',
      },
    ],
  },
  vol: {
    panes: [
      {
        key: 'vix',
        label: 'VIX',
        title: 'VIX',
        color: '#eab308',
        percentile: { riskTail: 'low' }, // 波动率低=压扁=自满=风险(逆向,恐慌飙高=机会)
        desc: '定义:标普 500 隐含波动率(未来 30 天)。\n股市恐慌 / 自满。\n飙高 = 恐慌(常是机会);极低 = 压扁自满(风险端,红)。',
      },
      {
        key: 'vxn',
        label: 'VXN',
        title: 'VXN (纳指波动率)',
        color: '#f97316',
        percentile: { riskTail: 'low' },
        desc: '定义:纳指 100 隐含波动率(VXN)。\n科技股版 VIX,通常更高。低 = 自满。',
      },
      {
        key: 'vixeq',
        label: 'VIXEQ',
        title: '成分股波动率 VIXEQ',
        color: '#ec4899',
        percentile: { riskTail: 'low' },
        desc: '定义:标普成分股平均单股波动率(VIXEQ)。\n配 VIX / COR1M 看指数波动 vs 个股波动。低 = 自满。',
      },
      {
        key: 'vxTermSpread',
        label: 'VX1−V3',
        title: 'VX1−V3 期限结构',
        render: { kind: 'signed' }, // 期限结构:符号柱状图,不套分位带
        desc: '定义:VIX 期货近月 − 三月。\n期限结构(柱子绿正红负,仅表符号)。\n红 / 负(contango,近低远高)= 常态;绿 / 正(backwardation,近端翘高)= 近端恐慌 / 应激。',
      },
    ],
  },
  sentiment: {
    panes: [
      {
        key: 'fng',
        label: 'Fear&Greed',
        title: 'Fear & Greed',
        color: '#3b82f6',
        percentile: { riskTail: 'high' }, // 高=贪婪=风险
        desc: '定义:CNN Fear & Greed 综合情绪(0-100)。\n高 = 贪婪(风险端,红);低 = 恐惧(常是机会)。多因子合成,粗略。',
      },
      {
        key: 'cor1m',
        label: 'COR1M',
        title: '隐含相关性 COR1M',
        color: '#22c55e',
        percentile: { riskTail: 'low' }, // 低=分化/自满=风险
        desc: '定义:标普隐含相关性(COR1M)。\n成分股隐含共动程度。高 = 共动更强(常在系统性压力期上升);低 = 隐含分化更强(偏自满,风险端红)。',
      },
      {
        key: 'rxmSpx',
        label: 'RXM/SPX',
        title: 'RXM/SPX (风险逆转相对表现)',
        color: '#a855f7',
        percentile: {}, // 无可靠方向,只给 P5/P95 参考 + 徽标,不染背景带
        desc: '定义:Cboe 风险逆转指数 RXM(买 25Δ call / 卖 25Δ put 滚动策略)/ SPX。\n该期权策略相对 SPX 的累计表现比。\n低 = 策略相对跑输;不宜单独据此断情绪方向,故不染风险背景带。',
      },
    ],
  },
  macro: {
    panes: [
      {
        key: 'usd',
        label: '美元 DXY',
        title: '美元指数 DXY',
        color: '#38bdf8',
        render: { kind: 'candle' }, // DXY 画蜡烛(用 data.ohlc.usd)
        desc: '定义:美元指数 DXY(对一篮子货币),蜡烛图。\n全球美元强弱 / 流动性。\n走强 = 压新兴市场 / 商品 / 风险资产;走弱 = 宽松。源:Yahoo DX-Y.NYB。',
      },
    ],
  },
  // 日元 carry:价格(USD/JPY)+ 收益驱动(美日2Y利差)+ 拥挤度(CFTC 净持仓)。
  jpy: {
    panes: [
      {
        key: 'usdjpy',
        label: 'USD/JPY',
        title: 'USD/JPY',
        color: '#3987e5',
        desc: '定义:美元兑日元汇率。\n日元套息(carry)的价格腿。走高(日元贬)= carry 顺风 / risk-on;急跌 = carry 平仓 / 避险。',
      },
      {
        key: 'usjp2y',
        label: '美日2Y利差',
        title: '美日 2Y 利差 (DGS2−JGB2Y)',
        color: '#c98500',
        desc: '定义:美日 2 年期利差(DGS2 − JGB2Y)。\ncarry 的收益驱动。走阔 = 借日元买美元更划算 = 支撑 USD/JPY。',
      },
      {
        key: 'cftcJpy',
        label: 'CFTC 净持仓',
        title: 'CFTC 日元净持仓 (多−空)',
        render: { kind: 'signed' }, // 净持仓符号柱:净多绿、净空红、0 基线(拥挤度)
        desc: '定义:CFTC 投机盘日元净持仓(多 − 空)。\n拥挤度。极端净空 = 大家都空日元 = 一旦反转平仓凶。绿净多、红净空。',
      },
    ],
  },
  // 利率水平 + 利率波动率:MOVE 是债市波动率,与利率同宗(和股市 VIX 相关性一般),故与 10Y 收益率配对。
  ratesVol: {
    panes: [
      {
        key: 'dgs10',
        label: '10Y 国债',
        title: '10Y 国债收益率',
        color: '#22d3ee',
        percentile: {}, // 方向不单一,不设风险端,只给 P5/P95 参考
        desc: '定义:美国 10 年期国债收益率。\n长端利率锚。方向不单一(增长 or 通胀 / 供给都能推),故不设风险端,只给 P5/P95 参考。',
      },
      {
        key: 'move',
        label: 'MOVE',
        title: 'MOVE (债市波动率)',
        color: '#f43f5e',
        percentile: { riskTail: 'low' }, // MOVE 压扁=自满=风险
        desc: '定义:美债期权隐含波动率(MOVE),债市版 VIX。\n利率市场不确定性。低 = 自满(风险端,红);飙高 = 利率动荡。',
      },
    ],
  },
  // 通胀来源(供给侧):薪资增速 + 服务黏性 + 汽油同比。与 BEI(市场前瞻预期)并读。高=通胀压力=风险。
  // RBOB YoY:CPI 汽油分项的高频前瞻(汽油是 headline CPI 波动最大的分项),领先约 0-1 月。
  inflSource: {
    panes: [
      {
        key: 'wages',
        label: '薪资增速',
        title: '薪资增速 (Atlanta Fed)',
        color: '#f59e0b',
        percentile: { riskTail: 'high' }, // 高=通胀压力=风险(红);低=缓解=绿
        desc: '定义:亚特兰大联储薪资增速 tracker(个人时薪同比的非加权中位数,3 个月移动平均)。\n工资压力 / 劳动力市场紧张度代理(不度量因果螺旋)。高 = 工资涨得快、通胀更黏(风险端,红)。月频。',
      },
      {
        key: 'stickyCpi',
        label: '服务黏性',
        title: 'Sticky CPI (服务黏性)',
        color: '#8b5cf6',
        percentile: { riskTail: 'high' },
        desc: '定义:亚特兰大联储 Core Sticky-Price CPI(剔除食品能源,同比)。\n调价频率低的那部分篮子(服务为主,含部分商品),转向慢。高 = 核心通胀顽固(风险端)。月频。',
      },
      {
        key: 'rbobYoy',
        label: '汽油同比',
        title: 'RBOB 汽油 YoY%',
        color: '#fb923c',
        render: { kind: 'line', baseline: 0 }, // YoY 会穿零
        percentile: { riskTail: 'high' },
        desc: [
          '定义:RBOB 汽油近月期货的同比(YoY%)。',
          '用途:CPI 汽油分项的高频前瞻——汽油是 headline CPI 波动最大的分项,领先约 0-1 月。',
          '只管 headline / 能源,不碰核心 CPI(core)。',
          '高 = 能源在给通胀加压;低于 0 = 拖累。',
        ].join('\n'),
      },
    ],
  },
  // 油市结构(物理紧张):Brent−WTI(海运 vs 内陆)+ 柴油裂解(炼厂利润/工业需求)。
  // 长期结构指标:海峡恢复后切回本职——读油市松紧、工业需求强弱。$/桶。
  // 用固定常态带(平静期实测:剔除 2020/2022/2026 三段危机后的取值范围,长周期锚)替代 P5/P95——
  // 后者是自指的(永远 5% 在外)。出带=异常/告警,非确诊;柴油裂解中枢会结构性抬升,需人工重定基。
  oil: {
    panes: [
      {
        key: 'brentWti',
        label: 'Brent−WTI',
        title: 'Brent − WTI ($/桶)',
        color: '#38bdf8',
        band: { lo: 1.5, hi: 10 },
        desc: [
          '定义:国际海运原油(Brent)− 美国内陆原油(WTI),$/桶。',
          '读法:看「紧张在哪、桶往哪流」。',
          '走阔 = 国际紧 / 美国相对绝缘。',
          '贴 0 或转负 = 美油被跨洋抢,或 Cushing 扭曲。',
          '注意:常被美国出口 / 管输 / 库容主导,别当纯国际风险读。',
          '常态带 1.5~10;出带需配 Cushing 库存 + 月差交叉确认(告警,非确诊)。',
        ].join('\n'),
      },
      {
        key: 'dieselCrack',
        label: '柴油裂解',
        title: '柴油裂解 (ULSD×42 − WTI, $/桶)',
        color: '#f97316',
        band: { lo: 10, hi: 48 },
        desc: [
          '定义:炼柴油的毛利(ULSD×42 − WTI,$/桶),看下游 / 实体经济。',
          '高 = 产品端比原油紧:需求强 or 炼厂 / 供应紧,单独分不清。',
          '低 = 产品端偏松:需求弱 or 炼厂 / 供应宽松、库存高,同样单独分不清。',
          '常态带 10~48;中枢会结构性抬升(西方炼厂关停 / IMO 2020)。',
          '长期站上带上沿 → 更可能是 regime 变了而非危机,需人工重定基。',
          '用法:配库存 + 月差交叉确认(告警,非确诊)。',
        ].join('\n'),
      },
    ],
  },
  // 日债 level + vol:10Y 收益率 + JGB VIX(对称美债 ratesVol 的 10Y+MOVE)。
  jgbVol: {
    panes: [
      {
        key: 'jgb10y',
        label: '10Y 国债',
        title: 'JGB 10Y 收益率',
        color: '#22d3ee',
        percentile: {}, // 方向不单一,不设风险端
        desc: '定义:日本 10 年期国债收益率。\nBOJ 政策 / YCC 的长端。方向不单一,只给参考线。',
      },
      {
        key: 'jgbVix',
        label: 'JGB VIX',
        title: 'S&P/JPX JGB VIX (日债波动率)',
        color: '#f43f5e',
        percentile: { riskTail: 'low' }, // 波动率压扁=自满=风险(同 MOVE)
        desc: '定义:S&P/JPX JGB VIX,日债期权隐含波动率。\n日债不确定性(对称美债 MOVE)。低 = 自满(风险端);飙高 = 日债动荡、或外溢全球利率。',
      },
    ],
  },
  // 估值:席勒 CAPE(PE10)。高=贵=未来回报低=风险(红);低=便宜=机会(绿)。
  valuation: {
    panes: [
      {
        key: 'cape',
        label: '席勒 CAPE',
        title: '席勒 CAPE (PE10 周期调整市盈率)',
        color: '#eab308',
        // 图看 1990+(含互联网泡沫),但 CAPE 结构性抬升,分位只用 2000+ 才有说服力。
        percentile: { riskTail: 'high', since: '2000-01-01' },
        desc: '定义:席勒 CAPE(周期调整市盈率 PE10)。\n股市长期估值。高 = 贵 = 未来 10 年回报低(风险端,红);低 = 便宜。\n分位只用 2000+ 算(CAPE 结构性抬升,长历史比不公平)。',
      },
    ],
  },
};

/** 从 panes[] 派生 PaneChartView 需要的平行 map(pane 定义 / 命名 / 配色 / 说明)。 */
export function derivePaneMeta(panes: PaneSpec[]) {
  return {
    paneDefs: panes.map((p) => ({ key: p.key, label: p.label, series: [p.key] })) as PaneDef[],
    seriesName: Object.fromEntries(panes.map((p) => [p.key, p.title])),
    colors: Object.fromEntries(panes.flatMap((p) => (p.color ? [[p.key, p.color]] : []))),
    desc: Object.fromEntries(panes.flatMap((p) => (p.desc ? [[p.key, p.desc]] : []))),
  };
}

const toLine = (rows: RegimePoint[]): LinePoint[] => rows.map((r) => ({ time: r.date, value: r.value }));

/** 一序列一 pane:pane 下标 = panes 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。
 *  percentile 的 pane:按原始日频值算 P5/P95 作参考线(与显示 interval 无关)。 */
export function buildRegimeSpecs(data: RegimeData, dim: RegimeDim, interval: Interval): Spec[] {
  return REGIME_DIMS[dim].panes.flatMap((p, pane): Spec[] => {
    const key = p.key;
    if (data.unavailable.includes(key)) return []; // unavailable 权威:不建 spec
    const render = p.render ?? { kind: 'line' as const };

    // 蜡烛:用 ohlc(按 interval 聚合 OHLC),涨绿跌红(addSeries 内置)。不套分位/背景带。
    if (render.kind === 'candle') {
      const bars = data.ohlc?.[key];
      if (!bars?.length) return [];
      return [{ key, pane, kind: 'candle', title: p.title, data: aggregateBars(bars, interval) }];
    }

    const rows = data.series[key];
    if (!rows) return [];
    const line = aggregate(toLine(rows), interval);

    // 符号柱状图(期限结构):正绿负红、0 基线,不套分位带/徽标。
    if (render.kind === 'signed') {
      const bars: HistoPoint[] = line.map((pt) => ({
        time: pt.time,
        value: pt.value,
        color: pt.value >= 0 ? SIGNED_UP : SIGNED_DOWN,
      }));
      return [{ key, pane, kind: 'histogram', title: p.title, data: bars, baseline: 0 }];
    }

    const lineSpec: LineSpec = {
      key,
      pane,
      kind: 'line',
      color: p.color ?? '#a3a3a3',
      title: p.title,
      data: line,
      ...(render.baseline !== undefined ? { baseline: render.baseline } : {}),
    };
    // 固定常态带:画上下参考线(基本面锚,替代自指的 P5/P95;出带=告警非确诊)。
    if (p.band)
      lineSpec.refLines = [
        { price: p.band.lo, title: '常态下限' },
        { price: p.band.hi, title: '常态上限' },
      ];

    if (!p.percentile) return [lineSpec];

    // 分位:P5/P95 参考线用原始日频算(与显示 interval 无关);极端期画满高背景带。
    // since 给了则只用该子窗口算阈值(线仍画全部 rows);阈值再铺回整条线。
    const since = p.percentile.since;
    const vals = (since ? rows.filter((r) => r.date >= since) : rows).map((r) => r.value);
    const lo = percentile(vals, PCTL_LO);
    const hi = percentile(vals, PCTL_HI);
    lineSpec.refLines = [
      { price: lo, title: `P${PCTL_LO}` },
      { price: hi, title: `P${PCTL_HI}` },
    ];
    const risk = p.percentile.riskTail;
    // 背景带 = 风险/机会信号,需已知风险端;无 riskTail(如 10Y 收益率,高低方向不单一)只留 P5/P95 线,不染背景。
    if (risk === undefined) return [lineSpec];
    // 背景带按原始日频逐日判定极端(不用聚合点),保证与显示 interval 无关。
    const bgData: HistoPoint[] = rows.map((r) => {
      if (r.value < lo) return { time: r.date, value: 1, color: risk === 'low' ? BG_RED : BG_GREEN };
      if (r.value > hi) return { time: r.date, value: 1, color: risk === 'high' ? BG_RED : BG_GREEN };
      return { time: r.date, value: 0, color: BG_NONE };
    });
    const bgSpec: HistoSpec = {
      key: `${key}-bg`,
      pane,
      kind: 'histogram',
      title: '',
      data: bgData,
      priceScaleId: `bg-${key}`,
    };
    return [bgSpec, lineSpec]; // bg 先建 → 画在线的下层
  });
}

/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentile 的 pane 产出。 */
export function regimePercentiles(data: RegimeData, dim: RegimeDim): Record<string, string> {
  return Object.fromEntries(
    REGIME_DIMS[dim].panes.flatMap((p) => {
      if (!p.percentile) return []; // 无分位 pane(含 signed / candle)无徽标
      if (data.unavailable.includes(p.key)) return [];
      const rows = data.series[p.key];
      if (!rows?.length) return [];
      // 徽标 = 最新值在分位窗口内的排名(since 给了就只对子窗口排,与 buildRegimeSpecs 阈值同源)。
      const since = p.percentile.since;
      const base = since ? rows.filter((r) => r.date >= since) : rows;
      const rank = percentileRank(
        base.map((r) => r.value),
        rows[rows.length - 1].value,
      );
      return Number.isNaN(rank) ? [] : [[p.key, `P${rank}`]];
    }),
  );
}
