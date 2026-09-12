/**
 * 季度标签 → 日期的共同约定。**季度值一律落在季末**:它代表整个季度,落季初会让图上的点
 * 早三个月出现(2026Q2 的读数画在 4/1,而那天这一季还没过完)。
 *
 * 抽出来是因为第二个消费者出现了(`bojOutputGap` 的 `2026.1Q` 与 `nakajimaJgb` 的 `20262`,
 * 入参格式不同、季末约定相同)。靠两份注释「两边都改才算改」维系的一致性,少改一边就悄悄漂了。
 */
const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'];

/** 年 + 季号(1-4)→ 季末 ISO 日期;季号越界 → null。 */
export function quarterEndIso(year: string, quarter: number): string | null {
  const end = QUARTER_END[quarter - 1];
  return end ? `${year}-${end}` : null;
}
