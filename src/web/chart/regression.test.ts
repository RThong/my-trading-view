import { describe, expect, test } from 'bun:test';
import { linearRegression, regressionAt } from './regression';

describe('linearRegression', () => {
  test('正好在一条直线上:斜率 / 截距精确,残差标准差 0,r = 1', () => {
    const g = linearRegression([0, 1, 2, 3].map((x) => ({ x, y: 10 + 2 * x })));
    expect(g?.slope).toBeCloseTo(2);
    expect(g?.intercept).toBeCloseTo(10);
    expect(g?.sd).toBeCloseTo(0);
    expect(g?.r).toBeCloseTo(1);
  });

  test('带噪声:残差标准差按样本算(除以 n - 1,同 TradingView);向下的趋势 r 为负', () => {
    // 手算:均值 (1.5, 1.5),sxy = -7、sxx = 5 → 斜率 -1.4,截距 3.6
    const g = linearRegression([
      { x: 0, y: 4 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: -1 },
    ]);
    expect(g && regressionAt(g, 0)).toBeCloseTo(3.6);
    expect(g?.slope).toBeCloseTo(-1.4);
    expect(g?.r).toBeLessThan(0);
    // 残差 0.4 / -1.2 / 1.2 / -0.4,平方和 3.2,除以 n - 1 = 3
    expect(g?.sd).toBeCloseTo(Math.sqrt(3.2 / 3));
  });

  test('少于两点、横坐标全相同 → null;y 全相同 r 为 null', () => {
    expect(linearRegression([{ x: 0, y: 1 }])).toBeNull();
    expect(
      linearRegression([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
      ]),
    ).toBeNull();
    expect(
      linearRegression([
        { x: 0, y: 5 },
        { x: 1, y: 5 },
      ])?.r,
    ).toBeNull();
  });
});
