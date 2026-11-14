// 各视角共用的 tab 工厂:每个 tab 自带渲染闭包(label/source/render 一处配置)。
// 注意 tab id 与面板 source 是两回事(如收益曲线 / 期限走势可指向同一 source)。
import type { ReactNode } from 'react';
import { FundChart } from '../views/regime/FundChart';
import { isFundDim, type RegimeDim } from '../views/regime/regimeChart.hooks';
import { fundamentalDoc, REGIME_DOCS } from './regimeDims';
import { DocChart } from '../views/chartDoc/DocChart';
import { assetDoc } from './assetDoc';
import { YieldCurvePanel } from '../views/curve/YieldCurvePanel';
import type { Interval } from '../hooks/interval';

export type TabDef = { id: string; label: string; group?: string; render: (interval: Interval) => ReactNode };
export type Perspective = { id: string; label: string; tabs: TabDef[] };

export function assetTab(
  id: string,
  label: string,
  underlying: string,
  vrpUnderlying?: string,
  options = true,
): TabDef {
  // 建 tab 时生成一次:DocChart 以它为初值,引用要稳定
  const doc = assetDoc(underlying, !!vrpUnderlying, options);
  return {
    id,
    label,
    render: (interval) => <DocChart doc={doc} interval={interval} fit="common" />,
  };
}

export function regimeTab(id: string, label: string, dim: RegimeDim, group?: string): TabDef {
  return {
    id,
    label,
    group,
    // 固定 dim 是内置 ChartDoc;基本面按名单现算 doc、外加 SEC 提示。都与图表编辑器同一套渲染
    render: (interval) =>
      isFundDim(dim) ? (
        <FundChart dim={dim} doc={fundamentalDoc(dim)} interval={interval} />
      ) : (
        <DocChart doc={REGIME_DOCS[dim]} interval={interval} />
      ),
  };
}

export function curveTab(id: string, label: string, source: string): TabDef {
  return {
    id,
    label,
    render: () => <YieldCurvePanel source={source} />,
  };
}

/** 单视图 regime 视角:无横 tab 条(tab 与视角同 id,TabBar 单 tab 时不渲染横条)。 */
export function regimePersp(id: RegimeDim, label: string): Perspective {
  return { id, label, tabs: [regimeTab(id, label, id)] };
}
