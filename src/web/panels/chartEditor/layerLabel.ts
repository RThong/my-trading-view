// 图层的显示名与单位(卡片、图例、分析面板共用一处,免得几处写法漂移)。
import { findLayer, isSeriesLayer, type ChartDoc, type Layer } from './chartDoc';
import { seriesDef } from './registry';

/** 只取序列本名(不带平移 / 换算等修饰),给「A × B」这类组合名用。 */
export function baseLabel(doc: ChartDoc, layerId: string): string {
  const l = findLayer(doc, layerId)?.layer;
  if (!l) return '?';

  return isSeriesLayer(l) ? (seriesDef(l.series)?.label ?? l.series) : layerLabel(doc, l);
}

export const shiftText = (shift: number) => `${shift > 0 ? '右移' : '左移'} ${Math.abs(shift)} 天`;

export function layerLabel(doc: ChartDoc, l: Layer): string {
  if (isSeriesLayer(l)) {
    const name = seriesDef(l.series)?.label ?? l.series;
    const shift = l.shift ? `(${shiftText(l.shift)})` : '';
    const fit = l.fit ? ` ≈ 按${baseLabel(doc, l.fit.target)}换算` : '';
    return `${name}${shift}${fit}`;
  }

  const st = l.study;
  if (st.kind === 'corr') return `相关性 ${baseLabel(doc, st.a)} × ${baseLabel(doc, st.b)}`;

  const of = findLayer(doc, st.of)?.layer;
  const target = of && isSeriesLayer(of) && of.fit ? baseLabel(doc, of.fit.target) : '?';
  return `劈叉 ${target} − ${baseLabel(doc, st.of)}(换算)`;
}

/** 图例里跟在数值后的单位。劈叉用换算目标的单位;相关性无单位。 */
export function layerUnit(doc: ChartDoc, l: Layer): string | undefined {
  if (isSeriesLayer(l)) return seriesDef(l.series)?.unit;
  if (l.study.kind === 'corr') return undefined;

  const of = findLayer(doc, l.study.of)?.layer;
  const target = of && isSeriesLayer(of) && of.fit ? findLayer(doc, of.fit.target)?.layer : undefined;
  return target && isSeriesLayer(target) ? seriesDef(target.series)?.unit : undefined;
}
