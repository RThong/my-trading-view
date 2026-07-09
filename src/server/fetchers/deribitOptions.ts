/**
 * Deribit 加密期权链抓取器(BTC/ETH)。
 *
 * 返回 optionsSnapshot.ts 定义的 OptionChainSnapshot,与 moomoo 一致,后续流水线
 * (select25Delta、归档)无需关心来源。Deribit 公开 REST API 免 key:
 *   - get_instruments  → 列出某币种所有未到期期权(含 strike/类型/到期时间戳)
 *   - ticker           → 单合约的 mark_iv + 全套 greeks + OI(无批量 greeks 接口,
 *                        但单个到期日仅数十个合约,逐合约打可接受)
 *   - get_index_price  → 现货指数价
 *
 * Deribit 的 mark_iv 是百分数(35.12 表示 35.12%),归一化成小数。
 * 期权价格以币本位计(如 0.018 BTC),归档原样保留。
 */
import type { OptionContract, OptionChainSnapshot, OptionsChainClient } from '../jobs/optionsSnapshot';
import { firstBy } from 'remeda';
import { fetchWithTimeout } from './http';

const BASE = 'https://www.deribit.com/api/v2/public';
const TICKER_CONCURRENCY = 10;

async function get(path: string): Promise<any> {
  const res = await fetchWithTimeout(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`Deribit ${path} → HTTP ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(`Deribit ${path} → ${JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * 分批并发,避免一次性打太多请求触发限流。单合约容错:用 allSettled,
 * 个别请求失败(429/瞬断)只丢弃该合约,不连累整批——链小,缺几个不影响 25Δ 选取。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const settled = await Promise.allSettled(items.slice(i, i + limit).map(fn));
    out.push(...settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])));
  }
  return out;
}

type Instrument = {
  instrument_name: string;
  strike: number;
  option_type: 'call' | 'put';
  expiration_timestamp: number;
};

async function tickerToContract(inst: Instrument): Promise<OptionContract | null> {
  const t = await get(`ticker?instrument_name=${inst.instrument_name}`);
  if (typeof t?.mark_iv !== 'number') return null;
  const g = t.greeks ?? {};
  return {
    contractSymbol: inst.instrument_name,
    strike: inst.strike,
    expiration: new Date(inst.expiration_timestamp).toISOString().slice(0, 10),
    impliedVolatility: t.mark_iv / 100, // Deribit IV 是百分数
    bid: typeof t.best_bid_price === 'number' ? t.best_bid_price : null,
    ask: typeof t.best_ask_price === 'number' ? t.best_ask_price : null,
    lastPrice: typeof t.last_price === 'number' ? t.last_price : null,
    volume: typeof t.stats?.volume === 'number' ? t.stats.volume : null,
    openInterest: typeof t.open_interest === 'number' ? t.open_interest : null,
    inTheMoney: false, // 需要时按 strike vs spot 推导
    lastTradeDate: null,
    delta: typeof g.delta === 'number' ? g.delta : null,
    gamma: typeof g.gamma === 'number' ? g.gamma : null,
    vega: typeof g.vega === 'number' ? g.vega : null,
    theta: typeof g.theta === 'number' ? g.theta : null,
    rho: typeof g.rho === 'number' ? g.rho : null,
  };
}

export function defaultDeribitOptionsClient(): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte): Promise<OptionChainSnapshot> {
      const currency = symbol.toUpperCase(); // 'BTC' / 'ETH'
      const all: Instrument[] = await get(`get_instruments?currency=${currency}&kind=option&expired=false`);
      if (all.length === 0) throw new Error(`Deribit: ${currency} 无期权`);

      // 选到期日最接近(今天 + targetDte)的那个
      const target = Date.now() + targetDte * 86400_000;
      const expiries = [...new Set(all.map((i) => i.expiration_timestamp))];
      const bestExp = firstBy(expiries, (t) => Math.abs(t - target))!;
      const inExp = all.filter((i) => i.expiration_timestamp === bestExp);

      const withType = await mapLimit(inExp, TICKER_CONCURRENCY, async (i) => ({
        type: i.option_type,
        c: await tickerToContract(i),
      }));
      const calls = withType.filter((r) => r.type === 'call' && r.c).map((r) => r.c!);
      const puts = withType.filter((r) => r.type === 'put' && r.c).map((r) => r.c!);

      // 现货只用于归档展示,25Δ 选取不依赖它;取不到就降级为 null,
      // 别让现货请求失败丢掉已经抓到的整条链。
      let spot: number | null = null;
      try {
        const idx = await get(`get_index_price?index_name=${currency.toLowerCase()}_usd`);
        if (typeof idx?.index_price === 'number') spot = idx.index_price;
      } catch {
        // 现货失败,spot 保持 null
      }

      return {
        underlyingSymbol: currency,
        underlyingPrice: spot,
        expirationDate: new Date(bestExp).toISOString().slice(0, 10),
        calls,
        puts,
      };
    },
    // BTC 24/7:按当前 UTC 日打戳(不跳周末、不认假期),区别于美股的 lastClosedTradingDate。
    async getTradingDate(): Promise<string> {
      return new Date().toISOString().slice(0, 10);
    },
  };
}
