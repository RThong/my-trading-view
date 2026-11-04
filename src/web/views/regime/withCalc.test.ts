import { describe, expect, test } from 'bun:test';
import { REGIME_DIMS } from '../../pages/regimeDims';
import { seriesDef } from '../chartDoc/registry';
import { requestKey } from '../chartDoc/useSeriesData';
import { calcRequest, withCalc } from './RegimeChart';
import type { PaneSpec, RegimeData } from './regimeChart.hooks';

const pane = { key: 'brentWti', from: { series: 'brent', calc: { op: '-', series: 'wti' } } } as PaneSpec;
const key = requestKey(calcRequest(pane));
const base: RegimeData = { series: { brentWti: [{ date: '2026-10-01', value: 9 }] }, unavailable: [] };

describe('固定面板的计算格(withCalc)', () => {
  test('算好了:覆盖服务端同名派生量', () => {
    const out = withCalc(base, [pane], { [key]: [{ time: '2026-10-01', value: 5 }] }, false, []);
    expect(out.series.brentWti).toEqual([{ date: '2026-10-01', value: 5 }]);
    expect(out.unavailable).toEqual([]);
  });

  test('取数中不判缺;算完没数、服务端也没有才记缺失', () => {
    const none: RegimeData = { series: {}, unavailable: [] };
    expect(withCalc(none, [pane], {}, true, []).unavailable).toEqual([]);
    expect(withCalc(none, [pane], {}, false, []).unavailable).toEqual(['brentWti']);
    // 服务端有同名派生量(缓存里还没新腿的那一会儿)→ 先沿用,不报缺
    expect(withCalc(base, [pane], {}, false, []).series.brentWti).toEqual(base.series.brentWti);
    expect(withCalc(base, [pane], {}, false, []).unavailable).toEqual([]);
  });

  test('任一条腿是「沿用上次数据」的,这格也标出来', () => {
    const out = withCalc(base, [pane], { [key]: [{ time: '2026-10-01', value: 5 }] }, false, [key]);
    expect(out.fallback).toEqual(['brentWti']);
  });

  test('现算没数、沿用服务端同名派生量时,保留服务端的「沿用上次数据」标记', () => {
    const stale: RegimeData = { ...base, fallback: ['brentWti'] };
    expect(withCalc(stale, [pane], {}, false, []).fallback).toEqual(['brentWti']);
    // 现算有数就以现算为准,服务端那个标记不再适用
    expect(withCalc(stale, [pane], { [key]: [{ time: '2026-10-01', value: 5 }] }, false, []).fallback).toEqual([]);
  });

  test('手写格子里所有计算格的两条腿都在注册表里(id 是字符串,拼错编译期查不出)', () => {
    const legs = Object.values(REGIME_DIMS)
      .flatMap((d) => d.panes)
      .flatMap((p) => (p.from ? [p.from.series, p.from.calc.series] : []));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.filter((id) => !seriesDef(id))).toEqual([]);
  });
});
