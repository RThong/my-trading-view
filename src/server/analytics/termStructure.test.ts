import { describe, test, expect } from 'bun:test';
import { computeSpread } from './termStructure';

describe('computeSpread', () => {
  test('inner joins on date and computes vx1 - vx3', () => {
    const vx1 = [
      { date: '2026-06-01', value: 20.0 },
      { date: '2026-06-02', value: 19.0 }, // 6-02 VX3 缺 → 丢弃
    ];
    const vx3 = [
      { date: '2026-06-01', value: 18.5 },
      { date: '2026-05-31', value: 18.0 }, // 5-31 VX1 缺 → 丢弃
    ];
    expect(computeSpread(vx1, vx3)).toEqual([
      { date: '2026-06-01', vx1: 20.0, vx3: 18.5, spread: 1.5 },
    ]);
  });

  test('empty inputs → empty', () => {
    expect(computeSpread([], [])).toEqual([]);
  });
});
