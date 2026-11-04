import { describe, expect, test } from 'bun:test';
import {
  alignPairs,
  bestOverlay,
  findBaseSegment,
  fitParams,
  lagScan,
  pearson,
  shiftBusinessDays,
  shiftPoints,
  strongestLag,
  transformPairs,
} from './analysis';

function pts(rows: [string, number][]) {
  return rows.map(([time, value]) => ({ time, value }));
}

/** 从 start 起连续 n 个交易日,值由 f(i) 给出 */
function weekdays(start: string, n: number, f: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => ({ time: shiftBusinessDays(start, i), value: f(i) }));
}

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
    const [p] = transformPairs(pairs, 1);
    expect(p.a).toBeCloseTo(Math.log(1.1));
    expect(p.b).toBeCloseTo(1.5);
  });

  test('lagScan:b 领先 a 5 天时,最强点落在 lag = 5', () => {
    const wave = (i: number) => Math.sin(i / 4) + Math.sin(i / 9);
    const b = weekdays('2026-01-05', 200, wave);
    const a = weekdays('2026-01-05', 200, (i) => wave(i - 5)); // a 比 b 晚 5 天
    const scan = lagScan(a, b, { lags: Array.from({ length: 21 }, (_, i) => i - 10), horizon: 1 });
    expect(scan).toHaveLength(21);
    expect(strongestLag(scan)?.lag).toBe(5);
    expect(strongestLag(scan)?.r).toBeCloseTo(1);
  });
});

describe('叠加换算', () => {
  // 黄金 ≈ 2000 − 400 × 实际利率,基准段之后黄金多涨 500
  const real = weekdays('2026-01-05', 60, (i) => Math.sin(i / 5));
  const gold = real.map((p, i) => ({ time: p.time, value: 2000 - 400 * p.value + (i >= 40 ? 500 : 0) }));
  const start = real[0].time;
  const end = real[39].time;

  test('只用基准段求比例,反向关系 beta 为负', () => {
    const fit = fitParams(gold, real, start, end)!;
    expect(fit.beta).toBeCloseTo(-400);
    expect(fit.alpha).toBeCloseTo(2000);
    expect(fit.r).toBeCloseTo(-1);
    expect(fit.n).toBe(40);
  });

  test('基准段样本太少 → null', () => {
    expect(fitParams(gold, real, start, real[5].time)).toBeNull();
  });
});

describe('bestOverlay / findBaseSegment', () => {
  // 两条周期叠加 + 趋势,够长(约 4 年),各段涨跌都像
  const wave = (i: number) => Math.sin(i / 7) + Math.sin(i / 23) + i / 100;
  const N = 1000;
  const start = '2020-01-06';
  const view = { from: start, to: shiftBusinessDays(start, N) };
  // 确定性的噪声:同一个 i 总是同一个值
  const noise = (i: number, seed: number) => {
    const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  };

  test('b 领先 a 30 天且反向:先找到偏移,再选段、beta 为负', () => {
    const b = weekdays(start, N, wave);
    const a = weekdays(start, N, (i) => 50 - 3 * wave(i - 30)); // a 比 b 晚 30 天、反向
    const res = bestOverlay(a, b, view);
    if (res.kind !== 'ok') throw new Error('应当叠上');
    expect(res.overlay.lag).toBe(30);
    expect(res.overlay.seg.rc).toBeLessThan(-0.9);
    expect(res.overlay.fit.beta).toBeCloseTo(-3);
  });

  test('同时动的两条不平移', () => {
    const b = weekdays(start, N, wave);
    const a = weekdays(start, N, (i) => 2 * wave(i) + 1);
    const res = bestOverlay(a, b, view);
    expect(res.kind === 'ok' && res.overlay.lag).toBe(0);
  });

  // 「吻合度不比最高差 0.05」会让段尾往断点后多伸一点(这里约 4 个月),但不会把失效段整段吞进去
  test('后 1/3 关系断了:基准段大致停在断开处,不吞掉失效段', () => {
    const cut = 650;
    const b = weekdays(start, N, (i) => wave(i) + noise(i, 1) * 0.3);
    // 断开后 a 改走自己的路(独立噪声 + 反向趋势)
    const a = weekdays(start, N, (i) => (i < cut ? 2 * wave(i) : 2 * wave(cut) - (i - cut) / 30 + noise(i, 2) * 3));
    const { best } = findBaseSegment(a, b, view);
    expect(best).not.toBeNull();
    expect(best!.to <= shiftBusinessDays(start, cut + 120)).toBe(true);
  });

  test('互不相关的两条:找不到段,整段说明涨跌相关不够', () => {
    const b = weekdays(start, N, (i) => 100 + noise(i, 3) * 5 + i / 50);
    const a = weekdays(start, N, (i) => 100 + noise(i, 4) * 5 - i / 80);
    const { best, whole } = findBaseSegment(a, b, view);
    expect(best).toBeNull();
    expect(whole?.fails).toContain('weak');
  });

  test('段越短要求越强:门槛 = max(0.3, 2 / √月数)', () => {
    const b = weekdays(start, N, wave);
    const a = weekdays(start, N, (i) => wave(i) * 2);
    const short = findBaseSegment(a, b, { from: start, to: shiftBusinessDays(start, 252) }).whole!;
    expect(short.need).toBeCloseTo(2 / Math.sqrt(short.months));
    expect(findBaseSegment(a, b, view).whole!.need).toBeCloseTo(0.3);
  });
});
