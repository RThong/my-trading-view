import { expect, test } from 'bun:test';
import { BAND_CALM, BAND_RISK, TRANSPARENT } from './palette';
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

test('percentileMarks:窗口外的点不染色,窗口内照常', () => {
  const inWindow = (time: string) => time >= '2021-01-11';
  const m = percentileMarks(values.slice(10), pts, { riskTail: 'low', inWindow });
  expect(m?.band?.[0].color).toBe(TRANSPARENT); // 2021-01-01 值 -10 远低于窗口 P5,但在窗口外
  expect(m?.band?.[20].color).toBe(BAND_CALM); // 窗口内的高端
  expect(m?.band).toHaveLength(21); // 每个点都有(段外透明),各格按点排位才对得齐
});
