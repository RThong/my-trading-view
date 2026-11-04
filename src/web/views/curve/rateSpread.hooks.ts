// 利率利差数据层:两条期限序列按日期对齐相减(long − short)。纯函数,便于单测。
import { valueAt, type YPoint } from './yieldCurve.hooks';

/** long − short,按 long 的日期逐点取 short 向前贴的值相减。
 *  short 在该日前无观测(贴不到)→ 跳过该点(不产出 NaN);任一序列缺失 → []。 */
export function spreadSeries(longRows: YPoint[] | undefined, shortRows: YPoint[] | undefined): YPoint[] {
  if (!longRows || !shortRows) return [];
  return longRows.flatMap((p) => {
    const s = valueAt(shortRows, p.date);
    return s == null ? [] : [{ date: p.date, value: p.value - s }];
  });
}
