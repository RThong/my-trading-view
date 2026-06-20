import YahooFinance from 'yahoo-finance2';

export type OptionContract = {
  contractSymbol: string;
  strike: number;
  expiration: string;          // 'YYYY-MM-DD'(ISO)
  impliedVolatility: number;  // 小数形式:0.20 表示 20%
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  volume: number | null;
  openInterest: number | null;
  inTheMoney: boolean;
  lastTradeDate: string | null;   // ISO 日期时间,长期无成交的行权价可能为 null
  // 希腊字母 —— 数据源提供时才有(moomoo);Yahoo 则为 null。
  delta?: number | null;
  gamma?: number | null;
};

export type OptionChainSnapshot = {
  underlyingSymbol: string;
  underlyingPrice: number;     // 拉取时刻的现货价
  expirationDate: string;      // 'YYYY-MM-DD'
  calls: OptionContract[];
  puts: OptionContract[];
};

export type YahooOptionsClient = {
  /** 返回到期日最接近(今天 + targetDte 天)的期权链。 */
  fetchChain(symbol: string, targetDte: number): Promise<OptionChainSnapshot>;
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const toIsoDateAny = (d: any): string => {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') return d.slice(0, 10);
  return '';
};
const toIsoDateTime = (d: any): string | null => {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === 'string') return d;
  return null;
};

export function defaultYahooOptionsClient(): YahooOptionsClient {
  const yf = new YahooFinance();
  return {
    async fetchChain(symbol, targetDte) {
      // 第一次调用:获取可用的到期日列表 + 现货价。
      const meta = await (yf.options(symbol) as Promise<any>);
      const expirations: Date[] = meta.expirationDates ?? [];
      if (expirations.length === 0) {
        throw new Error(`No expirations available for ${symbol}`);
      }
      const target = Date.now() + targetDte * 86_400_000;
      // 选 |expiry - target| 最小的到期日
      let best = expirations[0];
      let bestDiff = Math.abs(best.getTime() - target);
      for (const e of expirations) {
        const diff = Math.abs(e.getTime() - target);
        if (diff < bestDiff) { best = e; bestDiff = diff; }
      }
      // 第二次调用:获取该到期日对应的期权链。
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
          contractSymbol: String(o.contractSymbol ?? ''),
          strike: o.strike,
          expiration: toIsoDateAny(o.expiration),
          impliedVolatility: o.impliedVolatility,
          bid: typeof o.bid === 'number' ? o.bid : null,
          ask: typeof o.ask === 'number' ? o.ask : null,
          lastPrice: typeof o.lastPrice === 'number' ? o.lastPrice : null,
          volume: typeof o.volume === 'number' ? o.volume : null,
          openInterest: typeof o.openInterest === 'number' ? o.openInterest : null,
          inTheMoney: Boolean(o.inTheMoney),
          lastTradeDate: toIsoDateTime(o.lastTradeDate),
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
