// 分位相关纯函数(前端读时算,输入无需预排序)。

/** 第 p 百分位(p ∈ [0,100]),排序后线性插值。空数组 → NaN。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** x 在 values 中的百分位排名(0–100,整数)。中点法处理并列。空数组 → NaN。 */
export function percentileRank(values: number[], x: number): number {
  if (values.length === 0) return NaN;
  const below = values.filter((v) => v < x).length;
  const equal = values.filter((v) => v === x).length;
  return Math.round(((below + equal / 2) / values.length) * 100);
}
