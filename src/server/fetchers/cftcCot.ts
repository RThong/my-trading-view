// CFTC 持仓(COT):日元期货净持仓(Legacy 口径) + VIX 期货净持仓(TFF 口径)。官方 Socrata,免费,周频。
import type { Point } from '../analytics/regime';
import { fetchWithTimeout } from './http';

type CotRow = {
  report_date_as_yyyy_mm_dd?: string;
  noncomm_positions_long_all?: string;
  noncomm_positions_short_all?: string;
};

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
    $select: 'report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all',
    $where: `report_date_as_yyyy_mm_dd >= '${since}'`,
    $order: 'report_date_as_yyyy_mm_dd ASC',
    $limit: '5000',
  });
  const rows = (await fetchWithTimeout(`${CFTC_URL}?${params}`).then((r) => r.json())) as CotRow[];
  return cotToNet(rows);
}

// ── VIX 期货持仓(TFF 口径)。与上面日元的 Legacy 口径不是同一个 dataset。
type TffRow = {
  report_date_as_yyyy_mm_dd?: string;
  asset_mgr_positions_long?: string;
  asset_mgr_positions_short?: string;
  lev_money_positions_long?: string;
  lev_money_positions_short?: string;
  open_interest_all?: string;
};

/** TFF 行 → 两条 {date, value=净持仓占 OI 的 %},升序。
 *
 * ⚠️ 归一化到 OI 不是美观问题:VIX 期货 OI 在 20.8 万~65.4 万张之间摆(2018 年均 46 万、
 * 2020 年均 30 万、2026 年均 38 万 —— 无趋势但 3 倍摆幅),裸净持仓的历史分位读的是
 * 「当时市场多大」而不是「持仓多极端」。 */
export function tffToNetOi(rows: TffRow[]): { assetMgr: Point[]; levMoney: Point[] } {
  const parsed = rows
    .map((r) => {
      const oi = Number(r.open_interest_all);
      const pct = (long?: string, short?: string) => ((Number(long) - Number(short)) / oi) * 100;

      return {
        date: (r.report_date_as_yyyy_mm_dd ?? '').slice(0, 10),
        oi,
        assetMgr: pct(r.asset_mgr_positions_long, r.asset_mgr_positions_short),
        levMoney: pct(r.lev_money_positions_long, r.lev_money_positions_short),
      };
    })
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.oi > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const pick = (k: 'assetMgr' | 'levMoney') =>
    parsed.filter((p) => Number.isFinite(p[k])).map((p) => ({ date: p.date, value: p[k] }));

  return { assetMgr: pick('assetMgr'), levMoney: pick('levMoney') };
}

const CFTC_TFF_URL = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
const VIX_CODE = '1170E1'; // VIX FUTURES - CBOE FUTURES EXCHANGE

export async function fetchCftcVixNetOi(since = '2018-01-01'): Promise<{ assetMgr: Point[]; levMoney: Point[] }> {
  const params = new URLSearchParams({
    cftc_contract_market_code: VIX_CODE,
    $select:
      'report_date_as_yyyy_mm_dd,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short,open_interest_all',
    $where: `report_date_as_yyyy_mm_dd >= '${since}'`,
    $order: 'report_date_as_yyyy_mm_dd ASC',
    $limit: '5000',
  });

  const rows = (await fetchWithTimeout(`${CFTC_TFF_URL}?${params}`).then((r) => r.json())) as TffRow[];

  return tffToNetOi(rows);
}
