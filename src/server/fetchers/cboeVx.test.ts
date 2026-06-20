import { describe, test, expect } from 'bun:test';
import { parseSettleCsv, computeFrontMonth } from './cboeVx';

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

describe('computeFrontMonth', () => {
  test('picks contract with earliest expire_date strictly after trade_date', () => {
    const series = computeFrontMonth([
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
    ]);
    const byDate = Object.fromEntries(series.map((s) => [s.tradeDate, s.settle]));
    // 1/15 和 1/16 时,F6(1/21 到期)是近月;到了 1/21,F6 被排除,改由 G6 接替。
    expect(byDate['2026-01-15']).toBe(17.5);
    expect(byDate['2026-01-16']).toBe(17.8);
    expect(byDate['2026-01-21']).toBe(19.0);
  });

  test('result is sorted ascending by trade date', () => {
    const series = computeFrontMonth([
      {
        expireDate: '2026-03-18',
        rows: [
          { tradeDate: '2026-02-05', settle: 20 },
          { tradeDate: '2026-01-20', settle: 19 },
          { tradeDate: '2026-02-20', settle: 21 },
        ],
      },
    ]);
    expect(series.map((s) => s.tradeDate)).toEqual([
      '2026-01-20',
      '2026-02-05',
      '2026-02-20',
    ]);
  });
});
