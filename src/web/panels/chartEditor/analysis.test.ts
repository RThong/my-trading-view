import { describe, expect, test } from 'bun:test';
import {
  alignPairs,
  applyFit,
  fitParams,
  gapPoints,
  lagScan,
  pearson,
  rollingCorr,
  shiftBusinessDays,
  shiftPoints,
  strongestLag,
  transformPairs,
} from './analysis';

const pts = (rows: [string, number][]) => rows.map(([time, value]) => ({ time, value }));

/** 从 start 起连续 n 个交易日,值由 f(i) 给出 */
const weekdays = (start: string, n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ time: shiftBusinessDays(start, i), value: f(i) }));

describe('shiftBusinessDays', () => {
  test('跨周末按交易日数', () => {
    expect(shiftBusinessDays('2026-10-30', 1)).toBe('2026-11-02'); // 周五 +1 = 周一
    expect(shiftBusinessDays('2026-11-02', -1)).toBe('2026-10-30');
    expect(shiftBusinessDays('2026-10-26', 5)).toBe('2026-11-02'); // 一周 = 5 个交易日
    expect(shiftBusinessDays('2026-10-28', 0)).toBe('2026-10-28');
  });

  test('周末日期先顺延到周一', () => {
    expect(shiftBusinessDays('2026-11-01', 0)).toBe('2026-11-02'); // 周日
    expect(shiftBusinessDays('2026-10-31', 1)).toBe('2026-11-03'); // 周六 → 周一 → +1
  });
});

test('shiftPoints:撞到同一天保留后一个,时间不重复', () => {
  const out = shiftPoints(
    pts([
      ['2026-10-31', 1], // 周六 → 周一
      ['2026-11-01', 2], // 周日 → 周一
      ['2026-11-03', 3],
    ]),
    1,
  );
  expect(out).toEqual(
    pts([
      ['2026-11-03', 2],
      ['2026-11-04', 3],
    ]),
  );
});

describe('alignPairs', () => {
  test('以稀疏的一条为基准,另一条取当天或之前最近值', () => {
    const daily = weekdays('2026-08-03', 40, (i) => i);
    const monthly = pts([
      ['2026-09-01', 100],
      ['2026-10-01', 200],
    ]);
    expect(alignPairs(daily, monthly)).toEqual([
      { time: '2026-09-01', a: 21, b: 100 },
      { time: '2026-10-01', a: 39, b: 200 },
    ]);
  });

  test('最近值太旧就跳过', () => {
    const a = pts([
      ['2026-01-05', 1],
      ['2026-06-01', 2],
    ]);
    const b = pts([
      ['2026-01-05', 10],
      ['2026-01-06', 11],
      ['2026-01-07', 12],
    ]);
    expect(alignPairs(a, b).map((p) => p.time)).toEqual(['2026-01-05']);
  });
});

describe('相关性', () => {
  test('pearson:完全正相关 / 反相关 / 无波动', () => {
    const mk = (f: (i: number) => number) => Array.from({ length: 10 }, (_, i) => ({ time: '', a: i, b: f(i) }));
    expect(pearson(mk((i) => 2 * i + 1))).toBeCloseTo(1);
    expect(pearson(mk((i) => -i))).toBeCloseTo(-1);
    expect(pearson(mk(() => 5))).toBeNaN();
  });

  test('transformPairs:正值取对数收益,可负的取差值', () => {
    const pairs = [
      { time: 't0', a: 100, b: -1 },
      { time: 't1', a: 110, b: 0.5 },
    ];
    const [p] = transformPairs(pairs, 'change', 1);
    expect(p.a).toBeCloseTo(Math.log(1.1));
    expect(p.b).toBeCloseTo(1.5);
  });

  test('rollingCorr:点数 = 配对数 − 窗口 + 1', () => {
    const a = weekdays('2026-01-05', 30, (i) => Math.sin(i));
    const b = weekdays('2026-01-05', 30, (i) => Math.sin(i) * 3 + 1);
    const out = rollingCorr(a, b, 10, 'level', 1);
    expect(out).toHaveLength(21);
    out.forEach((p) => {
      expect(p.value).toBeCloseTo(1);
    });
  });

  test('lagScan:b 领先 a 5 天时,最强点落在 lag = 5', () => {
    const wave = (i: number) => Math.sin(i / 4) + Math.sin(i / 9);
    const b = weekdays('2026-01-05', 200, wave);
    const a = weekdays('2026-01-05', 200, (i) => wave(i - 5)); // a 比 b 晚 5 天
    const scan = lagScan(a, b, { minLag: -10, maxLag: 10, mode: 'level', horizon: 1 });
    expect(scan).toHaveLength(21);
    expect(strongestLag(scan)?.lag).toBe(5);
    expect(strongestLag(scan)?.r).toBeCloseTo(1);
  });
});

describe('参照期换算', () => {
  // 黄金 ≈ 2000 − 400 × 实际利率,参照期之后黄金多涨 500
  const real = weekdays('2026-01-05', 60, (i) => Math.sin(i / 5));
  const gold = real.map((p, i) => ({ time: p.time, value: 2000 - 400 * p.value + (i >= 40 ? 500 : 0) }));
  const start = real[0].time;
  const end = real[39].time;

  test('只用参照期求比例,反向关系 beta 为负', () => {
    const fit = fitParams(gold, real, start, end)!;
    expect(fit.beta).toBeCloseTo(-400);
    expect(fit.alpha).toBeCloseTo(2000);
    expect(fit.r).toBeCloseTo(-1);
    expect(fit.n).toBe(40);
  });

  test('劈叉幅度:参照期内 ≈ 0,之后 ≈ 500', () => {
    const fitted = applyFit(real, fitParams(gold, real, start, end)!);
    const gap = gapPoints(gold, fitted);
    expect(gap[10].value).toBeCloseTo(0);
    expect(gap[50].value).toBeCloseTo(500);
  });

  test('参照期样本太少 → null', () => {
    expect(fitParams(gold, real, start, real[5].time)).toBeNull();
  });
});
