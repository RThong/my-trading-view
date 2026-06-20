import { describe, test, expect } from 'bun:test';
import { defaultYahooOptionsClient, type YahooOptionsClient, type OptionChainSnapshot } from './yahooOptions';

describe('yahooOptions DI', () => {
  test('a mock client can be used in place of the default', async () => {
    const mock: YahooOptionsClient = {
      fetchChain: async (sym, dte) => ({
        underlyingSymbol: sym,
        underlyingPrice: 5000,
        expirationDate: '2026-06-15',
        calls: [{ contractSymbol: 'TEST', strike: 5100, expiration: '2026-06-15', impliedVolatility: 0.18, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null }],
        puts:  [{ contractSymbol: 'TEST', strike: 4900, expiration: '2026-06-15', impliedVolatility: 0.22, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null }],
      }),
    };

    const out = await mock.fetchChain('^SPX', 30);
    expect(out.calls.length).toBe(1);
    expect(out.calls[0].strike).toBe(5100);
  });

  test('default client is constructable', () => {
    const c = defaultYahooOptionsClient();
    expect(typeof c.fetchChain).toBe('function');
  });
});
