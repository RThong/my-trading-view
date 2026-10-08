import { describe, test, expect } from 'bun:test';
import { ema, bollinger, macd, rsi } from './indicators';
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

describe('macd', () => {
  test('DIF = EMA快 − EMA慢,DEA = DIF 的 EMA,柱 = 2·(DIF − DEA)', () => {
    const bs = bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = macd(bs, 2, 3, 2);
    const e2 = new Map(ema(bs, 2).map((p) => [p.time, p.value]));
    const e3 = new Map(ema(bs, 3).map((p) => [p.time, p.value]));
    // 慢线从第 3 根起、DEA 再要 2 根 DIF 预热 → 首点在第 4 根
    expect(out[0].time).toBe('2026-01-04');
    for (const p of out) {
      expect(p.dif).toBeCloseTo(e2.get(p.time)! - e3.get(p.time)!, 12);
      expect(p.hist).toBeCloseTo(2 * (p.dif - p.dea), 12);
    }
  });
});

describe('rsi', () => {
  test('Wilder 平滑:种子取前 n 个涨跌的均值,之后 (prev·(n−1) + 新值)/n', () => {
    // 涨跌序列 +1 −1 +2;n=2:种子 up=0.5 down=0.5 → 50;下一步 up=(0.5+2)/2=1.25 down=0.25 → 100−100/6
    const out = rsi(bars([10, 11, 10, 12]), 2);
    expect(out.map((p) => p.time)).toEqual(['2026-01-03', '2026-01-04']);
    expect(out[0].value).toBeCloseTo(50, 12);
    expect(out[1].value).toBeCloseTo(100 - 100 / 6, 12);
  });

  test('只涨不跌 → 100;数据不足 → 不出点', () => {
    expect(rsi(bars([1, 2, 3, 4]), 2).every((p) => p.value === 100)).toBe(true);
    expect(rsi(bars([1, 2]), 2)).toEqual([]);
  });
});
