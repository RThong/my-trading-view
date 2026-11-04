// 各视角共用的 tab 工厂:每个 tab 自带渲染闭包(label/source/render 一处配置)。
// 注意 tab id 与面板 source 是两回事(如收益曲线 / 期限走势可指向同一 source)。
import type { ReactNode } from 'react';
import { AssetChart } from '../views/asset/AssetChart';
import { RegimeChart } from '../views/regime/RegimeChart';
import type { RegimeDim } from '../views/regime/regimeChart.hooks';
import { regimeView } from './regimeDims';
import { YieldCurvePanel } from '../views/curve/YieldCurvePanel';
import { TenorHistoryPanel, type SpreadDef } from '../views/curve/TenorHistoryPanel';
import type { Interval } from '../hooks/interval';

export type TabDef = { id: string; label: string; group?: string; render: (interval: Interval) => ReactNode };
export type Perspective = { id: string; label: string; tabs: TabDef[] };

export function assetTab(id: string, label: string, underlying: string, vrpUnderlying?: string): TabDef {
  return {
    id,
    label,
    render: (interval) => <AssetChart interval={interval} underlying={underlying} vrpUnderlying={vrpUnderlying} />,
  };
}

export function regimeTab(id: string, label: string, dim: RegimeDim, group?: string): TabDef {
  return {
    id,
    label,
    group,
    render: (interval) => <RegimeChart view={regimeView(dim)} interval={interval} />,
  };
}

export function curveTab(id: string, label: string, source: string): TabDef {
  return {
    id,
    label,
    render: () => <YieldCurvePanel source={source} />,
  };
}

export function historyTab(
  id: string,
  label: string,
  source: string,
  /** 差值 pane,每条一格。省略 = 不画。 */
  spreads?: SpreadDef[],
  /** 现货参照标的。只给真的相关的那个 tab 配 —— 不是每格都该挂一条风险资产。 */
  spot?: string,
): TabDef {
  return {
    id,
    label,
    render: (interval) => <TenorHistoryPanel source={source} interval={interval} spreads={spreads} spot={spot} />,
  };
}

/** 单视图 regime 视角:无横 tab 条(tab 与视角同 id,TabBar 单 tab 时不渲染横条)。 */
export function regimePersp(id: RegimeDim, label: string): Perspective {
  return { id, label, tabs: [regimeTab(id, label, id)] };
}
