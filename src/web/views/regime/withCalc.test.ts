import { describe, expect, test } from 'bun:test';
import { dimPanes, REGIME_DOCS } from '../../pages/regimeDims';
import { seriesDef } from '../chartDoc/registry';
import { requestKey } from '../chartDoc/useSeriesData';
import { calcRequest, withCalc } from './RegimeChart';
import type { FixedDim, PaneSpec, RegimeData } from './regimeChart.hooks';

const pane: PaneSpec = {
  key: 'brent|-|wti',
  from: { series: 'brent', calc: { op: '-', series: 'wti' } },
  label: 'Brent − WTI',
  title: 'Brent − WTI',
};
const key = requestKey(calcRequest(pane));
const none: RegimeData = { series: {}, unavailable: [] };

describe('固定面板的计算格(withCalc)', () => {
  test('算好了:填到这格的键下', () => {
    const out = withCalc(none, [pane], { [key]: [{ time: '2026-10-01', value: 5 }] }, false, []);
    expect(out.series[pane.key]).toEqual([{ date: '2026-10-01', value: 5 }]);
    expect(out.unavailable).toEqual([]);
  });

  test('取数中不判缺;算完没数才记缺失', () => {
    expect(withCalc(none, [pane], {}, true, []).unavailable).toEqual([]);
    expect(withCalc(none, [pane], {}, false, []).unavailable).toEqual([pane.key]);
  });

  test('任一条腿是「沿用上次数据」的,这格也标出来', () => {
    const out = withCalc(none, [pane], { [key]: [{ time: '2026-10-01', value: 5 }] }, false, [key]);
    expect(out.fallback).toEqual([pane.key]);
  });

  test('固定面板所有计算格的两条腿都在注册表里(id 是字符串,拼错编译期查不出)', () => {
    const legs = (Object.keys(REGIME_DOCS) as FixedDim[])
      .flatMap((d) => dimPanes(d))
      .flatMap((p) => (p.from ? [p.from.series, p.from.calc.series] : []));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.filter((id) => !seriesDef(id))).toEqual([]);
  });
});
