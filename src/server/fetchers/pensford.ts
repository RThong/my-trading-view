import { fetchWithTimeout } from './http';

// Pensford(swap 顾问)公开的免费日更快照,唯一免费的 SOFR OIS / Fed Funds 期货 / Term SOFR 源。
// 只有当天一张快照,无历史 —— 靠 daily job 逐日存库攒历史。
const PENSFORD_URL = 'https://19621209.fs1.hubspotusercontent-na1.net/hubfs/19621209/quotes.xml';

export type PensfordQuote = { symbol: string; value: number };
export type PensfordSnapshot = { quoteDate: string; quotes: PensfordQuote[] };

// ponytail: 正则解析,结构固定(<record><symbol/><quote/></record>),不值得引 XML DOM 依赖。
export function parsePensfordXml(xml: string): PensfordSnapshot {
  // Pensford timeStamp 为美式 MM/DD/YYYY;stamp[1]=月 stamp[2]=日 stamp[3]=年
  const stamp = xml.match(/timeStamp="(\d{2})\/(\d{2})\/(\d{4})/);
  if (!stamp) throw new Error('Pensford XML: 找不到 timeStamp');
  const quoteDate = `${stamp[3]}-${stamp[1]}-${stamp[2]}`;

  const quotes = [...xml.matchAll(/<record>([\s\S]*?)<\/record>/g)].flatMap((m) => {
    const sym = m[1].match(/<symbol>([^<]*)<\/symbol>/)?.[1]?.trim();
    const raw = m[1].match(/<quote>([^<]*)<\/quote>/)?.[1]?.trim();
    const value = Number(raw);
    return sym && raw && Number.isFinite(value) ? [{ symbol: sym, value }] : [];
  });

  return { quoteDate, quotes };
}

export async function fetchPensfordQuotes(
  doFetch: (url: string) => Promise<Response> = fetchWithTimeout,
): Promise<PensfordSnapshot> {
  const res = await doFetch(PENSFORD_URL);
  if (!res.ok) throw new Error(`Pensford 请求失败:${res.status}`);
  return parsePensfordXml(await res.text());
}
