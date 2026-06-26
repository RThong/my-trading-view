import { describe, test, expect } from 'bun:test';
import { parseSettleCsv, computeNthMonth, fetchVxTermStructure, type CboeVxClient } from './cboeVx';

describe('parseSettleCsv', () => {
  test('parses standard CBOE VX CSV with Settle in column 7', () => {
    const csv =
      'Trade Date,Futures,Open,High,Low,Close,Settle,Change,Total Volume,EFP,Open Interest\n' +
      '2026-01-16,F (Jan 2026),16.43,16.91,16.20,16.65,16.6389,0.13,64804,0,58018\n' +
      '2026-01-20,F (Jan 2026),17.20,20.95,17.05,19.90,20.2228,3.58,150333,360,33407\n';
    const rows = parseSettleCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ tradeDate: '2026-01-16', settle: 16.6389 });
    expect(rows[1].settle).toBeCloseTo(20.2228, 4);
  });

  test('skips rows with non-numeric or zero settle', () => {
    const csv =
      'Trade Date,Futures,Open,High,Low,Close,Settle,Change,Total Volume,EFP,Open Interest\n' +
      '2026-01-16,F (Jan 2026),0,0,0,0,0,0,0,0,0\n' +
      '2026-01-17,F (Jan 2026),0,0,0,0,16.5,0,0,0,0\n' +
      '2026-01-18,F (Jan 2026),0,0,0,0,,0,0,0,0\n';
    const rows = parseSettleCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeDate).toBe('2026-01-17');
  });

  test('handles CRLF line endings', () => {
    const csv =
      'Trade Date,Futures,Open,High,Low,Close,Settle,Change\r\n' +
      '2026-01-16,F (Jan 2026),0,0,0,0,16.6389,0\r\n';
    expect(parseSettleCsv(csv)).toHaveLength(1);
  });

  test('returns empty for malformed input', () => {
    expect(parseSettleCsv('')).toEqual([]);
    expect(parseSettleCsv('only one line')).toEqual([]);
  });
});

describe('computeNthMonth n=1(近月,roll + 排序)', () => {
  test('picks contract with earliest expire_date strictly after trade_date', () => {
    const series = computeNthMonth([
      {
        expireDate: '2026-02-18', // G6 —— 1 月的远月合约
        rows: [
          { tradeDate: '2026-01-15', settle: 18.0 },
          { tradeDate: '2026-01-16', settle: 18.5 },
          { tradeDate: '2026-01-21', settle: 19.0 }, // F6 到期后,G6 成为近月
        ],
      },
      {
        expireDate: '2026-01-21', // F6 —— 仍在交易时是近月合约
        rows: [
          { tradeDate: '2026-01-15', settle: 17.5 },
          { tradeDate: '2026-01-16', settle: 17.8 },
          { tradeDate: '2026-01-21', settle: 18.2 }, // 最后一天,但 expireDate == tradeDate 故被跳过
        ],
      },
    ], 1);
    const byDate = Object.fromEntries(series.map((s) => [s.tradeDate, s.settle]));
    // 1/15 和 1/16 时,F6(1/21 到期)是近月;到了 1/21,F6 被排除,改由 G6 接替。
    expect(byDate['2026-01-15']).toBe(17.5);
    expect(byDate['2026-01-16']).toBe(17.8);
    expect(byDate['2026-01-21']).toBe(19.0);
  });

  test('result is sorted ascending by trade date', () => {
    const series = computeNthMonth([
      {
        expireDate: '2026-03-18',
        rows: [
          { tradeDate: '2026-02-05', settle: 20 },
          { tradeDate: '2026-01-20', settle: 19 },
          { tradeDate: '2026-02-20', settle: 21 },
        ],
      },
    ], 1);
    expect(series.map((s) => s.tradeDate)).toEqual([
      '2026-01-20',
      '2026-02-05',
      '2026-02-20',
    ]);
  });
});

describe('computeNthMonth', () => {
  // 同一交易日 1/15 有三份合约在交易:F6(1/21到期,近月)、G6(2/18,次月)、H6(3/18,三月)。
  const rows = [
    { expireDate: '2026-03-18', rows: [{ tradeDate: '2026-01-15', settle: 19.0 }] }, // H6
    { expireDate: '2026-01-21', rows: [{ tradeDate: '2026-01-15', settle: 17.5 }] }, // F6
    { expireDate: '2026-02-18', rows: [{ tradeDate: '2026-01-15', settle: 18.2 }] }, // G6
  ];

  test('n=3 picks the third-nearest non-expired contract', () => {
    const s = computeNthMonth(rows, 3);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ tradeDate: '2026-01-15', settle: 19.0, expireDate: '2026-03-18' });
  });

  test('n=1 equals front month', () => {
    expect(computeNthMonth(rows, 1)[0].settle).toBe(17.5);
  });

  test('skips trade dates lacking an nth contract', () => {
    // 只有近月一份在交易的日期,取 n=3 无结果。
    const thin = [{ expireDate: '2026-01-21', rows: [{ tradeDate: '2026-01-15', settle: 17.5 }] }];
    expect(computeNthMonth(thin, 3)).toEqual([]);
  });
});

describe('fetchVxTermStructure', () => {
  // 三份合约,交易日 2025-01-02 同时在三者 CSV 出现(早于 HISTORY_START_DATE 的日期应被滤掉)。
  const fakeClient: CboeVxClient = {
    fetchContractList: async () => [
      { symbol: 'F', expireDate: '2025-01-21', csvUrl: 'f' },
      { symbol: 'G', expireDate: '2025-02-18', csvUrl: 'g' },
      { symbol: 'H', expireDate: '2025-03-18', csvUrl: 'h' },
    ],
    fetchContractCsv: async (c) => {
      const settle = { f: 17.5, g: 18.2, h: 19.0 }[c.csvUrl]!;
      return [
        { tradeDate: '2000-01-01', settle }, // 早于 HISTORY_START_DATE,应被滤掉
        { tradeDate: '2025-01-02', settle },
      ];
    },
  };

  test('one download yields VX1 (front) and VX3 (third) series', async () => {
    const { vx1, vx3 } = await fetchVxTermStructure({ client: fakeClient, freshSince: '1900-01-01' });
    expect(vx1).toHaveLength(1);
    expect(vx1[0]).toMatchObject({ symbol: 'VX1', tradeDate: '2025-01-02', close: 17.5 });
    expect(vx3[0]).toMatchObject({ symbol: 'VX3', tradeDate: '2025-01-02', close: 19.0 });
  });

  test('增量刷新不污染旧日期:freshSince 之前的交易日不产出', async () => {
    // 增量时 freshSince ≈ 今天,下载集只剩远月合约(近月已到期被排除)。
    // 这份远月合约的 CSV 仍覆盖几个月前的交易日 —— 若按所有历史日产出,
    // 就会把"过去那天的近月"错算成这份远月(值偏高、几乎不动),覆盖掉正确历史。
    // 增量只应产出 tradeDate >= freshSince 的新行(那些日期下载集里确有真近月)。
    const farOnly: CboeVxClient = {
      fetchContractList: async () => [
        { symbol: 'VX+VXT/N6', expireDate: '2026-07-15', csvUrl: 'far' }, // 远月,>= freshSince 被保留
      ],
      fetchContractCsv: async () => [
        { tradeDate: '2025-12-10', settle: 21.0 }, // 旧日期:这天它是 7 个月后的远月,不是近月
        { tradeDate: '2026-06-24', settle: 19.0 }, // freshSince 之后:这天它确是近月
      ],
    };
    const { vx1 } = await fetchVxTermStructure({ client: farOnly, freshSince: '2026-06-01' });
    expect(vx1.map((r) => r.tradeDate)).toEqual(['2026-06-24']); // 旧日期 2025-12-10 不应出现
  });

  test('任一合约 CSV 下载失败 → 抛错,不用残缺集计算', async () => {
    const oneFails: CboeVxClient = {
      fetchContractList: async () => [
        { symbol: 'VX+VXT/N6', expireDate: '2026-07-15', csvUrl: 'ok' },
        { symbol: 'VX+VXT/Q6', expireDate: '2026-08-19', csvUrl: 'boom' },
      ],
      fetchContractCsv: async (c) => {
        if (c.csvUrl === 'boom') throw new Error('HTTP 503');
        return [{ tradeDate: '2026-06-24', settle: 19.0 }];
      },
    };
    await expect(fetchVxTermStructure({ client: oneFails, freshSince: '1900-01-01' })).rejects.toThrow(/缺失/);
  });

  test('ignores weekly VX futures — only ranks standard monthlies', async () => {
    // 周度合约(symbol 形如 VXT26/、VXT27/,VXT 后带数字)到期夹在月度之间、结算价常与近月相同。
    // 不剔除会污染"第 N 近"排序:VX3 会误取到周度(=18)而非真正的第三月(=20)。
    const withWeeklies: CboeVxClient = {
      fetchContractList: async () => [
        { symbol: 'VX+VXT/N6', expireDate: '2025-07-22', csvUrl: 'm1' },   // 月度近月
        { symbol: 'VX+VXT/Q6', expireDate: '2025-08-19', csvUrl: 'm2' },   // 月度次月
        { symbol: 'VX+VXT/U6', expireDate: '2025-09-16', csvUrl: 'm3' },   // 月度三月
        { symbol: 'VX+VXT26/N6', expireDate: '2025-07-01', csvUrl: 'w1' }, // 周度
        { symbol: 'VX+VXT27/N6', expireDate: '2025-07-08', csvUrl: 'w2' }, // 周度
      ],
      fetchContractCsv: async (c) => {
        const settle = { m1: 18, m2: 19, m3: 20, w1: 18, w2: 18 }[c.csvUrl]!;
        return [{ tradeDate: '2025-06-25', settle }];
      },
    };
    const { vx1, vx3 } = await fetchVxTermStructure({ client: withWeeklies, freshSince: '1900-01-01' });
    expect(vx1[0].close).toBe(18); // 月度近月 N6
    expect(vx3[0].close).toBe(20); // 月度第三月 U6,而非周度的 18
  });
});
