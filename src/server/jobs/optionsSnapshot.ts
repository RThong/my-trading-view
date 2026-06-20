import type { Database } from 'bun:sqlite';
import { insertOptions25Delta, insertOptionChainRaw, type Options25DeltaRow, type OptionChainRawRow } from '../storage/repository';
import { callDelta } from '../analytics/greeks';
import { lastClosedTradingDate } from './tradingCalendar';

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
  // 希腊字母 —— 数据源提供时才有(moomoo)。
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

// 我们用 Black-Scholes delta,从每个 strike 的 IV 推算出 25Δ 的选取结果。
// moomoo 也会为每个合约返回它自己预先算好的 delta;但为了在不同数据源之间
// 保持一致,我们统一沿用自己算的 BS delta。moomoo 的 delta 已存进归档的
// chain 里,将来想交叉验证时随时可以取用。

const TARGET_DTE = 30;
const DEFAULT_RATE = 0.045;

export type Selection = {
  callIv: number;
  putIv: number;
  skew: number;
  callStrike: number;
  putStrike: number;
};

/** 从期权链中挑选 25-delta call 与 25-delta put 的 strike。 */
export function select25Delta(
  chain: OptionChainSnapshot,
  rate: number,
  todayMs: number = Date.now(),
): Selection {
  const expiryMs = new Date(chain.expirationDate + 'T16:00:00Z').getTime();
  const yearsToExpiry = Math.max((expiryMs - todayMs) / (365 * 86_400_000), 1 / 365);
  const spot = chain.underlyingPrice;

  // 对每个 call strike 算出 delta,取 |delta − 0.25| 最小的那个。
  const callPick = pickClosest(chain.calls, (c) => {
    const d = callDelta({ spot, strike: c.strike, yearsToExpiry, iv: c.impliedVolatility, rate });
    return Math.abs(d - 0.25);
  });
  // 对每个 put strike,put_delta ≈ −0.25 等价于同一 K 的 call_delta ≈ 0.75。
  const putPick = pickClosest(chain.puts, (p) => {
    const d = callDelta({ spot, strike: p.strike, yearsToExpiry, iv: p.impliedVolatility, rate });
    return Math.abs(d - 0.75);
  });

  return {
    callIv: callPick.impliedVolatility,
    putIv: putPick.impliedVolatility,
    skew: putPick.impliedVolatility - callPick.impliedVolatility,
    callStrike: callPick.strike,
    putStrike: putPick.strike,
  };
}

function pickClosest<T>(arr: T[], distance: (x: T) => number): T {
  if (arr.length === 0) throw new Error('empty array');
  // distance 每个元素只算一次,再用 reduce 取最小。
  return arr
    .map((x) => ({ x, d: distance(x) }))
    .reduce((best, cur) => (cur.d < best.d ? cur : best)).x;
}

/** 抓取器满足的最小 client 接口(目前由 moomoo 实现)。 */
export type OptionsChainClient = {
  fetchChain(symbol: string, targetDte: number): Promise<OptionChainSnapshot>;
};

type RunOpts = {
  db: Database;
  /** 要做快照的标的,例如 ['SPY']。原样存储为 `underlying` 键。 */
  underlyings: string[];
  client: OptionsChainClient;
  riskFreeRate: number;
};

export async function runOptionsSnapshot(opts: RunOpts): Promise<Options25DeltaRow[]> {
  // 用最近一个*已收盘*的美股交易日打戳,而不是用本地时钟的今天,
  // 这样周末/盘后运行都会归并到正确的那个周五行上(在 upsert 下保持幂等)。
  const today = lastClosedTradingDate();
  const rows: Options25DeltaRow[] = [];
  const rawRows: OptionChainRawRow[] = [];

  for (const u of opts.underlyings) {
    const chain = await opts.client.fetchChain(u, TARGET_DTE);
    const sel = select25Delta(chain, opts.riskFreeRate);

    // IV 以百分数存储(例如 16.63),方便图表坐标轴显示。
    rows.push({
      underlying: u,
      snapshotDate: today,
      callIv: sel.callIv * 100,
      putIv: sel.putIv * 100,
      skew: sel.skew * 100,
      isMock: false,
    });

    // 归档完整的 chain(gzip 压缩),供日后分析使用(max pain、OI 分布、
    // GEX 等)。moomoo 的 chain 自带 Greeks,因此 GEX 可以直接从归档数据
    // 推导,无需重新定价。
    const chainJson = JSON.stringify({ calls: chain.calls, puts: chain.puts });
    const gz = Bun.gzipSync(new TextEncoder().encode(chainJson));
    rawRows.push({
      underlying: u,
      snapshotDate: today,
      expiry: chain.expirationDate,
      underlyingPrice: chain.underlyingPrice,
      chainJsonGz: gz,
    });
  }

  insertOptions25Delta(opts.db, rows);
  insertOptionChainRaw(opts.db, rawRows);

  return rows;
}

export { TARGET_DTE, DEFAULT_RATE };
