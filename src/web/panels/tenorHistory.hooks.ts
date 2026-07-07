// 期限走势图数据层:把某一期限的历史序列喂给图,按全局 interval 聚合。
// 纯函数在此,图表实例管理见下方 useTenorChart。
import { aggregate, type LinePoint } from '../lib/chart';
import type { YPoint } from './yieldCurve.hooks';
import type { Interval } from '../hooks/interval';

// 各 source 的默认勾选期限(短/前端/中/长各取锚点)。
// treasury 前端用信息量更大的 2Y;OIS 档位较粗,前端用 1Y。
export const DEFAULT_TENORS: Record<string, string[]> = {
  treasury: ['3M', '1Y', '2Y', '5Y', '10Y', '30Y'],
  sofr_ois: ['3M', '1Y', '10Y', '30Y'],
};

/** 某期限的 {date,value}[] → 图用的 {time,value}[],按 interval 聚合。缺该期限 → []。 */
export function tenorSeriesData(rows: YPoint[] | undefined, interval: Interval): LinePoint[] {
  if (!rows) return [];
  return aggregate(rows.map((p) => ({ time: p.date, value: p.value })), interval);
}

/** 默认勾选:取表内该 source 的期限并过滤到真实可用;无表则回退前 4 个可用期限。 */
export function pickDefaultTenors(source: string, available: string[]): string[] {
  const table = DEFAULT_TENORS[source];
  if (!table) return available.slice(0, 4);
  return table.filter((t) => available.includes(t));
}
