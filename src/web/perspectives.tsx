// 竖 tab = 视角;每个视角自带横 tab 列表,每个 tab 自带渲染闭包(label/source/render 一处配置)。
// 取代原 App 里"tabs 只声明 id/label + 相邻 render(tabId) 用字符串分支决定内容"的分离写法——
// 新增 tab = 往数组加一条工厂调用,不再牵动 render 分支,两者也不会漂移。
import type { ReactNode } from 'react';
import { AssetChart } from './panels/asset/AssetChart';
import { RegimeChart } from './panels/regime/RegimeChart';
import { YieldCurvePanel } from './panels/rates/YieldCurvePanel';
import { TenorHistoryPanel } from './panels/rates/TenorHistoryPanel';
import { AttackDefensePanel } from './panels/attackDefense/AttackDefensePanel';
import { IndustryChainPanel } from './panels/regime/IndustryChainPanel';
import type { RegimeDim } from './panels/regime/regimeChart.hooks';
import type { Interval } from './hooks/interval';
import { MARKET_CATALOG } from '../shared/marketCatalog';

export type TabDef = { id: string; label: string; group?: string; render: (interval: Interval) => ReactNode };
export type Perspective = { id: string; label: string; tabs: TabDef[] };

// ── tab 工厂:注意 tab id 与面板 source 是两回事(如收益曲线 / 期限走势可指向同一 source)──
const assetTab = (id: string, label: string, underlying: string, vrpUnderlying?: string): TabDef => ({
  id,
  label,
  render: (interval) => <AssetChart interval={interval} underlying={underlying} vrpUnderlying={vrpUnderlying} />,
});
const regimeTab = (id: string, label: string, dim: RegimeDim, group?: string): TabDef => ({
  id,
  label,
  group,
  render: (interval) => <RegimeChart dim={dim} interval={interval} />,
});
const curveTab = (id: string, label: string, source: string): TabDef => ({
  id,
  label,
  render: () => <YieldCurvePanel source={source} />,
});
const historyTab = (
  id: string,
  label: string,
  source: string,
  long: string,
  short: string,
  spreadLabel: string,
  /** 现货参照标的。只给真的相关的那个 tab 配 —— 不是每格都该挂一条风险资产。 */
  spot?: string,
): TabDef => ({
  id,
  label,
  render: (interval) => (
    <TenorHistoryPanel
      source={source}
      interval={interval}
      long={long}
      short={short}
      spreadLabel={spreadLabel}
      spot={spot}
    />
  ),
});

// 单视图 regime 视角:无横 tab 条(tab 与视角同 id,TabBar 单 tab 时不渲染横条)。
const regimePersp = (id: RegimeDim, label: string): Perspective => ({ id, label, tabs: [regimeTab(id, label, id)] });

export const PERSPECTIVES: Perspective[] = [
  {
    id: 'options',
    label: '期权',
    // 期权标的 tab 由标的目录派生(有 tab 的条目);vrpUnderlying 有 VRP 才传(否则只 2-pane)。
    tabs: MARKET_CATALOG.filter((a) => a.tab).map((a) =>
      assetTab(a.tab!.id, a.tab!.label, a.underlying, a.vrp ? a.underlying : undefined),
    ),
  },
  regimePersp('credit', '信用'),
  regimePersp('liquidity', '流动性'),
  {
    id: 'sentiment',
    label: '情绪',
    tabs: [regimeTab('vol', '波动率', 'vol'), regimeTab('sentiment', '情绪', 'sentiment')],
  },
  regimePersp('macro', '宏观'),
  {
    // 能源两 tab:价差(市场怎么定价)与实物(EIA 周报的开工率 / 库存 / 出口)。
    // 分开是因为两边频率与读法都不同 —— 价差日频看拐点,实物周频 + 季节 z 看因果。
    id: 'oil',
    label: '能源',
    tabs: [regimeTab('oil', '油市结构', 'oil'), regimeTab('refinery', '炼厂·库存', 'refinery')],
  },
  {
    id: 'btc',
    label: 'BTC',
    // BTC 的全部格子收在这一个视角里(现货/夏普 + 期权),不在「期权」视角另开一个 BTC 横 tab ——
    // 见 marketCatalog 里 BTC 条目为何不配 tab。
    tabs: [regimeTab('btc', '现货/夏普', 'btc'), assetTab('btc_options', '期权', 'BTC', 'BTC')],
  },
  {
    id: 'rates',
    label: '利率',
    tabs: [
      curveTab('treasury', '收益曲线', 'treasury'),
      // 挂 BTC 现货当对照:它是流动性链条最末端、beta 最高的那个,曲线松紧的传导在它身上最先见效。
      historyTab('tenor_history', '期限走势', 'treasury', '10Y', '1Y', '10Y − 1Y', 'BTC'),
      curveTab('sofr_ois', 'SOFR OIS', 'sofr_ois'),
      historyTab('ois_history', 'OIS 走势', 'sofr_ois', '12M', '3M', '1Y − 3M'),
      regimeTab('rates_vol', '利率波动率', 'ratesVol'),
      // 长端分解三件套。名义在「收益曲线 / 期限走势」,通胀那一块在「通胀」视角的 BEI 两格,
      // 剩下的实际腿与期限溢价腿放这里 —— 长端上行时靠这几格分「动的是通胀还是实际利率」。
      curveTab('real_curve', '实际收益率', 'real'),
      // 30Y − 10Y:实际曲线自身的长端陡峭度。剥掉通胀后,这条走阔就是久期风险补偿在抬。
      historyTab('real_history', '实际走势', 'real', '30Y', '10Y', '30Y − 10Y'),
      regimeTab('rates_decomp', '长端分解', 'ratesDecomp'),
    ],
  },
  {
    id: 'japan',
    label: '日本',
    tabs: [
      regimeTab('jpy', '日元', 'jpy'),
      curveTab('jgb_curve', '收益曲线', 'jgb'),
      // 短腿与美债那格统一成 1Y —— 两个 tab 并排读时口径必须一样,否则没人会注意到定义不同。
      // (JGB 本来也没有更短的:MOF 曲线最短就是 1Y。)
      // 挂 8306(三菱UFJ)当现货参照腿:银行拿短端存款、放长端贷款,10Y−1Y 走阔直接扩净息差 ——
      // 它是这条曲线**最直接的受益标的**,和利差同图才读得出「市场认不认这条传导」。
      // (美债那格挂 BTC 是另一个道理:那是流动性链条最末端的 beta。)
      historyTab('jgb_history', '期限走势', 'jgb', '10Y', '1Y', '10Y − 1Y', '8306.T'),
      regimeTab('jgb_vol', '日债波动率', 'jgbVol'),
      // 产能面(日银试算,季度更新)。放日本视角最后一格:前面几格是市场怎么定价,这格是产能够不够 ——
      // BOJ 加息叙事的前提在这里,和曲线/日元那几格配读。
      regimeTab('jp_output_gap', '产出缺口', 'jpGap'),
      // 长端分解(中島上智模型)。对称利率视角同名那格,但只有一套模型 —— 读法差异写在两格 desc 里。
      regimeTab('jp_term_premium', '长端分解', 'jpTermPremium'),
    ],
  },
  {
    id: 'creditCurve',
    label: '信用曲线',
    // AI CDS 挪去了「AI」视角(聚合 AI 相关指标,不留在这里跟评级利差/期限结构混放)。
    tabs: [curveTab('credit_rating', '评级利差', 'credit_rating'), curveTab('credit_term', '期限结构', 'credit_term')],
  },
  {
    id: 'inflation',
    label: '通胀',
    tabs: [
      curveTab('bei', '通胀预期', 'bei'),
      historyTab('bei_history', '通胀走势', 'bei', '10Y', '5Y', '10Y − 5Y'),
      regimeTab('infl_source', '通胀来源', 'inflSource'),
    ],
  },
  regimePersp('valuation', '估值'),
  {
    id: 'ai',
    label: 'AI',
    // AI 相关指标全收在这一个竖 tab 里(不再单独开「基本面」)。前三个横 tab 是跨公司的汇总/宏观信号
    // (算力价格、买方合计判据线、AI CDS);「产业链」单独一个横 tab,里面是各家公司的财务明细
    // (一家一格,格子由那家的 source 决定,见 aiChain 的 SOURCE_KINDS)—— 十几家挤进主 tab 条太乱,
    // 收进 IndustryChainPanel 自己的内部公司选择器(见该文件,按 GROUP_ORDER 分组)。
    tabs: [
      regimeTab('gpu_compute', '算力价格', 'compute'),
      regimeTab('buyer', '买方合计', 'fundamentals:buyer'),
      historyTab('ai_cds', 'AI CDS', 'ai_cds', 'Oracle', 'Apple', 'Oracle − Apple'),
      { id: 'industry_chain', label: '产业链', render: (interval) => <IndustryChainPanel interval={interval} /> },
    ],
  },
  {
    id: 'featured',
    label: '特色指标',
    tabs: [{ id: 'attack_defense', label: '攻防', render: () => <AttackDefensePanel /> }],
  },
];
