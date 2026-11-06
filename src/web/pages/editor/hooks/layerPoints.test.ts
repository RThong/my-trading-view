import { expect, test } from 'bun:test';
import type { Layer, Pane } from '../../../views/chartDoc/chartDoc';
import { canLogScale, computeLayerData, type LayerData } from './layerPoints';

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
