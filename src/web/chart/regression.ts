// 画线「回归通道」的纯计算:一段数据对横坐标(图上的逻辑下标)做最小二乘直线拟合。渲染与交互见 drawings / 编辑器 useDrawings。

export type Regression = {
  slope: number;
  intercept: number;
  /**
   * 残差的样本标准差(除以 n - 1):上下轨 = 中线 ± 2 倍它。同 TradingView:2026-11-11 在演示页量通道宽度,
   * 49.51 / 4 = 12.378,样本口径 12.397、总体口径 12.284 —— 吻合样本口径
   */
  sd: number;
  /** 皮尔逊相关系数;y 全相同(水平一条线)时没有意义 → null */
  r: number | null;
};

/** 回归中线在横坐标 x 处的值 */
export function regressionAt(g: Regression, x: number): number {
  return g.intercept + g.slope * x;
}

/** 少于两个点、或横坐标全相同(拟合不出斜率)→ null */
export function linearRegression(points: { x: number; y: number }[]): Regression | null {
  const n = points.length;
  if (n < 2) return null;

  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const syy = points.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const sxy = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const g = { slope, intercept, sd: 0, r: syy === 0 ? null : sxy / Math.sqrt(sxx * syy) };
  const sse = points.reduce((s, p) => s + (p.y - regressionAt(g, p.x)) ** 2, 0);

  return { ...g, sd: Math.sqrt(sse / (n - 1)) };
}
