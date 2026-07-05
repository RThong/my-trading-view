import { test, expect } from 'bun:test';
import { percentile, percentileRank } from './stats';

test('percentile:端点与中位', () => {
  const v = [1, 2, 3, 4, 5];
  expect(percentile(v, 0)).toBe(1);
  expect(percentile(v, 100)).toBe(5);
  expect(percentile(v, 50)).toBe(3);
});

test('percentile:插值中间值', () => {
  // idx = 0.1*(5-1) = 0.4 → 1 + (2-1)*0.4
  expect(percentile([1, 2, 3, 4, 5], 10)).toBeCloseTo(1.4);
});

test('percentile:未排序输入也正确', () => {
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
});

test('percentileRank:最小/中间/最大', () => {
  const v = [1, 2, 3, 4, 5];
  expect(percentileRank(v, 1)).toBe(10);  // (0 + 0.5)/5
  expect(percentileRank(v, 3)).toBe(50);  // (2 + 0.5)/5
  expect(percentileRank(v, 5)).toBe(90);  // (4 + 0.5)/5
});

test('percentileRank:范围外', () => {
  expect(percentileRank([1, 2, 3], 0)).toBe(0);
  expect(percentileRank([1, 2, 3], 9)).toBe(100);
});

test('空数组 → NaN', () => {
  expect(percentile([], 50)).toBeNaN();
  expect(percentileRank([], 1)).toBeNaN();
});
