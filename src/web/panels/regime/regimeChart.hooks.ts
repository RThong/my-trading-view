// 宏观 regime 视角的数据层:取数 + 各维度的 pane 配置 + spec 构造。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../../lib/chart';
import { percentile, percentileRank } from '../../../shared/stats';
import type { Interval } from '../../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, Spec } from '../chart/paneChart.types';
import {
  SEC_BUYER_FCF_KEY,
  SEC_BUYER_FCFQ_KEY,
  chainTickers,
  isAggregateMember,
  knownGap,
  fundKey,
  sideOf,
  sourcesOf,
  currencyOf,
  hasSource,
  type ChainSource,
  type FundKind,
  type SecLag,
} from '../../../shared/aiChain';

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

// 跨格复用的框架文本:同一判据被多个 desc 引用,抽常量避免改一处漏一处。
// 一律写成条件判据,不写「某年某月读数」——快照会过期,而图上就有当期值。
const FIVE_STEPS =
  '五步观测:① 净流动性转头(预警)→ ② RRP 见底(缓冲耗尽)→ ③ SOFR 破 IORB + ④ repo 冒尖(咬人)→ ⑤ canary 齐跌(系统性)。';
const FICC_TRIANGLE =
  'FICC 低波三角(油价 / 10Y / 美元)之一:三者低波本身 = 资金敢极端集中到核心的安全垫,防线一松传导极快。';
const RESONANCE = '共振清单:低波 + 高 CAPE + RXM/SPX 低 + 流动性 P/Q 收紧,四项同亮 = 降杠杆 / 买保险。';
const SIGMA_ID = '恒等式 σ指数 ≈ σ个股 × √平均相关性 → VIX 恒低于 VIXEQ,缺口 ≈「1 − 相关性」的读数。';
// 「低离散是真分化还是被按住」的交叉清单:VIXEQ 与 COR1M 是同一件事的两种写法,判据同一套。
const BREADTH_CHECK =
  '判别看宽度(RSP/SPY、200 日线上占比)+ 头部权重 + 流动性 P/Q:宽度塌 + 权重高 = 被少数巨头按住,不是健康分化。';
const PINNED_VOL = '⚠️ 央行可信干预会诱使市场做多 gamma、内生压低波动率:这种低波不是真稳,可信度一破反向弹性极大。';
// SEC 基本面各格共用:季频数据的读法约束。写在每格开头,防止被当日频指标使。
const SEC_CAVEAT =
  '\n源:SEC XBRL 财报实际值(非预期、非市场定价)。**季频、滞后 4~8 周、会因重述回改** —— ' +
  '用途是证实/证伪叙事,不是择时;不要用它解释当天的价格。';
// 名单会变,所以只写**口径与条件**,不写「当前接了哪几家」——写状态的文案一定会过期。
// 两侧名单现算,别在文案里写死 —— 名单一改文案就过期。只列因果链内的(备查的那几家不是判据成员)。
const tickersOf = (side: 'buyer' | 'seller') => chainTickers(side).join('/');
const SEC_ROSTER_CAVEAT =
  `AI 链按判据分两侧(见 shared/aiChain 的 side):**买铲子的**(${tickersOf('buyer')} —— 花钱建算力)` +
  `进这条合计线;**卖铲子的**(${tickersOf('seller')} —— 收钱)只看毛利率、**不进**这条线。` +
  '分侧不是分类洁癖:卖方在涨价周期里正 FCF 极大,混进来会把零轴永远垫在下方,判据直接失效。' +
  '线上只汇总「已启用且属买方」的那几家(名单按「逐家核对毛利率后才开」推进),' +
  '故**买方一家都没开时这格是空的** —— 空 = 判据还没有数据,不是「FCF 为零」。';

export type RegimePoint = { date: string; value: number };
export type RegimeData = {
  series: Record<string, RegimePoint[]>;
  unavailable: string[];
  ohlc?: Record<string, Bar[]>;
  secLag?: SecLag[];
};

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
  | 'oil'
  // 基本面按启用名单派生:一家一个 dim(三格),外加一条买方合计。见 dimPanes / companyPanes。
  | `fundamentals:${string}`;

/** 固定维度(配置写死那些);基本面维度是按名单派生的,不进这张表。 */
type FixedDim = Exclude<RegimeDim, `fundamentals:${string}`>;

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

export const REGIME_DIMS: Record<FixedDim, DimConfig> = {
  credit: {
    panes: [
      {
        key: 'hyOas',
        label: '信用利差',
        title: 'HY 信用利差',
        color: '#f59e0b',
        desc: [
          '定义:高收益债 vs 美债利差(OAS)。信用风险 / 融资环境的温度计。',
          '走阔 = 违约担忧升、risk-off;收窄 = 信用宽松、risk-on。',
          '',
          '定位:降级备用指标,排在观测最后一步——canary(BTC / 罗素2000 / ARKK / 恒科)齐裂后再看它,',
          '走阔 = 从「流动性事件」升级成「信用事件」。',
          '⚠️ 低 ≠ 安全:集中度极高时利差被按住(借来的平静),只在走阔时才有信息量。',
          '补:股权也是信用风险——小微盘暴跌 / 丧失流动性 = 其隐含 CDS 成本上涨。',
        ].join('\n'),
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
        desc: [
          '定义:净流动性(粗略代理)= 总资产 WALCL − 财政部账户 TGA − 逆回购 RRP(三腿统一到百万美元)。',
          '升 = 宽松倾向(利多风险资产);降 = 收紧倾向。是启发式代理,非实际流入市场的资金量。',
          '',
          '框架 · 流动性三维(浴缸):P = 水温 = 利率;Q = 水量 = 总量(本指标);G = 池底坡度 = 结构分布。',
          '⚠️ 降息 ≠ 宽松:短端降息 + 长期缩表 = P 松而 Q 紧,总流动性仍在收。',
          '⚠️ Q 不再扩张时 G 才凸显:水少 + 水温升 = 大鱼吃光饲料、小鱼饿死(缩圈 / 虹吸)。',
          '',
          '临界:看拐点不看水平,绝对水位无普适阈值。高点转头 = 量边际收紧 = 最早预警。',
          '缩表本身不即紧,要推进到 RRP 抽干、准备金稀缺才现结构性资金压力。',
          FIVE_STEPS,
          '⚠️ 别信单指标:储备管理阶段(RMP)最易出假信号。',
        ].join('\n'),
      },
      {
        key: 'reverseRepo',
        label: '逆回购',
        title: '逆回购 RRP',
        color: '#14b8a6',
        desc: [
          '定义:货币基金等把现金隔夜停在美联储的量(ON RRP)。过剩流动性的泄洪垫。',
          'RRP 下降本身是释放(回流准备金 / 货币市场);但常与 TGA 重建 / QT 同时发生,后两者才是真正收紧。',
          '',
          '临界:见底 ≈ 0 = 缓冲耗尽(五步第 2 步)。此后任何冲击(TGA 突变 / 发行放量 / 季末缴税)直接打在准备金上。',
          '⚠️ 归零 ≠ 已缺水,含义是「缓冲没了」——它把后续冲击的传导时间压到最短。',
          '口径:总量充裕 ≠ 人人够用。它测缓冲、不测分布;分布看回购用量(SRF)那格。',
          '',
          FIVE_STEPS,
        ].join('\n'),
      },
      {
        key: 'repoUsage',
        label: '回购用量',
        title: '回购用量 (隔夜正回购 RPONTSYD)',
        color: '#ec4899',
        desc: [
          '定义:美联储隔夜正回购总量(RPONTSYD,含 2021 起的常备回购便利 SRF)。',
          'SRF = 安全阀:动用它 = 私人市场借不到便宜钱,只能转向美联储。',
          '',
          '⭐ 最敏感的一盏灯:它测「分布」,比利差更早暴露碎片化。IORB−SOFR 只照融资可用性,照不见总储备。',
          '临界(平时 ≈ 0):偶发小量 = 总量仍够但碎片化加剧;集群 / 持续抬升 = 结构性咬人(五步第 4 步)。',
          '⚠️ 剔除月末 / 季末 / 缴税日的技术性尖刺,只在这些日子冒尖不算信号。',
          '参照:2019-09 钱荒是「总量真缺水」型;RMP 期更常见「总量够、分布坏」型。',
          '',
          FIVE_STEPS,
        ].join('\n'),
      },
      {
        key: 'repoStress',
        label: '回购压力',
        title: '回购压力 (IORB−SOFR)',
        color: '#a855f7',
        render: { kind: 'line', baseline: 0 },
        desc: [
          '定义:准备金利率 IORB − 隔夜 SOFR。⚠️ 本图是 SOFR−IORB 的反号:为正 = SOFR 低于 IORB = 松。',
          '它测「融资可用性」,不测「储备总量充裕度」——两维不能用一个利差混谈。',
          '',
          '临界:准备金充裕期在 +10bp 上下(2021–22 中枢约 +10,随准备金变稀缺整体下移,今值看图);',
          '⚠️ 所以别拿固定区间当基准——要比的是「相对自身近年中枢」有没有收窄,不是够不够 +10bp。',
          '收窄 = 融资边际趋紧、小鱼缺氧;',
          '⭐ 跌破 0 = 从「摩擦」升级到「缺氧危机」;继续走负放大 = SOFR 上冲(2019 钱荒型)。',
          '',
          '⚠️ 回到平静期的正值区 ≠ 流动性已恢复——可能只是边际融资压力缓和,掩盖总储备流出 / 分布恶化。',
          '必须与净流动性(量)+ RRP(缓冲)+ repo 用量(安全阀)交叉,不用单指标下结论。',
        ].join('\n'),
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
        desc: [
          '定义:标普 500 未来 30 天隐含波动率。本质是带时间轴的波动率保险,不是方向指标。',
          '完整读法 4 件套:VIX(诊断)+ 期货 C1/C3(可交易)+ 均线中枢(迁移)+ 1-3 价差(结构,见 VX1−V3 格)。',
          '',
          '临界:',
          '  · 极度恐慌需两条同现:① 水平冲高 ② 结构 super back(C1>C3 且走深)。只满足 ① 不一定是崩盘窗口。',
          '  · 低位不是安全,低波诱导加杠杆。「低波看杠杆,高波看流动性」——高波第一动作是减仓。',
          '  · 冲到「上一轮同类去杠杆」量级(而非系统性危机量级)≈ 定价充分,可逐步了结对冲性 vol 多头。',
          '',
          '⚠️ 极致缩圈下 VIX 被少数权重按住而失真,改用 VIXEQ 作权益侧代理。',
          '⚠️ 高波不是一种东西:顶部派发型(躲)/ 底部出清型(等恐慌见顶)/ 真空期中段型(熬)——',
          '   成交量本身不辨方向,要配价格位置 + 市场结构 + 资金行为定性。',
        ].join('\n'),
      },
      {
        key: 'vxn',
        label: 'VXN',
        title: 'VXN (纳指波动率)',
        color: '#f97316',
        percentile: { riskTail: 'low' },
        desc: [
          '定义:纳指 100 隐含波动率(VXN)。科技股版 VIX,通常高于 VIX。',
          '',
          '临界:低 = 自满,但纳指正是集中度最高的那一端——缩圈行情里 VXN 被压低,',
          '更可能是资金涌入少数权重把指数 vol 按住,而非风险变小。',
          '  VXN 低 + VIXEQ 高 + 相关性低 = 借来的平静(集中度脆弱),不是转稳。',
          'VXN−VIX 价差走阔 = 风险向科技端集中;两者同时压扁 + 头部权重高 = 共振红灯。',
        ].join('\n'),
      },
      {
        key: 'vixeq',
        label: 'VIXEQ',
        title: '成分股波动率 VIXEQ',
        color: '#ec4899',
        percentile: { riskTail: 'low' },
        desc: [
          '定义:标普成分股平均单股隐含波动率。低 = 个股层面也自满(风险端,红);高 = 单股波动定价高。',
          '⭐ 但核心不是它的水平,而是 VIXEQ − VIX 价差。',
          SIGMA_ID,
          '读价差 = 读相关性 / 离散度;换任何加权方案都关不上这条缝(分散化的数学宿命)。',
          '',
          '临界:价差走阔 = 集中度脆弱升高(头部吸血压 ↓VIX、其余缺血 ↑VIXEQ),不是转稳;',
          '相关性 → 1(危机齐杀)时缺口暴力收拢、VIX 向 VIXEQ 并拢 = 系统性事件。',
          '',
          '⚠️ 价差本身中性,要看缺口是怎么被撑开的:健康离散 = 基本面真分化、宽度仍在;',
          '被压住 = 少数巨头按住指数 vol、底下宽度已塌。',
          BREADTH_CHECK,
          '(再加一条:低 VIX 还配低 skew 也偏危险的读数。)',
          '用法:极致缩圈下用它替代 VIX 作权益侧代理,再去衔接 BTC / ETH 的流动性观察。',
        ].join('\n'),
      },
      {
        key: 'vxTermSpread',
        label: 'VX1−V3',
        title: 'VX1−V3 期限结构',
        render: { kind: 'signed' }, // 期限结构:符号柱状图,不套分位带
        desc: [
          '定义:VIX 期货近月 C1 − 三月 C3(柱子绿正红负,仅表符号)。',
          '⭐ 结构比水平更早、更硬地给阶段信号。',
          '',
          '临界:',
          '  · 红 / 负(contango,近低远高)= 常态。',
          '  · 绿 / 正持续走深(super back)= 极度恐慌,须与 VIX 冲高同现才是事件级诊断。',
          '  · ⭐ 由正翻负 = 核心翻转点:首次进入 contango,是「事件消退、右侧转左侧」的最早数字证据。',
          '  · ⚠️ 水平回落但仍残余 back = 不算出清,结构翻转才算。',
          '',
          '状态机:super back(齐杀)→ back 消退(分母型资产先动)→ 转 contango(优质资产企稳)',
          '→ 持续 contango(估值膨胀)→ 极度平静(风险重新累积)。配 OIS 隐含降息预期定位阶段。',
        ].join('\n'),
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
        desc: [
          '定义:CNN Fear & Greed 综合情绪(0-100),多因子合成、粗略。',
          '高 = 贪婪(风险端,红);低 = 恐惧(常是机会)。',
          '',
          '⚠️ 单维极端只值得关注,不构成信号。真正危险的是共振——',
          RESONANCE,
          '',
          '逆向读法:情绪类指标看的是散户狂热度(社媒热度冲到狂热阈值 ≈ 顶部邻近)。',
          '⚠️ 反直觉:极端高波常来自大资金离场造成的流动性空白,而非散户涌入——',
          '「热闹」时要警惕专业资金正在撤(持仓上表现为多空双双消失)。',
          '纪律:现象不单独作为交易触发,须与量化数据吻合(VIX 结构 / OIS 路径)。',
        ].join('\n'),
      },
      {
        key: 'cor1m',
        label: 'COR1M',
        title: '隐含相关性 COR1M',
        color: '#22c55e',
        percentile: { riskTail: 'low' }, // 低=分化/自满=风险
        desc: [
          '定义:标普隐含相关性(COR1M),成分股隐含共动程度。低 = 隐含分化(风险端,红);高 = 共动更强。',
          '与 VIXEQ−VIX 价差是同一件事的两种写法:相关性低 = 缺口张开 = 离散度高;高 = 缺口收拢。',
          SIGMA_ID,
          '',
          '临界:',
          '  · 低 = 隐含分化。可能是健康的基本面真分化,也可能是集中度把指数 vol 按住的假象——单看判不了。',
          '    ' + BREADTH_CHECK,
          '  · ⭐ 奔向 1 = 系统性事件:齐跌、分散化失效、VIX 向 VIXEQ 暴力并拢。',
          '    同一判据用在缺血端 canary 篮子上:齐跌 = 干净信号,单跌 = 个体噪声,剔掉。',
          '',
          '⚠️ 低相关 + 低 VIX 同现 = 指数的平静建立在极少数支柱上,越极端越接近「差一个点火」。',
        ].join('\n'),
      },
      {
        key: 'rxmSpx',
        label: 'RXM/SPX',
        title: 'RXM/SPX (风险逆转相对表现)',
        color: '#a855f7',
        percentile: {}, // 无可靠方向,只给 P5/P95 参考 + 徽标,不染背景带
        desc: [
          '定义:Cboe 风险逆转指数 RXM(买 25Δ call / 卖 25Δ put 滚动策略)÷ SPX。',
          '衡量为「上行参与」付出 vs 为「下行保护」收取之间的净平衡。',
          '',
          '读法:比值高 = 更愿卖 PUT、渐趋乐观 → 往往对应市场被低估;',
          '比值低 = 下行保护偏贵、悲观避险 → 往往对应高估阶段,此时流动性一收就迅速引发波动率走高。',
          '低比值 + 低波动 = 典型「虚假平静」(市场在定价「卖 PUT 将面临更大风险」),是共振清单里的期权情绪一格。',
          '',
          '⚠️ 它是累计表现比、水平受历史路径影响,故只给 P5/P95 参考、不染背景带;',
          '读方向以「相对自身历史的低位」为准,不看绝对数。',
        ].join('\n'),
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
        desc: [
          '定义:美元指数 DXY(对一篮子货币),蜡烛图。源:Yahoo DX-Y.NYB。',
          '走强 = 压新兴市场 / 商品 / 风险资产;走弱 = 宽松。',
          '',
          '⭐ ' + FICC_TRIANGLE,
          '',
          '临界:关键不是水平,是波动率与关键位突破。',
          '  · 长期低波横盘 = carry trade 与跨境资本流动不受扰动,资金安心留在美股核心。',
          '  · 波动率一起来 → 全球流动性再分配 → 新兴市场 / commodity carry / 美股杠杆头寸连带受冲,反身性加速。',
          '盯 FICC 三者的波动率,比单看 VIX 更早捕捉结构性拐点(边缘小鱼闪崩是早期表现)。',
        ].join('\n'),
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
        desc: [
          '定义:美元兑日元。日元 carry 的价格腿——日元是全球第一融资货币。',
          '走高(日元贬)= carry 顺风 / risk-on;急跌 = carry 平仓(unwind)。',
          '',
          '⭐ 机制:危机里日元「升值避险」的本质是日元负债平仓(卖 EM / 风险资产 → 买回日元还债)。',
          '因果是资产端出问题倒逼负债端回补——急跌是结果,不是起因。',
          '',
          '临界:',
          '  · 央行可信干预有上限。干预区的点位(历史上如 160 一线)随财政 / 政治容忍度上移,',
          '    是当轮的参照而非固定阈值。',
          PINNED_VOL,
          '  · 转折判据不是点位,是经常项目 × 资本项目的组合切换',
          '    (2011 福岛:进口能源激增 → 经常顺差转逆差 → 日元升值到头)。',
          '  · 风险偏好更纯的读数用 AUD/JPY(资产腿 ÷ 融资腿),与 VIX 反向共振;',
          '    失效边界 = 任一腿的经常项目独立大转向。',
          '',
          '上游链:政治 → 央行(BOJ 非独立)→ 货币政策 → 资本。政治转向 = 日元大幅升值风险。',
        ].join('\n'),
      },
      {
        key: 'usjp2y',
        label: '美日2Y利差',
        title: '美日 2Y 利差 (DGS2−JGB2Y)',
        color: '#c98500',
        desc: [
          '定义:美日 2 年期利差(DGS2 − JGB2Y)。carry 的收益驱动。走阔 = 借日元买美元更划算 = 支撑 USD/JPY。',
          '为什么看 2Y:它对应货币政策预期的时间位置(利差—汇率传导最直接);10Y 混入期限溢价与供给,读汇率失真。',
          '',
          '临界:收窄 = carry 的收益基础被侵蚀 → 平仓压力累积。',
          '收窄 + 拥挤(CFTC 极端净空、总持仓高位)= 反转时踩踏——单看利差收窄不足以判 unwind。',
          '90 年代日美利差一度约 5%,是 carry 建仓 / 资金外流的历史量级参照。',
          '⚠️ 贬值预期会打折实际利差:名义利差还在,但预期反转时 carry 已不划算。',
        ].join('\n'),
      },
      {
        key: 'cftcJpy',
        label: 'CFTC 净持仓',
        title: 'CFTC 日元净持仓 (多−空)',
        render: { kind: 'signed' }, // 净持仓符号柱:净多绿、净空红、0 基线(拥挤度)
        desc: [
          '定义:CFTC 投机盘日元净持仓(多 − 空)。拥挤度。绿 = 净多,红 = 净空。',
          '',
          '⚠️ 两类空头含义相反:商业空头增加 = 对冲锁汇需求(被动、相对中性);',
          '非商业(投机)空头从偏空变成极端拥挤、单边加仓——这才是危险的那类。',
          '',
          '临界:极端净空 + 总持仓高位 = 拥挤度快升 → 挤仓 / 踩踏概率升高 → 容易加速破位。',
          '⚠️ 拥挤 ≠ 杠杆 ≠ 泡沫:它只是持仓同质化程度,标记脆弱、不预测时点;',
          '要和利差(收益基础)+ 价格腿一起读才成判据。',
        ].join('\n'),
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
        desc: [
          '定义:美国 10 年期国债收益率。长端利率锚。',
          '方向不单一(增长 or 通胀 / 供给都能推),故不设风险端,只给 P5/P95 参考。',
          '⭐ ' + FICC_TRIANGLE,
          '',
          '临界:',
          '  · 向上突破到「估值不可承受」区间(CAPE 约 40 倍 + 杠杆集中时约 5%)→ 拥挤主线无法继续吸纳资金',
          '    → 踩踏,缺血端小鱼首当其冲(缺血 → 抛售 → 更缺血)。该阈值绑定当期估值 / 集中度,环境变了要重估。',
          '  · 曲线过低 + 扁平时,曲线本身就是脆弱源:凸性陷阱(越低久期越长)、长端买盘缺失、股债双杀。',
          '    扁平化不只是衰退预告,更是配置结构的脆弱读数。',
          '',
          '配套:配 MOVE(波动率)+ 2s10s(扁平度)一起读,波动率通常比水平更前置。',
        ].join('\n'),
      },
      {
        key: 'move',
        label: 'MOVE',
        title: 'MOVE (债市波动率)',
        color: '#f43f5e',
        percentile: { riskTail: 'low' }, // MOVE 压扁=自满=风险
        desc: [
          '定义:美银美林美债期权波动率指数(MOVE,参考 2–30 年期场外期权)。债市版 VIX。',
          '',
          '⭐ 定位:债券层是波动率传导体系的核心层,MOVE 是 FICC 风险的核心信号——',
          '它不是与 VIX 平级的另一个指标,而是上游。',
          '传导:债券层(MOVE / 长短端利差 / 油价波动率)→ 权益层(VIX / V2X)+ 外汇层(G7-VXY / EM-VXY)。',
          '',
          '临界:低 = 自满(风险端),也是集中度行情敢 all-in 的前提之一;',
          '抬升 → 通胀预期 / 贴现率重定价 → 收益率曲线剧动 → 杀成长股贴现。',
          '⚠️ 与 VIX 相关性一般,VIX 平静不能代替看 MOVE(「股市静、债市先动」是常见领先形态)。',
        ].join('\n'),
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
        desc: [
          '定义:亚特兰大联储薪资增速 tracker(时薪同比的非加权中位数,3 个月移动平均)。月频。',
          '工资压力 / 劳动力市场紧张度代理(指标本身不度量因果螺旋)。',
          '高 = 工资涨得快、通胀更黏(风险端,红);低 = 压力缓解(绿)。',
          '',
          '⭐ 为什么重要:核心服务通胀最终受薪资驱动 → 薪资 = 服务通胀黏性的关键来源 = 短端通胀压力的根源。',
          '而 2022 后的范式里,短端利率已取代长端成为新锚。',
          '',
          '临界:',
          '  · 判「可持续通胀」不看某个水平,看物价—薪资正反馈是否被激活——一旦激活靠经济自身切不断,必须紧缩介入',
          '    (对照 2010-11:油价 / 大宗推动的通胀属暂时性,会自行回落)。',
          '  · 逆全球化下的时序翻转:顶层(金融 / 科技)裁员,底层就业紧、薪资顽固 → 商品通胀缓和、服务通胀黏住。',
          '  · 传导到流动性:薪资不回落 = 短端锚抬高 = 降息空间受限 = P 维松不动。',
          '',
          '与 Sticky CPI(已实现黏性)+ BEI(市场预期)三者并读。',
        ].join('\n'),
      },
      {
        key: 'stickyCpi',
        label: '服务黏性',
        title: 'Sticky CPI (服务黏性)',
        color: '#8b5cf6',
        percentile: { riskTail: 'high' },
        desc: [
          '定义:亚特兰大联储 Core Sticky-Price CPI(剔除食品能源,同比)。月频。',
          '调价频率低的那部分篮子(服务为主),转向慢。高 = 核心通胀顽固(风险端)。',
          '与薪资是同一条链的两端(薪资 → 核心服务 → 黏性);与 BEI 并读 = 已实现黏性 vs 市场定价预期。',
          '',
          '临界:',
          '  · 高且不降 = 短端被通胀锚住 → 「降息 = 宽松」不成立(P 维松不动、Q 维还在收)。判 PQ 象限的关键一格。',
          '  · 2022 后范式:通胀来源从需求侧转向供给冲击 + 薪资螺旋 + 服务黏性;',
          '    央行从「跟随经济」变成「主导控通胀」→ 黏性不破不轻易转向,也不被衰退呼声吓倒。',
          '  · 后果:深度倒挂可长期持续、利差交易失去基础(长端偏离短端,而非反之)。',
        ].join('\n'),
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
          '',
          '⭐ 真正要盯的不只是水平,是油价波动率——油是 FICC 低波三角之一。',
          '临界:',
          '  · 地缘冲击到油价有约 60–90 天缓冲(航运调节 + SPR 释放 + 炼厂库存与开工率自平衡),',
          '    缓冲期造就「确定性与不确定性共存」的窗口;缓冲长度按事件重估,不是永久常数。',
          '  · 缓冲耗尽 + 需求高峰 + 供给不改善 → 油价波动率急放大 → 通胀预期重定价 → 曲线剧动 → 杀成长股贴现。',
          '⚠️ 地缘下别只看盘面价:管道一堵,价格因「没有量根本出不来」而失去意义,',
          '真变量是封锁时长 T;区分「谈(预期)vs 通(现实)」——没真正通,现实失血一直在累积。',
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
          '',
          '⚠️ 地缘期反直觉:中东重质原油八成去亚洲,买家转订美国 / 西非轻质船货(采购置换)会把 WTI 顶到高于 Brent',
          '——价差转负未必是美国需求问题。此时盘面价失真,真变量是封锁时长 T。',
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
          '',
          '地缘期读法:柴油 / 航油是「通不通」的产成品端读数——轻质替代重质时航油 / 柴油先短缺,',
          '裂解先走高,领先原油价格给出物理紧张信号。',
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
        desc: [
          '定义:日本 10 年期国债收益率。BOJ 政策 / YCC 的长端。方向不单一,只给参考线。',
          '',
          '⭐ 读法:它是全球 carry 的负债端成本锚(日本是成熟债权国 + 全球第一融资端)。',
          'JGB 长端上行 = 借日元成本抬升 = carry 收益基础被侵蚀 → 经美日利差传到 USD/JPY → 全球风险资产。',
          '',
          '临界:看结构性上台阶(政策框架变化)而非单日跳动,前者才是 carry 生命周期的转折。',
          '转折判据用经常项目 × 资本项目的组合切换,不是收益率点位。',
          '⚠️ 上游是政治:BOJ 不像美联储独立,更服务于政府政治意愿——政治变量才是日元 / JGB 的核心上游。',
        ].join('\n'),
      },
      {
        key: 'jgbVix',
        label: 'JGB VIX',
        title: 'S&P/JPX JGB VIX (日债波动率)',
        color: '#f43f5e',
        percentile: { riskTail: 'low' }, // 波动率压扁=自满=风险(同 MOVE)
        desc: [
          '定义:S&P/JPX JGB VIX,日债期权隐含波动率。日债不确定性(对称美债 MOVE)。',
          '',
          '临界:',
          '  · 低 = 自满,但要分清是「真稳」还是「被干预压出来的稳」。',
          PINNED_VOL,
          '  · 飙高 = 日债动荡,经 carry 负债端外溢到全球利率与风险资产(日本这条腿走融资端渠道)。',
          '',
          '配套:与 JGB 10Y(水平)+ 美日 2Y 利差(carry 收益)+ CFTC 净持仓(拥挤)四格连读。',
        ].join('\n'),
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
        desc: [
          '定义:席勒 CAPE(周期调整市盈率 PE10)。股市长期估值。',
          '高 = 贵 = 未来 10 年回报低(风险端,红);低 = 便宜。',
          '尺度:宏观 / 系统锚,对象是整体大盘市值,不适合套到单一产业 / 个股',
          '(个股用 PEG,但 PEG 分母靠分析师预测、容易错)。用法是宏观 → 中观 → 微观逐层结合。',
          '',
          '临界:',
          '  · ⭐ 约 40X = 系统性预警值。⚠️ 这是「历史极值区 + 当期低利率 / 高集中度」下的条件锚,',
          '    不是恒定阈值:CAPE 中枢本身随无风险利率与会计口径结构性抬升,利率环境变了要重定。',
          '  · 它是估值指标不是流动性指标——但靠流动性扩张膨胀的资产会把它推回预警区。',
          '    推论:CAPE 到预警区且这轮扩张主要靠 P/Q 牵引(而非业绩)时,纯靠 PQ 膨胀的资产(BTC / ARKK 类)最脆。',
          '  · 与 10Y 联动:预警区估值 + 杠杆集中的市场,承受不起 10Y 冲上 5%。',
          '  · 单看高估值只值得关注。' + RESONANCE,
          '',
          '分位只用 2000+ 算(CAPE 结构性抬升,长历史比不公平)。',
        ].join('\n'),
      },
    ],
  },
};

// ── 基本面维度:按启用名单派生,一家一个 dim(三格)+ 一条买方合计 ────────────────
// 不写死在 REGIME_DIMS 里,否则每开一家公司都要手改三处(路由键 / pane 表 / 横 tab)。

/** 各家自己的实测事实(不会过期的历史值 / 一次性事项),挂在对应公司的格上。 */
const COMPANY_NOTES: Record<string, string> = {
  NVDA:
    '⚠️ 单季异常先查一次性事项:2025-04-27 那季单季毛利率 60.5% 是 H20 存货减值 45 亿的结果,' +
    '不是定价能力变化 —— TTM 口径会把它摊四个季度,别读成趋势。',
  MU:
    '⚠️ 波幅远大于算力侧,读「在自身周期的哪个位置」而非跨公司比高低。库里实测历史标尺(2010 起):' +
    '最低 −14.5%(2023-11,亏损年)、上一轮 2018 存储周期峰值 59.6%。' +
    '**MU 毛利率是 DRAM/NAND 价格周期的免费代理** —— 权威现货价(TrendForce)要钱,而存储是纯周期品:' +
    '同样的晶圆,价格涨落几乎全反映在毛利率上,增量收入接近全额毛利。',
  AMD:
    '定位:**加速器侧的第二家,和 NVDA 对读**。同一批客户、同一波需求,毛利率差距就是定价权差距 ' +
    '(实测 2026Q2:AMD 53.8% 对 NVDA 同期 70%+)。**AMD 的毛利率抬升先于 NVDA 回落** = ' +
    '客户开始接受第二供应商,是稀缺溢价松动的早期读数;两家同步走高只是需求还在扩。\n' +
    '⚠️ 是**混合读数**:AMD 还有客户端/服务器 CPU。2026Q2 数据中心占营收约 58%(公布值),' +
    '占比越高这条线越接近纯加速器读数,但永远不是纯的。\n' +
    '⚠️ **FCF 那两格在 FY2025 偏高**(毛利率不受影响):AMD 那年有终止经营(ZT Systems 制造业务出售),' +
    'OCF 取的是总额(含终止经营),而 capex 那条腿的 us-gaap 科目按构造只含持续经营 —— ' +
    '实测 FY2025 全年虚高 1.216B(总额 7.709B vs 持续经营 6.493B),H1 那期虚高 0.549B。' +
    '不改成持续经营口径是因为那档「有终止经营才报」、Q1 就缺,换过去会在同一个差分组里换基础' +
    '(详见 TAG_CHAINS.ocf)。**2026 起已归零**(H1 2026 终止经营 OCF = 0),只影响 FY2025 那几点。',
  TSM:
    '定位:**整条链的物理瓶颈**,也是这套面板里唯一**两个源各管一半**的一家 ——\n' +
    '· 季度四格(毛利率/FCF/单季 FCF/capex)来自它交给 EDGAR 的季度合并财报 6-K,T+45,可回填到 2023Q1。\n' +
    '· 月营收两格来自台湾证交所,**T+10,全链最快** —— 比任何季报早一个月以上,而且是已发生的出货量、' +
    '不是指引。实测 2026-06:NT$442,680M、同比 +67.9%,源附备注「因先進製程產品需求增加所致」。\n' +
    '· 两个源交叉验证过:H1 2025 营收 6-K 报 1,773,045,533 千元,与 TWSE 月营收累计**完全一致**。\n' +
    '· 和 NVDA 对读:NVDA 的营收是 TSM 出货的下游结果,**TSM 月营收转弱会先于 NVDA 季报体现**;' +
    '毛利率则是「代工端议价权」,实测 2025Q2 58.6% → 2026Q1 66.2%,一路抬升。',
  ASML:
    '定位:**上游产能的最上游** —— EUV 光刻机的唯一供应商。它的出货是 TSM/存储厂真正扩产的物理前置。\n' +
    '⚠️ **不要照 NVDA/MU 那套读它的毛利率**:ASML 是垄断,定价权一直在,毛利率长期稳在 50~54%,' +
    '不随周期摆 —— 「见顶回落 = 供给追上需求」那条判据对它基本无效。\n' +
    '真正有信息量的是另外两个:**营收**(已发生的设备出货 = 产能什么时候真的到位)、' +
    '**capex**(它自己扩不扩产 = 对未来需求的下注)。\n' +
    '⚠️ **领先指标已经没了**:ASML **2026 年起停止披露净订单(net bookings)**,最后一次是 2025Q4' +
    '(实测 2026Q1/Q2 的新闻稿全文无 booking 字样,只剩一句「order intake remained extremely strong」)。' +
    '所以这里能看到的全是**已发生**的,看不到未兑现的需求。\n' +
    '⚠️ 单季 FCF 摆动极大(实测 2026Q1 −2,588 → Q2 +1,404 百万欧元),那是**营运资本节奏**' +
    '(为 2027 扩产备料吃现金),不是 §6.14 那种「capex 吃穿现金流」—— 形状像,成因完全不同。',
  INTC:
    '⚠️ **不是判据成员**(名单文案里不列它,合计线也不收它),放这里是当**供给侧的反向读数**。\n' +
    '· 符号和 NVDA/MU 相反:那两家「毛利率见顶回落 = 供给追上需求」;INTC 是' +
    '**毛利率修复 = 新产能/新供应商进场**,同样指向稀缺溢价见顶,但方向朝上。混着读会读反。\n' +
    '· 是**混合读数**,而且混得比 AMD 重:INTC 毛利率同时装着「晶圆厂利用率修复」' +
    '(自身周期,与 AI 无关)和「AI 芯片定价权」两件事,拆不开。实测 TTM 从 29.8%(2025-06-28)' +
    '抬到 38.6%(2026-06-27),同期公布的数据中心与 AI 营收同比 +59% —— 两个成因都在,占比不可分。\n' +
    '· FCF 那两格更要小心:INTC 是**自建晶圆厂**,它的 capex 是制造业产能投入,' +
    '不是 §6.14 那种「买算力」。所以它绝不进买方合计。实测 TTM FCF 刚由负转正' +
    '(2025-06-28 −10.9B → 2026-06-27 +2.8B),读的是「代工投入周期过峰」,不是 AI 判据。',
};

// 买方侧共用:我们的口径是「OCF − 总额现金 capex」,而**每家公司自己公布的 FCF 定义都不一样**,
// 四家买方实测出四种调整、两个方向。别指望能和新闻稿的数字对上。
const SEC_LEASE_CAVEAT =
  '⚠️ **口径:OCF − 总额现金 capex**。取的是「现金买固定资产」那一组科目(见 TAG_CHAINS.capex,' +
  '逐期裁决,同一家不同季度可能命中不同 tag)。**和公司公布的 FCF 对不上是正常的**,而且差的方向' +
  '两边都有 —— 实测:\n' +
  '  · MSFT:公司的「capex」含**融资租赁**(2026Q2 我们 35.8B vs 公布 41B)→ 我们的 FCF **偏高**。\n' +
  '  · META:同理含融资租赁本金(2026Q1 我们 19.00B vs 公布 19.84B)→ 我们偏高。\n' +
  '  · NVDA:它自己的 FCF 还要再减「PP&E/无形资产的本金还款」→ 我们偏高。\n' +
  '  · AMZN:它把**处置与激励回款净掉**了(TTM 差约 40 亿)→ 我们的 FCF 反而**偏低**。\n' +
  '这些调整项多是公司自定义 XBRL(extension),companyfacts 拿不到,所以统一用总额、不做各家特调。\n' +
  '\n' +
  '⚠️ **还有一层:AMZN 的 capex 口径本身就比另四家宽**,不只是调整项的差别。它命中的是 ' +
  '`PaymentsToAcquireProductiveAssets`(PP&E + 自用软件/网站开发),另四家是纯 PP&E。' +
  '换 tag 时留的唯一重叠期(FY2016)实测 **+15.8%**(6.737B vs 7.804B)。\n' +
  '  · **没有可选项**:AMZN 2017-03-31 之后就不再披露 us-gaap 的纯 PP&E tag,不是我们选错了 tag。\n' +
  '  · 也**无法更新这个百分比**:实例里没有任何自用软件分项(只有两个 extension:' +
  'VideoAndMusicContentCapitalizedCosts / ProceedsFromPropertyPlantAndEquipmentSalesAndIncentives),减不出纯 PP&E。\n' +
  '  · 后果:**合计线读趋势成立,读「离零轴还有多远」时 AMZN 那部分偏保守**(capex 记多了 → FCF 记少了)。\n' +
  '  · 对照:NVDA 2020 也换过同一个 tag,但三个重叠期差额**全为 0** —— 换 tag 不等于换口径,得量。\n' +
  '\n' +
  '**读法:比趋势与相对变化,别拿绝对值去对新闻稿**;要看某一家的公司口径 FCF,去它的财报。';
// 断档裁剪是后端统一做的(trailingContiguous),对**每条** sec 序列都生效(含毛利率)。
// 各家/各科目的起点因此长短不一,必须在每一格都讲清楚,否则「怎么这条线只有几年」无处可查。
// 单季那格共用:为什么要它、以及它的陷阱。
const SEC_QUARTERLY_READ = [
  '**为什么单独画单季**:判据是「跌破零轴」,而 TTM 要四个季度累积才跌破 —— 转折看晚最多一年。',
  '实测:Alphabet 2026Q2 单季 FCF −5.9B(IPO 以来首次为负),而当时 TTM 还有 +53.3B;',
  '按当时的烧钱速度推,TTM 要到 2026Q4 才跌破零轴,**晚半年**(而且那还是假设烧钱不加速)。',
  'TTM 线上看不出这件事 —— 相邻 TTM 相减是「同比同季变化」(中间三项抵消,剩 Q(t)−Q(t−4)),不是当季值。',
  '',
  '⚠️ **只能同比同季比,不能顺序比**。单季受财年季节性影响极大(实测 MSFT 单季 FCF 在 5.9~25.7 之间摆、',
  'AMZN 的 Q4 +14.9 对 Q1 −18.2)—— 顺序看会把季节当成趋势。要判恶化,拿今年 Q1 对去年 Q1。',
  '',
  '分工:TTM 看**水平**(还有多厚)与**斜率**(同比在改善还是恶化);这条看**转折时点**。',
].join('\n');

const SEC_TRIM_NOTE =
  '⚠️ 只画**最近一段连续序列**:XBRL 里某些季度的原始行根本不存在(常见于早年,如 NVDA FY2013–FY2021 ' +
  '没有年度 capex 行、Q4 无从还原;毛利率也会因某季缺 revenue/cogs 而断),单季序列就断成孤岛。' +
  '折线只连点,断档两端会被连成一条**斜率是编的**直线,而这组判据全在读斜率,' +
  '故早于断档的孤立段一律裁掉(库里原始行全保留,只在读时裁)。各家各格的起点长短不一就是这个原因。';

const SELLER_GM =
  '判据:卖铲子一侧的**稀缺溢价读数**。见顶回落 = 供给追上需求、议价权开始让渡,' +
  '与买方 FCF 转负是同一转折的两侧(一侧收钱变难,一侧花钱变多)。' +
  '读**相对自身近年中枢的趋势**,不设硬阈值 —— 要的是「连续多期离开中枢往下」这个形状,' +
  '不是某一次跌破某个数。';
const BUYER_GM = '定位:配角。买方的毛利率由本业(云 / 广告 / 软件)主导,不是 AI 判据;放这里只为和自家 capex 对读。';
const SELLER_FCF =
  '定位:**卖方的 FCF 不进买方合计线**(见「买方合计」tab)。卖方在涨价周期里正 FCF 极大,' +
  '混进合计会把零轴永远垫在下方,§6.14 的「跌破零轴」就永远不成立。这条只看这家自身的现金生成。';
const BUYER_FCF_READ = [
  '判据(微观 §6.14):看的不是水平,是**会不会转负** —— 跌破零轴 = capex 吞掉了现金生成能力,',
  '扩张只能靠举债续,资本结构从自我造血转向外部融资。',
  '  · 零轴上方且抬升 = 扩张仍在自我造血,段位偏早。',
  '  · 抬升但斜率转平 = capex 增速追上 OCF 增速,离转折不远。',
  '  · 破零 = ③→④ 的硬信号。届时看举债路径(长期负债)确认。',
].join('\n');

// 每格依赖哪些科目 —— 用来把「已知结构性缺口」写进那一格的说明。
// 一格空着而 desc 不解释,下个月自己会当成 bug 去查(ORCL 的毛利率就是这种)。
// TWSE 那两格是空数组:KNOWN_GAPS 记的是 companyfacts 的科目缺口,与 TWSE 源无关。
const PANE_CONCEPTS: Record<FundKind, string[]> = {
  gm: ['revenue', 'cogs'],
  capex: ['capex'],
  fcf: ['ocf', 'capex'],
  fcfq: ['ocf', 'capex'],
  revM: [],
  revYoy: [],
};

/**
 * kind → 画法。**离散的期间量一律画柱,不画折线** —— 折线只连点,断档两端会被连成一条
 * 斜率是编的直线(TWSE 月营收实测踩过:接入首日中间空 11 个月,折线画出一条不存在的匀速上升)。
 * 连续的滚动量(TTM)才用折线。省略即默认折线、无基线。
 */
const RENDER_BY_KIND: Partial<Record<FundKind, PaneSpec['render']>> = {
  fcfq: { kind: 'signed' }, // 单季 FCF:正负是判据本身
  fcf: { kind: 'line', baseline: 0 }, // TTM 滚动量,但零轴是判据 → 折线 + 零基线
  revM: { kind: 'signed' }, // 月营收:恒正,柱色统一绿;要的是「柱子不连」
  revYoy: { kind: 'signed' }, // 月营收同比:正绿负红就是方向
};

const paneOf = (
  ticker: string,
  kind: FundKind,
  label: string,
  title: string,
  // signed(符号柱)不需要 color —— 正绿负红由 signed 分支决定,图例留空用默认色,与 vxTermSpread 一致。
  color: string | undefined,
  lines: Array<string | undefined>,
): PaneSpec => {
  const gaps = PANE_CONCEPTS[kind].flatMap((c) => {
    const why = knownGap(ticker, c);
    return why ? [`⚠️ **这格是空的,而且不是 bug**:${ticker} 的 ${c} 拿不到 —— ${why}`] : [];
  });

  return {
    key: fundKey(ticker, kind),
    label,
    title,
    color,
    ...(RENDER_BY_KIND[kind] ? { render: RENDER_BY_KIND[kind] } : {}),
    // 不配 percentile:样本仅十余期,分位是噪声。
    // 只丢 undefined —— '' 是段落分隔符,InfoTip 用 whitespace-pre-wrap 渲染,filter(Boolean) 会把它一起吃掉。
    desc: [...(gaps.length ? [...gaps, ''] : []), ...lines].filter((l) => l !== undefined).join('\n'),
  };
};

/** TWSE 三格共用:源的性质与币种。各格自己的端点与频率写在各自定义那一行。 */
const TWSE_CAVEAT =
  '\n源:台湾证交所(TWSE)OpenAPI 公开端点,**官方、免 key**,IFRS 口径。' +
  '金额单位是**百万新台币**(源给千元,已除 1000),不是美元 —— 别和其他 tab 的美元数直接比大小。';

/** 月营收那两格额外的时效说明(季度那格不适用:它慢得多)。 */
const TWSE_MONTHLY_SPEED =
  '端点是「营业收入汇总表」,每月 10 日左右出上月数(**T+10**)—— 这是整条 AI 链里最快的读数,' +
  '比任何季报早一个月以上,而且是已发生的出货量、不是指引。';

const TWSE_SNAPSHOT_NOTE =
  '⚠️ **只能往前攒,补不了历史**。端点只返回最新一个月;台交所的历史月报页有反爬' +
  '(实测返回「FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED」)。' +
  '好在一次调用能拿到**三个点**(当月 / 上月 / 去年当月),所以接入当天就有同比可读,' +
  '但**中间会有约 11 个月的空档**,要等按月攒满。\n' +
  '所以这几格画**柱状不画折线**:折线只连点,断档两端会被连成一条斜率是编的直线' +
  '(实测:接入首日 2025-06 到 2026-05 之间空 11 个月,折线画出一条不存在的匀速上升)。' +
  '柱子之间不连,空档就是没有柱子 —— 缺哪个月一眼看得见,而不是被抹成趋势。';

const TWSE_REV_READ = [
  '判据:卖铲子一侧的**需求强度即时读数**。代工厂的月营收 = 上游产能的实际出货,',
  '比任何人的指引都硬 —— 它已经发生了,不是预期。',
  '  · 同比持续 +40% 以上 = 需求还在扩张,链条上游没松。',
  '  · 同比逐月走平/回落 = 拐点的**最早**信号(比季报早一个月,比 FCF 转负早几个季度)。',
  '实测 2026-06:同比 +67.9%,源附的备注写「因先進製程產品需求增加所致」。',
  '',
  '⚠️ **只能同比同月比,不能顺序比**:代工厂月营收有强季节性(消费电子拉货节奏),',
  '顺序看会把季节当趋势。也别拿单月绝对值当趋势 —— 一个月里的工作日天数、汇率都会晃。',
].join('\n');

const TWSE_GM_READ = [
  '判据:**代工侧的稀缺溢价读数**,和 NVDA/MU 那几格同一个读法(见「卖铲子」侧的说明):',
  '见顶回落 = 供给追上需求、议价权开始让渡。代工是整条链的物理瓶颈,这一格的位置最靠上游。',
  '',
  '⚠️ 口径与 SEC 那几家**不同**,别直接比高低:',
  '  · 这是**单季**毛利率(源给年初至今累计,由相邻两季相减还原),SEC 那侧画的是 **TTM**。',
  '  · 币种是新台币,汇率会影响毛利率本身(TSMC 成本以台币计、收入大半以美元计)。',
  '  · 走 IFRS 而非 US GAAP。',
].join('\n');

const TWSE_GM_LAG_NOTE =
  '⚠️ **比月营收慢得多,而且可能空着**。季报截止日是季后约 45 天,同一季里各公司陆续申报 ——' +
  '实测 2026-08-05 时 115Q2 那张表里只有 82 家,台积电还没交(它一般临近截止日才交)。' +
  '所以这一格空着通常只是「本季还没申报」,不是坏了;要更快的读数看隔壁月营收(T+10)。\n' +
  '另:首次接入若不是从 Q1 开始,第一个毛利率点要等下一季 —— 单季值要靠相邻两季的累计相减,' +
  '而快照型源补不了上一季。**宁可空着也不拿累计值当单季用**:半年累计毛利率是 Q1 与 Q2 的平均,会把转折抹平。';

/** 走 TWSE 源的公司(目前只有 TSM):毛利率(季)+ 月营收同比 + 月营收。**没有 FCF** —— 源不给现金流。 */
function twseCompanyPanes(ticker: string): PaneSpec[] {
  const note = COMPANY_NOTES[ticker];

  return [
    paneOf(ticker, 'gm', '毛利率(季)', `${ticker} 单季毛利率(%)`, '#eab308', [
      `定义:${ticker} 单季毛利率 =(营收 − 营业成本)/ 营收,来自台湾证交所季度综合损益表。` + TWSE_CAVEAT,
      '',
      TWSE_GM_READ,
      '',
      TWSE_GM_LAG_NOTE,
      ...(note ? ['', note] : []),
    ]),
    // 两格都用符号柱:离散期间量,柱子不连、空档一眼可见(见 TWSE_SNAPSHOT_NOTE)。
    // 同比那格正绿负红本身就是判据方向;月营收恒正,柱色统一绿。
    paneOf(ticker, 'revYoy', '月营收同比', `${ticker} 月营收同比(%)`, undefined, [
      `定义:${ticker} 当月营收对去年同月的增减(%)。**取源自己算的值**,不是我们除出来的 ——` +
        '源在同一条记录里给了这个字段,而我们攒的历史可能还缺去年那个月。' +
        TWSE_CAVEAT,
      '',
      TWSE_MONTHLY_SPEED,
      '',
      TWSE_REV_READ,
      '',
      TWSE_SNAPSHOT_NOTE,
    ]),
    paneOf(ticker, 'revM', '月营收', `${ticker} 月营收(百万新台币)`, '#eab308', [
      `定义:${ticker} 单月合并营收。` + TWSE_CAVEAT,
      '',
      TWSE_MONTHLY_SPEED,
      '',
      '定位:同比那格的原始量。看绝对水平与「有没有再创新高」;判断方向请看同比那格。',
      '',
      TWSE_SNAPSHOT_NOTE,
    ]),
  ];
}

/** 金额格的单位标签。TSM 报表是新台币,和别家的美元数**不能比大小**。 */
const MONEY_UNIT: Record<'USD' | 'TWD' | 'EUR', string> = { USD: '百万美元', TWD: '百万新台币', EUR: '百万欧元' };

/**
 * 走 sec6k 源(季度合并财报 6-K)的额外口径说明 —— 数据不是 companyfacts 的 XBRL,
 * 是解析 HTML 报表来的,而且是 IFRS 而非 US GAAP。这两点都影响可比性。
 */
const SEC6K_CAVEAT =
  '\n⚠️ **这家的四个科目来自另一条源**:它是**外国私人发行人(FPI)**,豁免 10-Q,季报以 6-K 提交' +
  '且**不强制 XBRL 标记** —— companyfacts 因此只有年频。所以走它交给 EDGAR 的季报 6-K,' +
  '解析 HTML 报表得到:官方原文、可回填,但**不是 XBRL**,没有 tag 级溯源' +
  '(库里 tag_used 是为复用下游算法借的 us-gaap 名字,真溯源看同行的 accn)。\n' +
  '· 跨公司比绝对值前先看单位 —— 币种见本格标题。';

/** 走 6-K 那条的各家,各自的口径与时效差异。 */
const SEC6K_NOTES: Record<string, string> = {
  TSM:
    '· 口径是 **IFRS** 而非 US GAAP。报表只给年初至今累计,单季由相邻两期相减还原。\n' +
    '· 时效:**毛利率约 T+16,FCF/capex 约 T+45**,两格会差一个季度 —— 不是 bug。' +
    '财报稿(T+16)只给营收与毛利,现金流一定要等合并报表(T+45,台湾证交法 45 日的法定期限)。' +
    '毛利率走「财报稿先补、报表到了按 filed 更大覆盖」;财报稿是**未经会计师核阅**的管理层数,' +
    'job 每轮拿它和最近一个已核阅季度对一次,差超 0.5% 就报警(实测只差舍入)。',
  ASML:
    '· 口径**真的是 US GAAP**(ASML 是少见的用美国准则报的外国发行人),币种欧元。\n' +
    '· 报表**单季直给**,不用差分;**T+16~17** 就出(实测 2026-06-28 那期 07-15 交),' +
    '四个科目同时到位 —— 没有 TSM 那种「毛利率先到、FCF 后到」的错位。\n' +
    '· 解析有自校验:报表自己印了本期毛利率,算出来的对不上就抛(它的本期在**第 2 列**,' +
    '与 TSM 相反,取错列不会报错只会静默拿到去年的数)。',
};

function companyPanes(ticker: string): PaneSpec[] {
  const seller = sideOf(ticker) === 'seller';
  const note = COMPANY_NOTES[ticker];
  const unit = MONEY_UNIT[currencyOf(ticker)];
  // 走 6-K 那条的公司要多一段口径说明;走 companyfacts 的不用。
  const srcNote = hasSource(ticker, 'sec6k')
    ? SEC6K_CAVEAT + (SEC6K_NOTES[ticker] ? `\n${SEC6K_NOTES[ticker]}` : '')
    : '';

  return [
    paneOf(ticker, 'gm', '毛利率', `${ticker} TTM 毛利率(%)`, '#eab308', [
      `定义:${ticker} TTM 毛利率 =(营收 − 营业成本)/ 营收。` + SEC_CAVEAT + srcNote,
      '',
      seller ? SELLER_GM : BUYER_GM,
      '',
      SEC_TRIM_NOTE,
      ...(note ? ['', note] : []),
    ]),
    paneOf(ticker, 'fcf', 'FCF', `${ticker} TTM 自由现金流(${unit})`, '#22c55e', [
      `定义:${ticker} TTM 自由现金流 = 经营现金流 − 资本开支。` + SEC_CAVEAT + srcNote,
      '',
      seller ? SELLER_FCF : BUYER_FCF_READ,
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_TRIM_NOTE,
    ]),
    paneOf(ticker, 'fcfq', '单季 FCF', `${ticker} 单季自由现金流(${unit})`, undefined, [
      `定义:${ticker} **单季**自由现金流 = 该季经营现金流 − 该季资本开支(不是 TTM)。` + SEC_CAVEAT + srcNote,
      '',
      SEC_QUARTERLY_READ,
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_TRIM_NOTE,
    ]),
    paneOf(ticker, 'capex', 'capex', `${ticker} TTM 资本开支(${unit})`, '#60a5fa', [
      `定义:${ticker} TTM 资本开支(购置固定资产付现)。` + SEC_CAVEAT + srcNote,
      '',
      seller
        ? '定位:配角,和上面两条对读 —— 卖铲子的自身 capex 相对其 OCF 微不足道,这正是「卖铲子 vs 买铲子」现金流结构差异的直观佐证。真正吃 FCF 的是买方。'
        : '判据:capex 的斜率就是 §6.14 的分子。它加速而 OCF 不跟上 = FCF 见顶的直接成因;要和同 tab 的 FCF 格对读,单看 capex 抬升不构成信号(收入同步扩张时是健康扩产)。',
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_TRIM_NOTE,
    ]),
  ];
}

const buyerQuarterlyPane: PaneSpec = {
  key: SEC_BUYER_FCFQ_KEY,
  label: '买方合计(单季)',
  title: 'AI 链买方合计 **单季** 自由现金流(百万美元)',
  render: { kind: 'signed' }, // 符号柱:正绿负红、零基线;颜色由 signed 分支给,不配 color
  desc: [
    '定义:买方各家**单季** FCF 之和(不是 TTM),按日历季度对齐。' + SEC_CAVEAT,
    '',
    '⚠️ 口径先读这条:' + SEC_ROSTER_CAVEAT,
    '',
    SEC_QUARTERLY_READ,
    '',
    SEC_LEASE_CAVEAT,
    '',
    SEC_TRIM_NOTE,
  ].join('\n'),
};

const buyerAggregatePane: PaneSpec = {
  key: SEC_BUYER_FCF_KEY,
  label: '买方合计 FCF',
  title: 'AI 链买方合计 TTM 自由现金流(百万美元)',
  color: '#22c55e',
  render: { kind: 'line', baseline: 0 },
  desc: [
    '定义:**买方**(花钱建算力那一侧)已启用各家 TTM 自由现金流之和。' + SEC_CAVEAT,
    '',
    '⚠️ 口径先读这条:' + SEC_ROSTER_CAVEAT,
    '',
    BUYER_FCF_READ,
    '  · 覆盖不全时读趋势不读绝对值:少一家买方,零轴的位置就没有可比性。',
    '',
    SEC_LEASE_CAVEAT,
    '',
    SEC_TRIM_NOTE,
  ].join('\n'),
};

/**
 * source → 那家有哪几格。查表而非分支:加源时漏加一档是编译错误(Record 要求键齐),
 * 不是静默给它套上 SEC 那四格(那会画出四条永远空的线)。与 shared/aiChain 的 SOURCE_KINDS 配对。
 */
const SOURCE_PANES: Record<ChainSource, (ticker: string) => PaneSpec[]> = {
  sec: companyPanes,
  // sec6k 的原始行落进同一张表、派生同一套 SEC_* 序列 → 格子构造也是同一个
  // (只在说明里多一段口径差异,见 SEC6K_CAVEAT)。
  sec6k: companyPanes,
  twse: twseCompanyPanes,
};

/** dim → panes。基本面维度按名单现算(引用每次新建,故 RegimeChart 里要 useMemo 化的地方已由 dim 固定)。 */
export function dimPanes(dim: RegimeDim): PaneSpec[] {
  if (!dim.startsWith('fundamentals:')) return REGIME_DIMS[dim as FixedDim].panes;

  const who = dim.slice('fundamentals:'.length);
  if (who === 'buyer') return [buyerAggregatePane, buyerQuarterlyPane];

  // 一家可能走多个源(TSM:季度四格来自 sec6k、月营收两格来自 twse)—— 各源的格子按 sources
  // 顺序拼起来。同一个 key 只留一次:sec 与 sec6k 共用 companyPanes,同时声明两者时会重。
  const seen = new Set<string>();
  return sourcesOf(who)
    .flatMap((s) => SOURCE_PANES[s](who))
    .filter((p) => !seen.has(p.key) && seen.add(p.key));
}

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
  return dimPanes(dim).flatMap((p, pane): Spec[] => {
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

/**
 * 「公司已申报、SEC 还没提供那一期」的滞后提示(基本面维度专用)。
 *
 * 判据**不看期末日期差** —— 各家财年季末天然错开两三个月(实测 NVDA 的最新期落后 AMZN 整季
 * 是正常的:它下一季 8 月底才申报),日期差分不清「还没到财报期」和「交了但 SEC 没吃进」。
 * 只有后端拿 submissions 的 filed 与库里 MAX(filed) 比出来的才是确定结论,即 data.secLag。
 *
 * 为什么必须显示:滞后时那条线的末端是三个月前的读数,而这组判据全在读「最新一季转没转负」,
 * 不标注就会把旧点当成最新(实测 META 停在 2026Q1 的 +13.2B,而 Q2 实际是 +1.7B)。
 * 合计那格是**全员齐才出点**,任何一家滞后都顶住整条线的末端,故照样提示。
 */
export function secLagNote(data: RegimeData, dim: RegimeDim): string | undefined {
  if (!data.secLag?.length || !dim.startsWith('fundamentals:')) return undefined;

  const who = dim.slice('fundamentals:'.length);
  const mine = data.secLag.filter((l) => (who === 'buyer' ? isAggregateMember(l.ticker) : l.ticker === who));
  if (!mine.length) return undefined;

  const one = (l: SecLag) => `${l.ticker} 截至 ${l.latestPeriodEnd ?? '无数据'}(${l.remoteFiled} 已申报,SEC 未提供)`;
  return `⚠️ 数据滞后:${mine.map(one).join(';')}`;
}

/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentile 的 pane 产出。 */
export function regimePercentiles(data: RegimeData, dim: RegimeDim): Record<string, string> {
  return Object.fromEntries(
    dimPanes(dim).flatMap((p) => {
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
