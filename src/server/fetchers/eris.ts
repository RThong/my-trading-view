import { fetchWithTimeout } from './http';

// Eris(并入 CME)公开的免费 SOFR 结算曲线:官方已 bootstrap 的 par OIS 曲线,24 档含短端。
// 每日 EOD 在 root,历史在 archives/{年}/{MM-月名}/。ParCoupon 的 FairCoupon(%) 即 par OIS 利率。
const ROOT = 'https://files.erisfutures.com/ftp';
const HISTORY_URL = `${ROOT}/Eris_Historical_ParCouponCurve_SOFR.csv`;
const LATEST_URL = `${ROOT}/Eris_Latest_EOD_ParCouponCurve_SOFR.csv`;

export type ErisPoint = { tenor: string; rate: number };
export type ErisCurve = { date: string; points: ErisPoint[] };

const doFetch0 = fetchWithTimeout;

// 宽表:表头 Evaluation Date,SOFR1W,...,SOFR50Y;一行一天。列头去 SOFR 前缀成 tenor。值原样(已是百分点)。
export function parseErisHistorical(csv: string): ErisCurve[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const tenors = header.slice(1).map((h) => h.trim().replace(/^SOFR/, ''));
  return lines.slice(1).flatMap((line) => {
    const c = line.split(',');
    const date = c[0]?.trim();
    if (!date) return [];
    const points = tenors.flatMap((tenor, i) => {
      const raw = c[i + 1]?.trim();
      const rate = Number(raw);
      return raw && Number.isFinite(rate) ? [{ tenor, rate }] : [];
    });
    return points.length ? [{ date, points }] : [];
  });
}

// ponytail: CSV 列固定,按表头定位 Symbol / EvaluationDate / FairCoupon (%) 三列,简单可靠。
export function parseErisParCoupon(csv: string): ErisCurve {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const iSym = header.indexOf('Symbol');
  const iDate = header.indexOf('EvaluationDate');
  const iFair = header.indexOf('FairCoupon (%)');
  if (iSym < 0 || iDate < 0 || iFair < 0) throw new Error('Eris CSV: 缺列(Symbol/EvaluationDate/FairCoupon (%))');

  const points: ErisPoint[] = [];
  let date = '';
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const sym = c[iSym]?.trim();
    const rate = Number(c[iFair]?.trim());
    if (!sym?.startsWith('SOFR') || !Number.isFinite(rate)) continue;
    if (!date) {
      const [m, d, y] = c[iDate].trim().split('/');
      date = `${y}-${m}-${d}`;
    }
    points.push({ tenor: sym.slice(4), rate }); // 去 'SOFR' 前缀
  }
  if (!date) throw new Error('Eris CSV: 无有效数据行');
  return { date, points };
}

export async function fetchErisHistory(doFetch = doFetch0): Promise<ErisCurve[]> {
  const res = await doFetch(HISTORY_URL);
  if (!res.ok) throw new Error(`Eris 全历史下载失败:${res.status}`);
  return parseErisHistorical(await res.text());
}

// 直接拉稳定的 Latest 别名,不必列目录找最大日期。
export async function fetchLatestEris(doFetch = doFetch0): Promise<ErisCurve> {
  const res = await doFetch(LATEST_URL);
  if (!res.ok) throw new Error(`Eris 最新文件下载失败:${res.status}`);
  return parseErisParCoupon(await res.text());
}
