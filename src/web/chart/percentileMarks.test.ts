import { expect, test } from 'bun:test';
import { BAND_CALM, BAND_RISK } from './palette';
import { percentileMarks } from './percentileMarks';

const pts = Array.from({ length: 21 }, (_, i) => ({
  time: `2021-01-${String(i + 1).padStart(2, '0')}`,
  value: i - 10,
}));
const values = pts.map((p) => p.value);

test('percentileMarks:没参考线画 P5 / P95;有参考线用参考线;没 riskTail 不染;窗口为空返回 null', () => {
  expect(percentileMarks(values, pts, {})).toEqual({
    lines: [
      { price: -9, title: 'P5' },
      { price: 9, title: 'P95' },
    ],
    band: null,
  });
  const ref = [{ price: 2, title: '上限' }];
  const m = percentileMarks(values, pts, { refLines: ref, riskTail: 'high' });
  expect(m?.lines).toBe(ref);
  expect(m?.band?.[0].color).toBe(BAND_CALM); // 低端在 riskTail='high' 下是机会端
  expect(m?.band?.[20].color).toBe(BAND_RISK);
  expect(percentileMarks([], pts, { riskTail: 'low' })).toBeNull();
});
