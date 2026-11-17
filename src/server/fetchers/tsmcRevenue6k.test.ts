import { expect, test } from 'bun:test';
import { fetchRevenueReports, parseRevenueReport, toText } from './tsmcRevenue6k';

test('parseRevenueReport:2016 版(Net Revenues、负数带括号)与 2026 版(Net Revenue)都认;别的 6-K → null', () => {
  const y2016 =
    'TSMC December 2015 Revenue Report Hsinchu – Jan 8, 2016 ... (Unit: NT$ million) Net Revenues 58,347 63,428 (8.0 ) 69,510 (16.1 ) 843,497 762,806 10.6 TSMC Spokesperson';
  expect(parseRevenueReport(y2016, 'a')).toEqual({
    monthEnd: '2015-12-31',
    revenue: 58347,
    prevRevenue: 63428,
    lastYearRevenue: 69510,
    yoyPct: -16.1,
    accn: 'a',
  });

  const y2026 =
    'TSMC December 2025 Revenue Report ... (Unit:NT$ million) Net Revenue 335,003 343,614 (2.5) 278,163 20.4 3,809,054 2,894,308 31.6';
  expect(parseRevenueReport(y2026, 'b')).toMatchObject({ monthEnd: '2025-12-31', revenue: 335003, yoyPct: 20.4 });

  expect(parseRevenueReport('TSMC Board of Directors Meeting Resolutions ...', 'c')).toBeNull();
  // 二月取到月末(闰年)
  expect(parseRevenueReport(y2026.replace('December 2025', 'February 2024'), 'd')?.monthEnd).toBe('2024-02-29');
});

test('toText:数字实体解码、全角括号转半角 —— 2019-10 / 2020-07 两份就是因为这两样没认出来', () => {
  const html =
    '<p>TSMC July 2020 Revenue Report</p><td>(Unit: NT$ million)</td><td>Net&#xA0;Revenues</td><td>105,963</td><td>120,878</td><td>（12.3）</td><td>84,758</td><td>25.0</td>';
  expect(parseRevenueReport(toText(html), 'x')).toMatchObject({ monthEnd: '2020-07-31', revenue: 105963, yoyPct: 25 });
});

test('单位不是百万新台币 → 不认(换单位会静默写进差三个数量级的数)', () => {
  const text =
    'TSMC December 2025 Revenue Report ... (Unit:NT$ thousand) Net Revenue 335,003 343,614 (2.5) 278,163 20.4';
  expect(parseRevenueReport(text, 'x')).toBeNull();
});

test('fetchRevenueReports:只看 6-K、按申报日排序;同一申报月认出营收公告就不再下载(月中的大季报不取);16 日晚交的照样认', async () => {
  const report = (m: string) => `TSMC ${m} Revenue Report (Unit: NT$ million) Net Revenue 2 1 100.0 1 100.0`;
  const docs: Record<string, string> = {
    'a-feb-10.htm': 'TSMC Board resolutions',
    'a-feb-16.htm': report('January 2016'),
    'a-feb-20.htm': 'huge quarterly statements',
    'a-mar-10.htm': report('February 2016'),
  };
  const requested: string[] = [];
  const doFetch = (async (url: string) => {
    requested.push(url);
    if (url.includes('submissions'))
      return Response.json({
        filings: {
          recent: {
            form: ['6-K', '6-K', '20-F', '6-K', '6-K'],
            filingDate: ['2016-03-10', '2016-02-20', '2016-02-12', '2016-02-16', '2016-02-10'],
            accessionNumber: ['4', '3', '9', '2', '1'],
            primaryDocument: ['a-mar-10.htm', 'a-feb-20.htm', 'f.htm', 'a-feb-16.htm', 'a-feb-10.htm'],
          },
        },
      });
    return new Response(docs[url.split('/').at(-1)!] ?? '');
  }) as never;

  const r = await fetchRevenueReports('1046179', '2016-01-01', { doFetch, gapMs: 0 });

  expect(r.map((x) => x.monthEnd)).toEqual(['2016-01-31', '2016-02-29']);
  expect(requested.some((u) => u.endsWith('a-feb-20.htm'))).toBe(false); // 2 月已认出,季报不取
  expect(requested.some((u) => u.endsWith('f.htm'))).toBe(false); // 不是 6-K
});
