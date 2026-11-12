// 图层的显示名与单位(卡片、图例、分析面板共用一处,免得几处写法漂移)。
import { findLayer, type ChartDoc, type Layer } from './chartDoc';
import { seriesDef, seriesLabel } from './registry';
import { INDICATORS, periodsOf } from '../../chart/indicatorDefs';
import { allSevenDay } from './layerPoints';

/** 只取序列本名(不带平移 / 换算等修饰),给「A × B」这类组合名用。 */
export function baseLabel(doc: ChartDoc, layerId: string): string {
  const l = findLayer(doc, layerId)?.layer;
  if (!l) return '?';

  return seriesLabel(l.series, l.calc);
}

export function shiftText(shift: number) {
  return `${shift > 0 ? '右移' : '左移'} ${Math.abs(shift)} 天`;
}

/** withShift = false:不带「(右移 N 天)」,给另外用标签显示平移的地方(图例)用 */
export function layerLabel(doc: ChartDoc, l: Layer, { withShift = true } = {}): string {
  // 图层写了 title 就用它(固定面板的格子都给了图例名),缺省才用注册表名;指标图层缺省 =「序列名 · 指标名」
  const name =
    l.title ??
    (l.indicator
      ? `${seriesLabel(l.series, l.calc)} · ${indicatorLabel(l, allSevenDay(doc))}`
      : seriesLabel(l.series, l.calc));
  const shift = l.shift && withShift ? `(${shiftText(l.shift)})` : '';
  const fit = l.fit ? ` · 叠加在${baseLabel(doc, l.fit.target)}上` : '';
  return `${name}${shift}${fit}`;
}

/** 指标名带上实际画的周期(EMA 5/20/50…,BTC 多一条 365;RSI 6/12/24),布林带 / MACD 参数固定、名字里已写 */
export function indicatorLabel(l: Layer, sevenDay: boolean): string {
  if (!l.indicator) return '';
  const { id, periods } = l.indicator;
  if (!INDICATORS[id].periods) return INDICATORS[id].label;
  return `${INDICATORS[id].label} ${periodsOf(id, periods, sevenDay).join('/')}`;
}

/** 图例里跟在数值后的单位。 */
export function layerUnit(l: Layer): string | undefined {
  if (l.indicator) return undefined; // 指标各条读数自带含义(RSI 0~100、MACD 差值),不套源序列的单位
  const unit = seriesDef(l.series)?.unit;
  if (!l.calc) return unit;
  // 比值没有单位;相减同单位才有单位,百分数相减是百分点
  if (l.calc.op === '/' || unit !== seriesDef(l.calc.series)?.unit) return undefined;
  return unit === '%' ? 'pp' : unit;
}
