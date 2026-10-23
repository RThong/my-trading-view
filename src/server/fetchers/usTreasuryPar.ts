import { fetchWithTimeout } from './http';
import type { Point } from '../analytics/regime';
import { HISTORY_START_DATE } from '../config';

// 美国财政部每日曲线直发源(当天收盘即出,比 FRED 快 1-2 天)。按年一个 CSV,无需 key。
// FRED 的 DGS(名义)/ DFII(TIPS 实际)本就是搬这两张表(经 H.15),数值一致,只是固定晚一个工作日。
const CSV = (year: number, type: string) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&_format=csv`;

// 名义 par yield:财政部列名 → 本项目期限标签。只取标准 11 档(各年新增的 1.5Mo/2Mo/4Mo 等额外档忽略)。
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

// TIPS 实际收益率(real yield curve):只有 5 档,表头是全大写「5 YR」,与名义表不同。
// 短端止于 5Y(TIPS 无流动短端)。2018 年 CSV 首行 01/02/2018 即有数。
const REAL_COL_TO_TENOR: Record<string, string> = {
  '5 YR': '5Y',
  '7 YR': '7Y',
  '10 YR': '10Y',
  '20 YR': '20Y',
  '30 YR': '30Y',
};

// 期限展示顺序(= 曲线 x 轴)。直接派生自上表的值顺序,避免两张平行表 desync。
export const UST_TENORS = Object.values(COL_TO_TENOR);
export const UST_REAL_TENORS = Object.values(REAL_COL_TO_TENOR);

// 解析一年 CSV → {tenor: Point[]}。列按表头名定位(各年列集不同,不能靠下标)。
// 日期 MM/DD/YYYY → YYYY-MM-DD;空格子 / 非数跳过(假日某档可能缺)。
export function parseTreasuryPar(csv: string, colToTenor = COL_TO_TENOR): Record<string, Point[]> {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const cols = header.flatMap((name, i) => (colToTenor[name] ? [{ i, tenor: colToTenor[name] }] : []));

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

// 拉 HISTORY_START_DATE 那年 → 今年各年并行,合并同期限并按日期升序。
// **任一年失败即整体抛**,不跳过:跳过的话缺一段(或缺今年 = 曲线停在去年底)的结果看上去仍然「齐全」,
// 会被路由缓存当完整结果存 6h 并写盘。整体抛则由调用方降级 —— yield-curve / regime 都会拿上一份成功值顶上。
async function fetchCurve(
  type: string,
  colToTenor: Record<string, string>,
  label: string,
  doFetch: typeof fetchWithTimeout,
  now: Date,
): Promise<Record<string, Point[]>> {
  const startYear = Number(HISTORY_START_DATE.slice(0, 4));
  const endYear = now.getUTCFullYear();
  // 1 月上旬今年可能还没有交易日;取 10 号留出元旦假期余量
  const isEarlyJan = now.getUTCMonth() === 0 && now.getUTCDate() <= 10;
  const years = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i);
  const perYear = await Promise.all(
    years.map(async (y) => {
      const res = await doFetch(CSV(y, type), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`${label} ${y}: ${res.status}`);

      // 没有数据的年份财政部回 200 + 空 body:只在 1 月上旬放过今年。
      // 其余空 body / HTML 错误页(一档都解析不出)一律当失败 —— 只看 HTTP 200 会让缺段结果冒充完整被缓存。
      // 单档缺(如某档表头改名)不在这里抛,交给调用方把那一档归 unavailable,别让一档拖垮整条曲线。
      const csv = await res.text();
      if (!csv.trim() && y === endYear && isEarlyJan) return {};
      const parsed = parseTreasuryPar(csv, colToTenor);
      if (!Object.keys(parsed).length) throw new Error(`${label} ${y}: 无数据`);
      return parsed;
    }),
  );

  const merged: Record<string, Point[]> = {};
  for (const parsed of perYear) {
    for (const [tenor, pts] of Object.entries(parsed)) {
      merged[tenor] ??= [];
      merged[tenor].push(...pts);
    }
  }
  for (const pts of Object.values(merged)) pts.sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

/** 名义 par yield 曲线(11 档)。 */
export const fetchTreasuryCurve = (doFetch = fetchWithTimeout, now = new Date()) =>
  fetchCurve('daily_treasury_yield_curve', COL_TO_TENOR, 'UST', doFetch, now);

/** TIPS 实际收益率曲线(5Y–30Y 共 5 档),= FRED DFII 同值但早一个工作日。 */
export const fetchTreasuryRealCurve = (doFetch = fetchWithTimeout, now = new Date()) =>
  fetchCurve('daily_treasury_real_yield_curve', REAL_COL_TO_TENOR, 'UST real', doFetch, now);
