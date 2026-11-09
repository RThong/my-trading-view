import { expect, test } from 'bun:test';
import { magnet } from './magnet';
import type { PointCtx } from './types';

// 数值 v 画在 y = 1000 - v;光标在 y = 506(数值 494):最近的是 480(14px,唯一最近,510 离 16px),超出弱磁吸半径
const base: PointCtx = {
  x: 0,
  y: 506,
  bar: { time: '2026-03-13', values: [480, 520, 470, 510] },
  toY: (v) => 1000 - v,
  anchor: null,
  shift: false,
  onlyTime: false,
  dragging: false,
};
const p = { time: '2026-03-14', value: 494 };

test('强磁吸:画线时总是吸;拖已有的线时按弱磁吸(远了不吸,跟手)', () => {
  expect(magnet.apply(p, base, 'strong')).toEqual({ time: '2026-03-13', value: 480 });
  expect(magnet.apply(p, { ...base, dragging: true }, 'strong')).toBe(p);
  expect(magnet.apply(p, { ...base, dragging: true, y: 515 }, 'strong')).toEqual({ time: '2026-03-13', value: 480 });
});

test('只用日期的线:不管强弱、拖不拖,只对齐日期', () => {
  expect(magnet.apply(p, { ...base, onlyTime: true, dragging: true }, 'weak')).toEqual({
    time: '2026-03-13',
    value: 494,
  });
});
