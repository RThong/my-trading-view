import { describe, expect, test } from 'bun:test';
import { isYahooSymbol, toHistory, toSearchHits } from './yahooLookup';

describe('toSearchHits', () => {
  test('只留 Yahoo 自己有行情的条目,名字优先 longname', () => {
    const hits = toSearchHits({
      quotes: [
        { symbol: 'GC=F', shortname: 'Gold Dec 26', quoteType: 'FUTURE', exchDisp: 'COMEX', isYahooFinance: true },
        { symbol: 'GLD', shortname: 'SPDR', longname: 'SPDR Gold Shares', quoteType: 'ETF', exchDisp: 'NYSEArca' },
        { symbol: 'X', isYahooFinance: false },
        { symbol: 'M&M.NS', shortname: '白名单外字符' },
        { shortname: '没有代码' },
      ],
    });
    expect(hits).toEqual([
      { symbol: 'GC=F', name: 'Gold Dec 26', type: 'FUTURE', exchange: 'COMEX' },
      { symbol: 'GLD', name: 'SPDR Gold Shares', type: 'ETF', exchange: 'NYSEArca' },
    ]);
  });
});

describe('toHistory', () => {
  test('日期按交易所当地时间:澳股 10:00 AEDT 开盘 = 前一天 23:00Z,仍记为当地那天', () => {
    const h = toHistory({
      meta: { symbol: 'BHP.AX', gmtoffset: 11 * 3600 },
      quotes: [{ date: new Date('2026-11-01T23:00:00Z'), close: 45 }],
    });
    expect(h.points).toEqual([{ date: '2026-11-02', close: 45, open: null, high: null, low: null }]);
  });

  test('负价是真实成交,保留', () => {
    const h = toHistory({
      meta: { symbol: 'CL=F' },
      quotes: [{ date: new Date('2020-04-20T04:00:00Z'), close: -37.63 }],
    });
    expect(h.points).toEqual([{ date: '2020-04-20', close: -37.63, open: null, high: null, low: null }]);
  });

  test('开高低一起给;缺的 / 0 占位记 null', () => {
    const h = toHistory({
      meta: { symbol: '^GSPC' },
      quotes: [{ date: new Date('2026-11-05T14:30:00Z'), open: 6800, high: 6850, low: 0, close: 6820 }],
    });
    expect(h.points).toEqual([{ date: '2026-11-05', close: 6820, open: 6800, high: 6850, low: null }]);
  });

  test('丢掉空值 / 0,同日保留后一根', () => {
    const h = toHistory({
      meta: { symbol: 'GC=F', shortName: 'Gold Dec 26', currency: 'USD' },
      quotes: [
        { date: new Date('2026-10-29T04:00:00Z'), close: 3900 },
        { date: new Date('2026-10-30T04:00:00Z'), close: null },
        { date: new Date('2026-10-30T13:00:00Z'), close: 0 },
        { date: new Date('2026-10-31T04:00:00Z'), close: 3890 },
        { date: new Date('2026-10-31T20:00:00Z'), close: 3899 },
      ],
    });
    expect(h).toEqual({
      symbol: 'GC=F',
      name: 'Gold Dec 26',
      currency: 'USD',
      points: [
        { date: '2026-10-29', close: 3900, open: null, high: null, low: null },
        { date: '2026-10-31', close: 3899, open: null, high: null, low: null },
      ],
    });
  });
});

test('isYahooSymbol', () => {
  ['^GSPC', 'GC=F', 'BTC-USD', '8306.T', 'BRK-B', 'spy'].forEach((s) => {
    expect(isYahooSymbol(s)).toBe(true);
  });
  ['', 'a b', '../etc', 'x'.repeat(25), 'A/B'].forEach((s) => {
    expect(isYahooSymbol(s)).toBe(false);
  });
});
