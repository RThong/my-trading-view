import { fetchWithTimeout } from './http';
import { AI_CDS } from '../analytics/rateCurves';

// ICE Clear Credit 免费公开的单名 CDS 每日 EOD 结算价(margining 官方价)。无 auth。
// 只有当日一份快照(无历史)→ 靠每天跑一次积累时间序列。
// instrumentName 形如 ORCLE.SNRFOR.USD.XR14.100.2031-06-20 =
//   代码.高级无抵押.货币.约定.票息bp.到期(5Y IMM,每半年 roll,故不硬编到期)。
const URL = 'https://www.ice.com/api/cds-settlement-prices/icc-single-names';

type IceRow = { clearingDate: string; name: string; instrumentName: string; eodPrice: string | number };
export type CdsPoint = { ticker: string; price: number };
export type CdsSnapshot = { date: string; points: CdsPoint[] };

const TICKERS = new Set(AI_CDS.map((c) => c.ticker));

// 每名取标准 5Y 基准合约:SNRFOR + USD + 100bp 票息。同名若多档到期,取最长到期
// (= on-the-run 5Y,短档是历史残留)。maturity 为 YYYY-MM-DD,字典序即时间序。
export function parseIceCds(rows: IceRow[]): CdsSnapshot {
  let date = '';
  const best = new Map<string, { maturity: string; price: number }>();

  for (const r of rows) {
    const [ticker, tier, ccy, , coupon, maturity] = r.instrumentName.split('.');
    if (!TICKERS.has(ticker) || tier !== 'SNRFOR' || ccy !== 'USD' || coupon !== '100') continue;

    // price<=0 一并挡:Number(null)/Number('') 都得 0,缺价的行会伪装成有效价(→ 约 2228bp 假数据)。
    const price = Number(r.eodPrice);
    if (!Number.isFinite(price) || price <= 0) continue;

    if (!date) date = r.clearingDate;
    const prev = best.get(ticker);
    if (!prev || maturity > prev.maturity) best.set(ticker, { maturity, price });
  }

  return { date, points: [...best].map(([ticker, v]) => ({ ticker, price: v.price })) };
}

export async function fetchIceCds(doFetch = fetchWithTimeout): Promise<CdsSnapshot> {
  // ICE 边缘拦默认 UA,带个浏览器 UA 免 403。
  const res = await doFetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ICE CDS 下载失败:${res.status}`);

  const snap = parseIceCds((await res.json()) as IceRow[]);
  if (!snap.points.length) throw new Error('ICE CDS:名单无匹配合约(端点结构或名单可能变了)');
  return snap;
}
