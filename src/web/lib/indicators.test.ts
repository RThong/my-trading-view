import { describe, test, expect } from 'bun:test';
import { ema, bollinger } from './indicators';
import type { Bar } from './chart';

const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ time: `2026-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c }));

describe('ema', () => {
  test('SMA 起算 + α=2/(n+1) 递推', () => {
    // n=3 → α=0.5;种子 = (1+2+3)/3 = 2;下一根 0.5·4 + 0.5·2 = 3;再下一根 0.5·10 + 0.5·3 = 6.5
    const out = ema(bars([1, 2, 3, 4, 10]), 3);
    expect(out.map((p) => p.value)).toEqual([2, 3, 6.5]);
    expect(out[0].time).toBe('2026-01-03');
  });

  test('数据不足一个周期 → 不出点', () => {
    expect(ema(bars([1, 2]), 3)).toEqual([]);
  });
});

describe('bollinger', () => {
  test('总体标准差 ± k·σ', () => {
    // 窗口 [2,4,4,4,5,5,7,9]:均值 5,总体 σ = 2
    const out = bollinger(bars([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2);
    expect(out).toEqual([{ time: '2026-01-08', upper: 9, mid: 5, lower: 1 }]);
  });

  test('滚动窗口逐根对齐时间', () => {
    const out = bollinger(bars([1, 1, 1, 3]), 3, 2);
    expect(out.map((p) => [p.time, p.mid])).toEqual([
      ['2026-01-03', 1],
      ['2026-01-04', 5 / 3],
    ]);
    expect(out[0].upper).toBe(1); // 常数窗口 σ=0
  });
});
