// CFTC 持仓(COT):日元期货非商业净持仓(拥挤度/carry 平仓领先信号)。官方 Socrata,免费,周频。
import { fetchWithTimeout } from './http';

type CotRow = { report_date_as_yyyy_mm_dd?: string; noncomm_positions_long_all?: string; noncomm_positions_short_all?: string };

/** Socrata 行 → {date(ISO), net=多−空},升序。 */
export function cotToNet(rows: CotRow[]): { date: string; value: number }[] {
  return rows
    .map((r) => ({
      date: (r.report_date_as_yyyy_mm_dd ?? '').slice(0, 10),
      value: Number(r.noncomm_positions_long_all) - Number(r.noncomm_positions_short_all),
    }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const CFTC_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const JPY_CODE = '097741'; // JAPANESE YEN - CME

export async function fetchCftcJpyNet(since = '2018-01-01'): Promise<{ date: string; value: number }[]> {
  const params = new URLSearchParams({
    cftc_contract_market_code: JPY_CODE,
    '$select': 'report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all',
    '$where': `report_date_as_yyyy_mm_dd >= '${since}'`,
    '$order': 'report_date_as_yyyy_mm_dd ASC',
    '$limit': '5000',
  });
  const rows = (await fetchWithTimeout(`${CFTC_URL}?${params}`).then((r) => r.json())) as CotRow[];
  return cotToNet(rows);
}
