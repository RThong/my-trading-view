import YahooFinance from 'yahoo-finance2';

export type OptionContract = {
  strike: number;
  impliedVolatility: number;  // decimal: 0.20 = 20%
  bid?: number;
  ask?: number;
  lastPrice?: number;
};

export type OptionChainSnapshot = {
  underlyingSymbol: string;
  underlyingPrice: number;     // spot price at time of fetch
  expirationDate: string;      // 'YYYY-MM-DD'
  calls: OptionContract[];
  puts: OptionContract[];
};

export type YahooOptionsClient = {
  /** Returns the option chain for the expiry closest to (today + targetDte) days. */
  fetchChain(symbol: string, targetDte: number): Promise<OptionChainSnapshot>;
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultYahooOptionsClient(): YahooOptionsClient {
  const yf = new YahooFinance();
  return {
    async fetchChain(symbol, targetDte) {
      // First call: get available expirations + spot.
      const meta = await (yf.options(symbol) as Promise<any>);
      const expirations: Date[] = meta.expirationDates ?? [];
      if (expirations.length === 0) {
        throw new Error(`No expirations available for ${symbol}`);
      }
      const target = Date.now() + targetDte * 86_400_000;
      // Pick expiry with min |expiry - target|
      let best = expirations[0];
      let bestDiff = Math.abs(best.getTime() - target);
      for (const e of expirations) {
        const diff = Math.abs(e.getTime() - target);
        if (diff < bestDiff) { best = e; bestDiff = diff; }
      }
      // Second call: get the chain for that specific expiry.
      const chain = await (yf.options(symbol, { date: best }) as Promise<any>);
      const node = chain.options?.[0];
      if (!node) throw new Error(`Empty chain for ${symbol} at ${toIsoDate(best)}`);
      const spot = chain.quote?.regularMarketPrice ?? meta.quote?.regularMarketPrice;
      if (typeof spot !== 'number') {
        throw new Error(`Could not determine spot for ${symbol}`);
      }
      const map = (arr: any[]): OptionContract[] => arr
        .filter(o => typeof o.strike === 'number' && typeof o.impliedVolatility === 'number' && o.impliedVolatility > 0)
        .map(o => ({
          strike: o.strike,
          impliedVolatility: o.impliedVolatility,
          bid: o.bid,
          ask: o.ask,
          lastPrice: o.lastPrice,
        }));
      return {
        underlyingSymbol: symbol,
        underlyingPrice: spot,
        expirationDate: toIsoDate(best),
        calls: map(node.calls ?? []),
        puts: map(node.puts ?? []),
      };
    },
  };
}
