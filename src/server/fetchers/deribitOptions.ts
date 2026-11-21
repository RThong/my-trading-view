/**
 * Deribit 加密期权链抓取器(BTC/ETH)。
 *
 * 返回 fetchers/optionsChain.ts 定义的 OptionChainSnapshot,与 moomoo 一致,后续流水线
 * (select25Delta、归档)无需关心来源。Deribit 公开 REST API 免 key,一条链只打三次:
 *   - get_instruments              → 列出某币种所有未到期期权(含 strike/类型/到期时间戳)
 *   - get_book_summary_by_currency → 全部期权的 mark_iv / 同到期远期价 / 买卖价 / OI,一次拿全
 *   - get_index_price              → 现货指数价
 *
 * 为什么不逐合约打 ticker(那里有现成 greeks):2026-11-20 起公开接口限流收紧,同时 5 个就约一半回 429;
 * 季度到期日一挂 120 个合约,本机并发 2 + 退避重试也要约 2 分钟,GitHub Actions 上 8 分钟只拿到 26~30 个。
 * book summary 没有 greeks,delta 用 Black-76 自算(见 analytics/optionPricing 的 black76Delta,与 ticker 给的最大差 0.003)。
 * gamma / vega / theta / rho 不算(25Δ 只用 delta;要做 GEX 时再补),存 null。
 *
 * Deribit 的 mark_iv 是百分数(35.12 表示 35.12%),归一化成小数。
 * 期权价格以币本位计(如 0.018 BTC),归档原样保留。
 */
import type { OptionContract, OptionChainSnapshot, OptionsChainClient } from './optionsChain';
import { firstBy } from 'remeda';
import { black76Delta } from '../analytics/optionPricing';
import { NonRetryableError, fetchWithTimeout, withRetry } from './http';

const BASE = 'https://www.deribit.com/api/v2/public';
const YEAR_MS = 365 * 86_400_000;

/** 只重试传输层失败:429 限流与 5xx。其余 4xx 是「这个请求本身不对」,再打一次还是同样答复。 */
export function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

type Fetch = (url: string) => Promise<Response>;

async function get(doFetch: Fetch, path: string): Promise<any> {
  const res = await doFetch(`${BASE}/${path}`);
  if (!res.ok) {
    const msg = `Deribit ${path} → HTTP ${res.status}`;
    throw isRetryableStatus(res.status) ? new Error(msg) : new NonRetryableError(msg);
  }

  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new NonRetryableError(`Deribit ${path} → ${JSON.stringify(j.error)}`);

  return j.result;
}

/**
 * 带一次重试:三个调用都是「一次请求对应一天一条链」,链是快照型不可回填,抖一下那天就永久缺
 * (实测 2026-08-04:单次 15s 超时把整个 crypto job 拖挂)。
 */
function getRetried(doFetch: Fetch, path: string, delayMs?: number): Promise<any> {
  return withRetry(() => get(doFetch, path), delayMs);
}

type Instrument = {
  instrument_name: string;
  strike: number;
  option_type: 'call' | 'put';
  expiration_timestamp: number;
};

type BookSummary = {
  instrument_name: string;
  mark_iv?: number;
  /** 同到期的远期价(Deribit 按该到期日的期货 / 合成远期给) */
  underlying_price?: number;
  bid_price?: number | null;
  ask_price?: number | null;
  last?: number | null;
  volume?: number;
  open_interest?: number;
};

function num(x: unknown): number | null {
  return typeof x === 'number' ? x : null;
}

function toContract(inst: Instrument, s: BookSummary | undefined, at: number): OptionContract | null {
  const T = (inst.expiration_timestamp - at) / YEAR_MS;
  const F = num(s?.underlying_price);
  const iv = num(s?.mark_iv);
  if (!s || !F || !iv || iv <= 0 || T <= 0) return null;
  const vol = iv / 100; // Deribit IV 是百分数

  return {
    contractSymbol: inst.instrument_name,
    strike: inst.strike,
    expiration: new Date(inst.expiration_timestamp).toISOString().slice(0, 10),
    impliedVolatility: vol,
    bid: num(s.bid_price),
    ask: num(s.ask_price),
    lastPrice: num(s.last),
    volume: num(s.volume),
    openInterest: num(s.open_interest),
    inTheMoney: false, // 需要时按 strike vs spot 推导
    lastTradeDate: null,
    delta: black76Delta({ F, K: inst.strike, T, vol, call: inst.option_type === 'call' }),
    gamma: null,
    vega: null,
    theta: null,
    rho: null,
  };
}

/**
 * fetch / now 注入:重放 Actions 存档时(见 jobs/deribitArchive)不联网、按抓取时刻选到期日、算 delta、打戳。
 * retryDelayMs 只为测试留口:验证「重试确实发生」的测试不该真等 1.5s。生产用默认值。
 */
export function defaultDeribitOptionsClient(
  deps: { fetch?: Fetch; now?: () => Date; retryDelayMs?: number } = {},
): OptionsChainClient {
  const doFetch = deps.fetch ?? ((url: string) => fetchWithTimeout(url));
  const now = deps.now ?? (() => new Date());
  const retryDelayMs = deps.retryDelayMs;

  return {
    async fetchChain(symbol, targetDte): Promise<OptionChainSnapshot> {
      const currency = symbol.toUpperCase(); // 'BTC' / 'ETH'
      const [all, summary]: [Instrument[], BookSummary[]] = await Promise.all([
        getRetried(doFetch, `get_instruments?currency=${currency}&kind=option&expired=false`, retryDelayMs),
        getRetried(doFetch, `get_book_summary_by_currency?currency=${currency}&kind=option`, retryDelayMs),
      ]);
      if (all.length === 0) throw new Error(`Deribit: ${currency} 无期权`);

      // 选到期日最接近(今天 + targetDte)的那个
      const at = now().getTime();
      const target = at + targetDte * 86400_000;
      const expiries = [...new Set(all.map((i) => i.expiration_timestamp))];
      const bestExp = firstBy(expiries, (t) => Math.abs(t - target))!;
      const byName = new Map(summary.map((s) => [s.instrument_name, s]));
      const contracts = all
        .filter((i) => i.expiration_timestamp === bestExp)
        .map((i) => ({ type: i.option_type, c: toContract(i, byName.get(i.instrument_name), at) }));
      const calls = contracts.filter((r) => r.type === 'call' && r.c).map((r) => r.c!);
      const puts = contracts.filter((r) => r.type === 'put' && r.c).map((r) => r.c!);

      // 现货只用于归档展示,25Δ 选取不依赖它;取不到就降级为 null,
      // 别让现货请求失败丢掉已经抓到的整条链。
      let spot: number | null = null;
      try {
        const idx = await getRetried(doFetch, `get_index_price?index_name=${currency.toLowerCase()}_usd`, retryDelayMs);
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
      return now().toISOString().slice(0, 10);
    },
  };
}
