// 竖 tab = 视角;每个视角自带横 tab 列表,每个 tab 自带渲染闭包(label/source/render 一处配置)。
// 取代原 App 里"tabs 只声明 id/label + 相邻 render(tabId) 用字符串分支决定内容"的分离写法——
// 新增 tab = 往数组加一条工厂调用,不再牵动 render 分支,两者也不会漂移。
import type { ReactNode } from 'react';
import { AssetChart } from './panels/asset/AssetChart';
import { RegimeChart } from './panels/regime/RegimeChart';
import { YieldCurvePanel } from './panels/rates/YieldCurvePanel';
import { TenorHistoryPanel } from './panels/rates/TenorHistoryPanel';
import { AttackDefensePanel } from './panels/attackDefense/AttackDefensePanel';
import type { RegimeDim } from './panels/regime/regimeChart.hooks';
import type { Interval } from './hooks/interval';
import { MARKET_CATALOG } from '../shared/marketCatalog';

export type TabDef = { id: string; label: string; render: (interval: Interval) => ReactNode };
export type Perspective = { id: string; label: string; tabs: TabDef[] };

// ── tab 工厂:注意 tab id 与面板 source 是两回事(如收益曲线 / 期限走势可指向同一 source)──
const assetTab = (id: string, label: string, underlying: string, vrpUnderlying?: string): TabDef => ({
  id,
  label,
  render: (interval) => <AssetChart interval={interval} underlying={underlying} vrpUnderlying={vrpUnderlying} />,
});
const regimeTab = (id: string, label: string, dim: RegimeDim): TabDef => ({
  id,
  label,
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
): TabDef => ({
  id,
  label,
  render: (interval) => (
    <TenorHistoryPanel source={source} interval={interval} long={long} short={short} spreadLabel={spreadLabel} />
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
  regimePersp('oil', '能源'), // Brent−WTI + 柴油裂解:油市结构 / 物理紧张
  {
    id: 'rates',
    label: '利率',
    tabs: [
      curveTab('treasury', '收益曲线', 'treasury'),
      historyTab('tenor_history', '期限走势', 'treasury', '10Y', '3M', '10Y − 3M'),
      curveTab('sofr_ois', 'SOFR OIS', 'sofr_ois'),
      historyTab('ois_history', 'OIS 走势', 'sofr_ois', '12M', '3M', '1Y − 3M'),
      regimeTab('rates_vol', '利率波动率', 'ratesVol'),
    ],
  },
  {
    id: 'japan',
    label: '日本',
    tabs: [
      regimeTab('jpy', '日元', 'jpy'),
      curveTab('jgb_curve', '收益曲线', 'jgb'),
      historyTab('jgb_history', '期限走势', 'jgb', '10Y', '2Y', '10Y − 2Y'),
      regimeTab('jgb_vol', '日债波动率', 'jgbVol'),
    ],
  },
  {
    id: 'creditCurve',
    label: '信用曲线',
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
    id: 'featured',
    label: '特色指标',
    tabs: [{ id: 'attack_defense', label: '攻防', render: () => <AttackDefensePanel /> }],
  },
];
