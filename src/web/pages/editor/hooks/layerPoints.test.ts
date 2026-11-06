import { expect, test } from 'bun:test';
import type { Layer, Pane } from '../../../views/chartDoc/chartDoc';
import { canLogScale, type LayerData } from './layerPoints';

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
