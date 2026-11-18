import { expect, test } from 'bun:test';
import { axisUnit, fmtTick, linearTicks, logTicks, textOn } from './axisDecor';

test('轴单位:上万 ×1,000、上千万 ×1M,更小不缩', () => {
  expect(axisUnit(9_999)).toBeUndefined();
  expect(axisUnit(24_000)).toEqual({ div: 1e3, label: '×1,000' });
  expect(axisUnit(3e7)).toEqual({ div: 1e6, label: '×1M' });
});

test('刻度:线性按 1/2/5 步长;对数每个数量级取 1/2/5,太密只取 1,窄到一个数量级内退回线性', () => {
  expect(linearTicks(20, 120, 5)).toEqual([20, 40, 60, 80, 100, 120]);
  expect(linearTicks(0.3, 0.9, 3)).toEqual([0.4, 0.6, 0.8]);
  expect(logTicks(2, 600, 20)).toEqual([2, 5, 10, 20, 50, 100, 200, 500]);
  expect(logTicks(2, 600, 4)).toEqual([10, 100]);
  expect(logTicks(3, 9, 3)).toEqual(linearTicks(3, 9, 3));
  expect(fmtTick(24)).toBe('24');
  expect(fmtTick(2.375)).toBe('2.38');
});

test('色块字色:深色底白字、浅色底黑字(同图表库原生标签);认不出的颜色退回白字', () => {
  expect(textOn('#f05a14')).toBe('#ffffff');
  expect(textOn('#1d3fd6')).toBe('#ffffff');
  expect(textOn('#facc15')).toBe('#000000');
  expect(textOn('#a3e635')).toBe('#000000');
  expect(textOn('red')).toBe('#ffffff');
});
