import type { Database } from 'bun:sqlite';
import { insertOptions25Delta, insertOptionChainRaw, type Options25DeltaRow, type OptionChainRawRow } from '../storage/repository';
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
  // 希腊字母 —— 数据源提供时才有(moomoo)。归档表全部保留:moomoo 是快照型、
  // 免费档拿不到历史,今天不存的字段以后补不回来(vanna/charm 等高阶分析需要)。
  delta?: number | null;
  gamma?: number | null;
  vega?: number | null;
  theta?: number | null;
  rho?: number | null;
};

export type OptionChainSnapshot = {
  underlyingSymbol: string;
  underlyingPrice: number;     // 拉取时刻的现货价
  expirationDate: string;      // 'YYYY-MM-DD'
  calls: OptionContract[];
  puts: OptionContract[];
};

// 25Δ 选取直接用 moomoo 为每个合约返回的 delta(交易所级、已算好)。
// 之前为兼容无 Greeks 的 Yahoo 而自己用 BS 重算,Yahoo 期权源已删除,故去掉。

const TARGET_DTE = 30;

export type Selection = {
  callIv: number;
  putIv: number;
  skew: number;
  callStrike: number;
  putStrike: number;
};

/** 从期权链中挑选 25-delta call(delta≈0.25)与 25-delta put(delta≈−0.25)。 */
export function select25Delta(chain: OptionChainSnapshot): Selection {
  const callPick = pickClosestDelta(chain.calls, 0.25);
  const putPick = pickClosestDelta(chain.puts, -0.25);

  return {
    callIv: callPick.impliedVolatility,
    putIv: putPick.impliedVolatility,
    skew: putPick.impliedVolatility - callPick.impliedVolatility,
    callStrike: callPick.strike,
    putStrike: putPick.strike,
  };
}

// 依赖 moomoo 的符号约定:put delta 为负、call delta 为正。已用真实 OpenD
// 抓取的链核实(SPY 6/19:249 个 put delta 全 <=0,728P=-0.2507 与 App 一致)。
/** 取 delta 最接近 target 的合约;忽略没有 delta 的合约。 */
function pickClosestDelta(arr: OptionContract[], target: number): OptionContract {
  const withDelta = arr.filter((c) => typeof c.delta === 'number');
  if (withDelta.length === 0) throw new Error('期权链缺少 delta,无法选取 25Δ');
  return withDelta.reduce((best, cur) =>
    Math.abs(cur.delta! - target) < Math.abs(best.delta! - target) ? cur : best,
  );
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
};

export async function runOptionsSnapshot(opts: RunOpts): Promise<Options25DeltaRow[]> {
  // 用最近一个*已收盘*的美股交易日打戳,而不是用本地时钟的今天,
  // 这样周末/盘后运行都会归并到正确的那个周五行上(在 upsert 下保持幂等)。
  const today = lastClosedTradingDate();
  const rows: Options25DeltaRow[] = [];
  const rawRows: OptionChainRawRow[] = [];

  for (const u of opts.underlyings) {
    const chain = await opts.client.fetchChain(u, TARGET_DTE);
    const sel = select25Delta(chain);

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

export { TARGET_DTE };
