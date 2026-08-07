import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { listQuarterly6K, numsInRow, toCompanyFacts, type FsFiling } from './sec6k';
import { extractFundamentals } from '../analytics/secFundamentals';

const filing = (periodEnd: string, accn = 'a', filed = '2026-01-01'): FsFiling => ({ accn, filed, periodEnd });
const vals = (revenue: number) => ({ revenue, cogs: 1, ocf: 1, capex: 1 });

describe('toCompanyFacts:单季口径的起始日', () => {
  test('起点取上一期期末的次日 —— 13 周财季的季末不落在月末', () => {
    // 实测 ASML 的季末:2021-04-04 / 2021-07-04。按「季末月−2 的 1 号」硬算会得到
    // 2021-05-01→2021-07-04 = 64 天,被季度长度判据丢掉。这个 bug 静默吃掉过 22 期里的 9 期。
    const facts = toCompanyFacts(
      [
        { filing: filing('2021-04-04'), values: vals(100) },
        { filing: filing('2021-07-04'), values: vals(200) },
      ],
      'quarter',
      1,
    );
    const rows = facts.facts!['us-gaap']!.Revenues!.units!.USD!;

    expect(rows[1]!.start).toBe('2021-04-05'); // 上一期末 + 1 天
    const days = (Date.parse(rows[1]!.end) - Date.parse(rows[1]!.start!)) / 86_400_000;
    expect(days).toBe(90);
  });

  test('中间断档超过 120 天时不拿上一期末当起点(否则会造出一个半年长的「季度」)', () => {
    const facts = toCompanyFacts(
      [
        { filing: filing('2024-03-31'), values: vals(100) },
        { filing: filing('2024-12-31'), values: vals(200) }, // 中间缺两季
      ],
      'quarter',
      1,
    );
    const rows = facts.facts!['us-gaap']!.Revenues!.units!.USD!;
    const days = (Date.parse(rows[1]!.end) - Date.parse(rows[1]!.start!)) / 86_400_000;

    expect(days).toBe(91); // 退回「期末 − 91 天」,而不是 275 天
  });

  test('单季口径不进差分:相邻两期各自成一个季度,值不相减', () => {
    const out = extractFundamentals(
      'X',
      toCompanyFacts(
        [
          { filing: filing('2026-03-29', 'q1'), values: vals(8766.9) },
          { filing: filing('2026-06-28', 'q2'), values: vals(9326.5) },
        ],
        'quarter',
        1e6,
      ),
    );
    const rev = out.filter((r) => r.concept === 'revenue');

    expect(rev.map((r) => r.value)).toEqual([8_766_900_000, 9_326_500_000]);
  });

  test('累计口径反过来:同一年内相邻两期相减', () => {
    const out = extractFundamentals(
      'X',
      toCompanyFacts(
        [
          { filing: filing('2026-03-31', 'q1'), values: vals(100) },
          { filing: filing('2026-06-30', 'h1'), values: vals(300) },
        ],
        'ytd',
        1,
      ),
    );
    const q2 = out.find((r) => r.periodEnd === '2026-06-30' && r.concept === 'revenue')!;

    expect(q2.value).toBe(200);
  });
});

describe('listQuarterly6K', () => {
  const submissions = (rows: Array<[form: string, filed: string, report: string, doc: string]>) => async () =>
    new Response(
      JSON.stringify({
        filings: {
          recent: {
            form: rows.map((r) => r[0]),
            filingDate: rows.map((r) => r[1]),
            reportDate: rows.map((r) => r[2]),
            accessionNumber: rows.map((_, i) => `accn-${i}`),
            primaryDocument: rows.map((r) => r[3]),
          },
        },
      }),
      { status: 200 },
    );

  // UA 从 env 读:测试自己设,别依赖本机 .env(否则干净环境上会莫名其妙失败)。
  const REAL_UA = process.env.SEC_USER_AGENT;
  beforeEach(() => {
    process.env.SEC_USER_AGENT = 'test test@example.com';
  });
  afterAll(() => {
    if (REAL_UA === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = REAL_UA;
  });

  test('reportDate 等于 filingDate 的丢掉 —— 那不是一个期末', async () => {
    // 实测 TSM 的老财报稿就是这样(2023-07-20 / 2023-10-19 / 2024-01-18),它们带着相邻季度
    // 的值以假季末落库,把 TTM 的四季跨度判据打乱,静默吃掉了两个毛利率点。
    const out = await listQuarterly6K(
      '1',
      /^rep/,
      submissions([
        ['6-K', '2023-07-20', '2023-07-20', 'rep-a.htm'], // 假期末
        ['6-K', '2023-08-14', '2023-06-30', 'rep-b.htm'], // 真期末
        ['6-K', '2023-08-14', '2023-06-30', 'other.htm'], // 名字不匹配
        ['20-F', '2024-02-01', '2023-12-31', 'rep-c.htm'], // 不是 6-K
      ]),
    );

    expect(out.map((f) => f.periodEnd)).toEqual(['2023-06-30']);
  });

  test('按期末升序返回', async () => {
    const out = await listQuarterly6K(
      '1',
      /^rep/,
      submissions([
        ['6-K', '2026-07-15', '2026-06-28', 'rep-b.htm'],
        ['6-K', '2026-04-15', '2026-03-29', 'rep-a.htm'],
      ]),
    );

    expect(out.map((f) => f.periodEnd)).toEqual(['2026-03-29', '2026-06-28']);
  });
});

describe('numsInRow(内联式表格)', () => {
  test('遇到第一个带字母的词就停 —— 那是下一行的标签', () => {
    const txt = 'Total net sales 7,691.7 9,326.5 15,433.2 18,093.4 Total cost of sales (3,562.2) (4,291.1)';
    expect(numsInRow(txt, 'Total net sales', 9)).toEqual([7691.7, 9326.5, 15433.2, 18093.4]);
  });

  test('括号即负号', () => {
    expect(numsInRow('OCF 689.1 (482.5) Cash flows', 'OCF', 2)).toEqual([689.1, -482.5]);
  });

  test('标签后一直没数字 → 判定撞进散文,返回空', () => {
    const prose = 'Gross profit margin is expected to be between 65% and 67% Operating margin 1,234.5';
    expect(numsInRow(prose, 'Gross profit', 1)).toEqual([]);
  });
});
