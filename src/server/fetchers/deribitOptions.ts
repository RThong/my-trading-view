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
import { NonRetryableError, fetchWithTimeout, withRetry } from './http';

const BASE = 'https://www.deribit.com/api/v2/public';
const TICKER_CONCURRENCY = 10;

/** 只重试传输层失败:429 限流与 5xx。其余 4xx 是「这个请求本身不对」,再打一次还是同样答复。 */
export const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/** 裸调用,不重试。逐合约的 ticker 走这个 —— 那一层由 mapLimit 的 allSettled 兜着。 */
async function get(path: string): Promise<any> {
  const res = await fetchWithTimeout(`${BASE}/${path}`);
  if (!res.ok) {
    const msg = `Deribit ${path} → HTTP ${res.status}`;
    throw isRetryableStatus(res.status) ? new Error(msg) : new NonRetryableError(msg);
  }

  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new NonRetryableError(`Deribit ${path} → ${JSON.stringify(j.error)}`);

  return j.result;
}

/**
 * 带一次重试。**只给那两个「一个请求对应一天一个数」的单点调用用**(get_instruments / get_index_price):
 * 链是快照型不可回填,这两个各拿一次、抖一下那天就永久缺 —— get_instruments 挂了整条链没了
 * (实测 2026-08-04:单次 15s 超时把整个 crypto job 拖挂,报 "The operation timed out.");
 * get_index_price 挂了链还在(下面 try/catch 兜成 spot=null),但那天的现货价就永久没有。
 *
 * **不要给逐合约的 ticker 用**:那层本来就 allSettled 容错,缺几个合约不影响 25Δ 选取,
 * 而给上百次调用各加「1.5s + 一整轮 15s 超时」会让 Deribit 抽风时单链墙钟翻倍
 * (~300s → ~630s),而 crypto job 一天 5 个触发点、没有互斥锁。
 */
const getRetried = (path: string, delayMs?: number): Promise<any> => withRetry(() => get(path), delayMs);

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

/** retryDelayMs 只为测试留口:验证「重试确实发生」的测试不该真等 1.5s。生产用默认值。 */
export function defaultDeribitOptionsClient(retryDelayMs?: number): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte): Promise<OptionChainSnapshot> {
      const currency = symbol.toUpperCase(); // 'BTC' / 'ETH'
      const all: Instrument[] = await getRetried(
        `get_instruments?currency=${currency}&kind=option&expired=false`,
        retryDelayMs,
      );
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
        const idx = await getRetried(`get_index_price?index_name=${currency.toLowerCase()}_usd`, retryDelayMs);
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
