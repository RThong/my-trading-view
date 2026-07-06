// 收益曲线视角数据层:拉 11 期限 FRED 序列 + 纯粹的日期解析逻辑。
// 图表(SVG)与展示壳在 YieldCurveChart/YieldCurvePanel;这里只管取数与"取某日的一条曲线"。
import useSWR from 'swr';

export type YPoint = { date: string; value: number };
export type YieldCurveData = { tenors: string[]; series: Record<string, YPoint[]>; unavailable: string[] };

const NO_DATA: YieldCurveData = { tenors: [], series: {}, unavailable: [] };
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

// ── 纯函数(可单测)────────────────────────────────────────────────

/** 序列里 date ≤ target 的最近一个值(FRED 周末/假日/滞后当天无值,一律往前贴)。无则 null。 */
export function valueAt(rows: YPoint[] | undefined, target: string): number | null {
  if (!rows) return null;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date <= target) return rows[i].value;
  return null;
}

/** 取某目标日期对应的一条曲线:逐期限往前贴。缺该期限的点则留 null(曲线在此断开)。 */
export function curveForDate(series: Record<string, YPoint[]>, tenors: string[], target: string): (number | null)[] {
  return tenors.map((t) => valueAt(series[t], target));
}

/** 所有期限观测日的并集,升序。用于把任意目标日期贴到一个真实交易日。 */
export function unionDatesAsc(series: Record<string, YPoint[]>): string[] {
  const set = new Set<string>();
  for (const rows of Object.values(series)) for (const p of rows) set.add(p.date);
  return [...set].sort();
}

/** 把目标日期贴到 ≤ 它的最近一个真实交易日(datesAsc 升序)。无则 null。 */
export function snapToTradingDay(datesAsc: string[], target: string): string | null {
  for (let i = datesAsc.length - 1; i >= 0; i--) if (datesAsc[i] <= target) return datesAsc[i];
  return null;
}

/** 从基准日往前推:天/月/年。返回 YYYY-MM-DD。
 *  减月/年时先归到 1 号再减,最后把"号"按目标月天数 clamp,避免月末/闰日溢出
 *  (如 3-31 减 1 月直接 setUTCMonth 会跳到 3-3;2-29 减 1 年会跳到 3-1)。 */
export function shiftDate(iso: string, opt: { days?: number; months?: number; years?: number }): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (opt.days) d.setUTCDate(d.getUTCDate() - opt.days);

  if (opt.months || opt.years) {
    const day = d.getUTCDate();
    d.setUTCDate(1); // 先归 1 号,月份运算不会溢出到下个月
    if (opt.years) d.setUTCFullYear(d.getUTCFullYear() - opt.years);
    if (opt.months) d.setUTCMonth(d.getUTCMonth() - opt.months);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, daysInMonth));
  }

  return d.toISOString().slice(0, 10);
}

// 预置时间点(基于数据里最新那天,不是墙上时钟,避免踩周末/假日)。
export const PRESETS: { label: string; shift: { days?: number; months?: number; years?: number } }[] = [
  { label: 'Current', shift: {} },
  { label: 'Yesterday', shift: { days: 1 } },
  { label: '1 week ago', shift: { days: 7 } },
  { label: '1 month ago', shift: { months: 1 } },
  { label: '1 year ago', shift: { years: 1 } },
];

/** 预置项 → 贴到真实交易日的日期(datesAsc 升序,maxDate 为最新数据日)。 */
export function presetDates(maxDate: string, datesAsc: string[]): { label: string; date: string }[] {
  return PRESETS.flatMap(({ label, shift }) => {
    const snapped = snapToTradingDay(datesAsc, shiftDate(maxDate, shift));
    return snapped ? [{ label, date: snapped }] : [];
  });
}

// ── Hook ──────────────────────────────────────────────────────────

export function useYieldCurve(source: string) {
  const { data = NO_DATA, error, isLoading } = useSWR(`/api/yield-curve?source=${source}`, getJson<YieldCurveData>, SWR_OPTS);
  const datesAsc = unionDatesAsc(data.series);
  const maxDate = datesAsc[datesAsc.length - 1];
  return {
    data,
    isLoading,
    error: error as Error | undefined,
    datesAsc,
    maxDate,
    presets: maxDate ? presetDates(maxDate, datesAsc) : [],
  };
}
