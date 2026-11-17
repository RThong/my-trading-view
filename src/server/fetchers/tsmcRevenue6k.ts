import { fetchWithTimeout } from './http';
import { get, type FetchFn } from './sec6k';

/**
 * 台积电月营收的第二个源:每月 10 日前后交给 SEC 的营收公告 6-K(「TSMC <月> <年> Revenue Report」)。
 *
 * 为什么要它:TWSE 月营收接口是快照型,只给最新一个月(连带上月、去年当月),历史页 MOPS 有反爬
 * (见 fetchers/twseRevenue)。job 漏跑两个月以上就永久缺一段 —— 2025-11 ~ 2026-04 就这么缺过。
 * 这份公告和 TWSE 是同一个数,2016 年起格式统一,EDGAR 上随时能重拉。
 *
 * 单位:**百万新台币,取整到百万**(TWSE 是千元)。所以调用方只拿它补缺月,不覆盖 TWSE 已有的点。
 * 2015 年及更早的公告用的是另一套措辞(sales、母公司 / 合并分报),不解析。
 */

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export type RevenueReport = {
  /** 公告所报那个月的月末(YYYY-MM-DD) */
  monthEnd: string;
  /** 当月 / 上月 / 去年当月营收,百万新台币 */
  revenue: number;
  prevRevenue: number;
  lastYearRevenue: number;
  /** 公告给的同比(%),一位小数 */
  yoyPct: number;
  accn: string;
};

function monthEnd(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

// 「(16.1 )」= −16.1;「15.0」= 15.0
function pct(raw: string): number {
  const neg = raw.includes('(');
  const n = Number(raw.replace(/[()\s]/g, ''));
  return neg ? -n : n;
}

function num(raw: string) {
  return Number(raw.replace(/,/g, ''));
}

/**
 * 从公告正文(去掉标签后的纯文本)解析。不是营收公告 / 版式对不上 → null。
 * 表格那一行形如「Net Revenue(s) 当月 上月 (环比%) 去年当月 (同比%) 年初至今 …」。
 */
export function parseRevenueReport(text: string, accn: string): RevenueReport | null {
  const head = new RegExp(`TSMC\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\s+Revenue Report`, 'i').exec(text);
  const row = /Net Revenues?\s+([\d,]+)\s+([\d,]+)\s+(\(?\s*-?[\d.]+\s*\)?)\s+([\d,]+)\s+(\(?\s*-?[\d.]+\s*\)?)/.exec(
    text,
  );
  // 单位不是百万新台币就不认:换了单位会静默写进差三个数量级的数
  if (!head || !row || !/NT\$\s*million/i.test(text)) return null;

  const month = MONTHS.findIndex((m) => m.toLowerCase() === head[1].toLowerCase()) + 1;
  const [revenue, prevRevenue, lastYearRevenue] = [row[1], row[2], row[4]].map(num);
  const yoyPct = pct(row[5]);
  if (![revenue, prevRevenue, lastYearRevenue].every((v) => Number.isFinite(v) && v > 0) || !Number.isFinite(yoyPct))
    return null;

  return { monthEnd: monthEnd(Number(head[2]), month), revenue, prevRevenue, lastYearRevenue, yoyPct, accn };
}

// 去标签 + 解码实体。数字实体(&#160; / &#xA0;)要真解码:2019-10 那份的数字之间是 &#xA0;,不解码整行认不出;
// 2020-07 那份同比写成全角括号「（12.3）」
const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', ndash: '–', mdash: '—', lt: '<', gt: '>', quot: '"' };
export function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\s\u00a0]+/g, ' ');
}

type Recent = { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[] };

/**
 * since 起申报的营收公告,按月升序。2023-04 前文件名不带 revenue、认不出,只能逐份看正文:
 * 每个申报月按日期顺序看,认出营收公告就跳过这个月剩下的 —— 公告多在 10 日前后,但春节那月会晚
 * (2016-01 那份 2 月 16 日才交),不能按日子硬筛;认出即停也省掉下载同月 20 日前后那份几 MB 的季报。
 * 只读 submissions 的 recent(TSM 约回到 2015-03)。SEC 限速每秒 10 个请求,逐份之间隔 gapMs。
 */
export async function fetchRevenueReports(
  cik: string,
  since: string,
  { doFetch = fetchWithTimeout as FetchFn, gapMs = 150 }: { doFetch?: FetchFn; gapMs?: number } = {},
): Promise<RevenueReport[]> {
  const sub = (await (
    await get(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, doFetch)
  ).json()) as {
    filings?: { recent?: Recent };
  };
  const { form = [], filingDate = [], accessionNumber = [], primaryDocument = [] } = sub.filings?.recent ?? {};
  const candidates = form
    .map((f, i) => ({ f, filed: filingDate[i] ?? '', accn: accessionNumber[i] ?? '', doc: primaryDocument[i] ?? '' }))
    .filter((c) => c.f === '6-K' && c.filed >= since && c.accn && c.doc)
    .sort((a, b) => a.filed.localeCompare(b.filed));

  // 逐份串行取(SEC 限速),不并发;这个申报月已认出一份就不再取
  const found = new Set<string>();
  const reports = await candidates.reduce<Promise<RevenueReport[]>>(async (accP, c) => {
    const acc = await accP;
    if (found.has(c.filed.slice(0, 7))) return acc;
    const url = `${ARCHIVES}/${Number(cik)}/${c.accn.replace(/-/g, '')}/${c.doc}`;
    const report = parseRevenueReport(toText(await (await get(url, doFetch)).text()), c.accn);
    if (gapMs) await Bun.sleep(gapMs);
    if (report) found.add(c.filed.slice(0, 7));

    return report ? [...acc, report] : acc;
  }, Promise.resolve([]));

  return reports.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
}
