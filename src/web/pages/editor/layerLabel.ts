// 图层的显示名与单位(卡片、图例、分析面板共用一处,免得几处写法漂移)。
import { findLayer, type ChartDoc, type Layer } from '../../views/chartDoc/chartDoc';
import { seriesDef, seriesLabel } from '../../views/chartDoc/registry';

/** 只取序列本名(不带平移 / 换算等修饰),给「A × B」这类组合名用。 */
export function baseLabel(doc: ChartDoc, layerId: string): string {
  const l = findLayer(doc, layerId)?.layer;
  if (!l) return '?';

  return seriesLabel(l.series, l.calc);
}

export function shiftText(shift: number) {
  return `${shift > 0 ? '右移' : '左移'} ${Math.abs(shift)} 天`;
}

export function layerLabel(doc: ChartDoc, l: Layer): string {
  const name = seriesLabel(l.series, l.calc);
  const shift = l.shift ? `(${shiftText(l.shift)})` : '';
  const fit = l.fit ? ` · 叠加在${baseLabel(doc, l.fit.target)}上` : '';
  return `${name}${shift}${fit}`;
}

/** 图例里跟在数值后的单位。 */
export function layerUnit(l: Layer): string | undefined {
  const unit = seriesDef(l.series)?.unit;
  if (!l.calc) return unit;
  // 比值没有单位;相减同单位才有单位,百分数相减是百分点
  if (l.calc.op === '/' || unit !== seriesDef(l.calc.series)?.unit) return undefined;
  return unit === '%' ? 'pp' : unit;
}
