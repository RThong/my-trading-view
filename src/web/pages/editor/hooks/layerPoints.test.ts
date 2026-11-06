import { describe, expect, test } from 'bun:test';
import { BAND_CALM, BAND_RISK } from '../../../chart/palette';
import { normalBand, type Layer, type Pane } from '../../../views/chartDoc/chartDoc';
import { canLogScale, computeLayerData, layerMarks, type LayerData } from './layerPoints';

function pane(layers: Partial<Layer>[], expandVisibleTo?: [number, number]): Pane {
  return {
    id: 'p1',
    stretch: 1,
    scales: [{ id: 'right', side: 'right', ...(expandVisibleTo && { expandVisibleTo }) }],
    layers: layers.map((l, i) => ({ id: `l${i + 1}`, series: 'x', scale: 'right', color: '#111111', ...l })),
  };
}
const data: Record<string, LayerData> = {
  l1: { display: [{ time: '2026-01-02', value: 5 }] },
  l2: { display: [{ time: '2026-01-02', value: -1 }] },
};

test('canLogScale:隐藏的线不挡;被叠加的 A 隐藏了照样挡;下限框撑到 ≤0 也不行', () => {
  expect(canLogScale(pane([{}, {}]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}, { hidden: true }]), 'right', data)).toBe(true);
  const fit = { target: 'l2', start: '2026-01-01', end: '2026-02-01', alpha: 0, beta: 1, r: 1 };
  expect(canLogScale(pane([{ fit }, { hidden: true }]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}], [0, 20]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}], [1, 20]), 'right', data)).toBe(true);
});

test('computeLayerData:事件竖线裁到其它线最早的起点,不把时间轴往左撑', () => {
  const doc = {
    v: 1 as const,
    panes: [pane([{ series: 'spx' }, { series: 'coreCpiRelease', render: { kind: 'events' } }])],
  };
  const pt = (time: string) => ({ time, value: 1 });
  const points = {
    spx: [pt('2020-03-02'), pt('2020-04-01')],
    coreCpiRelease: [pt('2019-12-11'), pt('2020-03-11'), pt('2020-04-10')],
  };
  const out = computeLayerData(doc, points);
  expect(out.l2.display.map((p) => p.time)).toEqual(['2020-03-11', '2020-04-10']);
  expect(out.l1.display.length).toBe(2);
  // 数据没变时再算一遍(文档改了别的,比如颜色):裁剪结果是同一个数组,渲染层不重灌
  const again = computeLayerData({ ...doc }, points);
  expect(again.l2.display).toBe(out.l2.display);
});

describe('layerMarks', () => {
  const base = { id: 'l1', series: 'x', scale: 'right', color: '#111111' };
  // 21 个点 −5 … +5:P5 = −4.5、P95 = 4.5(与常态带 ±2 区分得开)
  const pts = Array.from({ length: 21 }, (_, i) => ({
    time: `2021-01-${String(i + 1).padStart(2, '0')}`,
    value: (i - 10) * 0.5,
  }));

  test('基线和参考线照画;没配分位不出背景带', () => {
    const m = layerMarks(
      { ...base, render: { kind: 'line', baseline: 0 }, refLines: [{ price: 13, title: '警戒' }] },
      pts,
    );
    expect(m.lines).toEqual([
      { price: 0, title: '0' },
      { price: 13, title: '警戒' },
    ]);
    expect(m.band).toBeNull();
  });

  test('只配分位:画 P5 / P95;没给 riskTail 不染背景', () => {
    const m = layerMarks({ ...base, percentile: {} }, pts);
    expect(m.lines).toEqual([
      { price: -4.5, title: 'P5' },
      { price: 4.5, title: 'P95' },
    ]);
    expect(m.band).toBeNull();
  });

  test('分位 + 参考线:线用参考线、不画 P5 / P95,背景照样按分位染(风险端红)', () => {
    const m = layerMarks({ ...base, refLines: normalBand(-2, 2), percentile: { riskTail: 'low' } }, pts);
    expect(m.lines).toEqual(normalBand(-2, 2));
    expect(m.band?.[0]).toMatchObject({ value: 1, color: BAND_RISK }); // 最低值 < P5,低端 = 风险
    expect(m.band?.[20]).toMatchObject({ value: 1, color: BAND_CALM });
    expect(m.band?.[10]).toMatchObject({ value: 1, color: 'rgba(0,0,0,0)' }); // 段内透明
    expect(m.band?.length).toBe(21); // 每个点都有,段外透明
  });

  test('since:只用这天起的点算阈值;比的是平移前的日期;筛空了不画分位线(不出 NaN)', () => {
    const m = layerMarks({ ...base, percentile: { since: '2021-01-11' } }, pts);
    expect(m.lines[0]).toEqual({ price: 0.25, title: 'P5' }); // 0 … 5 共 11 点,P5 = 0.25
    // 往右平移 5 个交易日:画在图上的 01-18 原本是 01-11,窗口按原日期从 01-11 起 = 图上 01-18 起,样本更靠后、P5 更高
    const shifted = layerMarks({ ...base, shift: 5, percentile: { since: '2021-01-11' } }, pts);
    expect(shifted.lines[0].price).toBeGreaterThan(0.25);
    const empty = layerMarks({ ...base, percentile: { since: '2030-01-01' }, refLines: normalBand(-2, 2) }, pts);
    expect(empty).toEqual({ lines: normalBand(-2, 2), band: null });
  });

  test('符号柱恒有 0 线(同固定面板);同一图层 + 同一份点只算一次', () => {
    const signed = { ...base, render: { kind: 'signed' as const } };
    expect(layerMarks(signed, pts).lines).toEqual([{ price: 0, title: '0' }]);
    expect(layerMarks(signed, pts)).toBe(layerMarks(signed, pts));
  });
});
