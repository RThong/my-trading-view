import { fetchWithTimeout } from './http';
import type { Point } from '../analytics/regime';
import { HISTORY_START_DATE } from '../config';

// 美国财政部每日 par yield 直发源(当天收盘即出,比 FRED DGS 快 1-2 天)。按年一个 CSV,无需 key。
// FRED 的 DGS 本就是搬这份数据,数值一致,只是 FRED 收录慢一两天 → 直接用源头拿当天。
const CSV = (year: number) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;

// 财政部列名 → 本项目期限标签。只取标准 11 档(各年新增的 1.5Mo/2Mo/4Mo 等额外档忽略)。
const COL_TO_TENOR: Record<string, string> = {
  '1 Mo': '1M',
  '3 Mo': '3M',
  '6 Mo': '6M',
  '1 Yr': '1Y',
  '2 Yr': '2Y',
  '3 Yr': '3Y',
  '5 Yr': '5Y',
  '7 Yr': '7Y',
  '10 Yr': '10Y',
  '20 Yr': '20Y',
  '30 Yr': '30Y',
};

// 期限展示顺序(= 曲线 x 轴)。直接派生自上表的值顺序,避免两张平行表 desync。
export const UST_TENORS = Object.values(COL_TO_TENOR);

// 解析一年 CSV → {tenor: Point[]}。列按表头名定位(各年列集不同,不能靠下标)。
// 日期 MM/DD/YYYY → YYYY-MM-DD;空格子 / 非数跳过(假日某档可能缺)。
export function parseTreasuryPar(csv: string): Record<string, Point[]> {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const cols = header.flatMap((name, i) => (COL_TO_TENOR[name] ? [{ i, tenor: COL_TO_TENOR[name] }] : []));

  const out: Record<string, Point[]> = {};
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const [m, d, y] = c[0].split('/');
    if (!y) continue;
    const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

    for (const { i, tenor } of cols) {
      const raw = c[i]?.trim();
      const v = Number(raw);
      if (!raw || !Number.isFinite(v)) continue;
      out[tenor] ??= [];
      out[tenor].push({ date, value: v });
    }
  }
  return out;
}

// 拉 HISTORY_START_DATE 那年 → 今年各年并行,合并同期限并按日期升序。单年失败跳过(优雅降级)。
export async function fetchTreasuryCurve(doFetch = fetchWithTimeout): Promise<Record<string, Point[]>> {
  const startYear = Number(HISTORY_START_DATE.slice(0, 4));
  const endYear = new Date().getUTCFullYear();
  const years = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i);
  const settled = await Promise.allSettled(
    years.map(async (y) => {
      const res = await doFetch(CSV(y), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`UST ${y}: ${res.status}`);
      return parseTreasuryPar(await res.text());
    }),
  );

  const merged: Record<string, Point[]> = {};
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const [tenor, pts] of Object.entries(s.value)) {
      merged[tenor] ??= [];
      merged[tenor].push(...pts);
    }
  }
  for (const pts of Object.values(merged)) pts.sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}
