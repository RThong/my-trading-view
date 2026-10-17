import type { Database } from 'bun:sqlite';
import { firstBy } from 'remeda';
import {
  insertOptions25Delta,
  insertOptionChainRaw,
  type Options25DeltaRow,
  type OptionChainRawRow,
} from '../storage/repository';
import { lastClosedTradingDate } from './tradingCalendar';
import { secondExpiryUnderlyings } from '../../shared/marketCatalog';

export type OptionContract = {
  contractSymbol: string;
  strike: number;
  expiration: string; // 'YYYY-MM-DD'(ISO)
  impliedVolatility: number; // 小数形式:0.20 表示 20%
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  volume: number | null;
  openInterest: number | null;
  inTheMoney: boolean;
  lastTradeDate: string | null; // ISO 日期时间,长期无成交的行权价可能为 null
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
  underlyingPrice: number | null; // 拉取时刻的现货价;指数(如 .VIX)无现货报价权限时为 null
  expirationDate: string; // 'YYYY-MM-DD'
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
  return firstBy(withDelta, (c) => Math.abs(c.delta! - target))!;
}

/** 抓取器满足的最小 client 接口。 */
export type OptionsChainClient = {
  fetchChain(symbol: string, targetDte: number): Promise<OptionChainSnapshot>;
  /** 权威「最近已收盘交易日」,给快照打戳用。moomoo 实现(Qot_RequestTradeDate);
   *  不实现(如 Deribit)或返回 null 时,上层回退 lastClosedTradingDate。 */
  getTradingDate?(): Promise<string | null>;
  /** 第二档:第一个 DTE ≥ minDte 的标准月度到期(见 monthlyExpiry);spot 复用第一档拿到的现货。
   *  只存原始链,不进 25Δ 表。不实现(Deribit)= 不抓第二档。 */
  fetchMonthlyChain?(symbol: string, minDte: number, spot: number | null): Promise<OptionChainSnapshot>;
};

type RunOpts = {
  db: Database;
  /** 数据来源,存入两张表的 source 列('moomoo' | 'deribit')。 */
  source: string;
  /** 要做快照的标的,例如 ['SPY']。原样存储为 `underlying` 键。 */
  underlyings: string[];
  client: OptionsChainClient;
  /** 另抓第二档(月度)到期日的标的;缺省按标的目录(secondExpiry)。 */
  secondExpiry?: readonly string[];
};

export type OptionsSnapshotResult = {
  rows: Options25DeltaRow[];
  /** 失败的标的,形如 'SPY: <原因>' / 'GLD 第二档: <原因>';由上层 job 决定记为 partial 还是 failed。 */
  failures: string[];
};

// 第二档到期日的最小 DTE:第一个 ≥60 天的月度,DTE 落在 60~95。
const SECOND_EXPIRY_MIN_DTE = 60;

export async function runOptionsSnapshot(opts: RunOpts): Promise<OptionsSnapshotResult> {
  // 打戳日期:优先用 client 的权威交易日(moomoo Qot_RequestTradeDate,认假期);
  // 取不到(Deribit 无此方法 / 调用失败)则回退本地推算(只跳周末、不认假期)。
  // 整批一个日期(同一市场同一交易日)。
  let snapshotDate: string;
  try {
    snapshotDate = (await opts.client.getTradingDate?.()) ?? lastClosedTradingDate();
  } catch {
    snapshotDate = lastClosedTradingDate();
  }
  const rows: Options25DeltaRow[] = [];
  const failures: string[] = [];
  const secondExpiry = new Set(opts.secondExpiry ?? secondExpiryUnderlyings());

  const toRaw = (u: string, chain: OptionChainSnapshot): OptionChainRawRow => ({
    underlying: u,
    source: opts.source,
    snapshotDate,
    expiry: chain.expirationDate,
    underlyingPrice: chain.underlyingPrice,
    // 归档完整的 chain(gzip 压缩),供日后分析使用(max pain、OI 分布、GEX 等)。
    // moomoo 的 chain 自带 Greeks,因此 GEX 可以直接从归档数据推导,无需重新定价。
    chainJsonGz: Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ calls: chain.calls, puts: chain.puts }))),
  });

  // 每个标的独立处理,成功一个就立刻落库:某个标的失败(抓取出错、超时、缺 delta 等)只记下来,
  // 不影响其它标的;也不会因为后面的标的卡住 / 进程被杀,把前面已拿到的数据一起丢掉(快照型补不回来)。
  for (const u of opts.underlyings) {
    try {
      const chain = await opts.client.fetchChain(u, TARGET_DTE);
      const sel = select25Delta(chain);

      // IV 以百分数存储(例如 16.63),方便图表坐标轴显示。
      const row: Options25DeltaRow = {
        underlying: u,
        source: opts.source,
        snapshotDate,
        callIv: sel.callIv * 100,
        putIv: sel.putIv * 100,
        skew: sel.skew * 100,
      };

      insertOptions25Delta(opts.db, [row]);
      insertOptionChainRaw(opts.db, [toRaw(u, chain)]);
      rows.push(row);

      if (!secondExpiry.has(u) || !opts.client.fetchMonthlyChain) continue;
      // 第二档只存原始链,25Δ 表仍只用第一档(换档会破坏已有序列的连续性)。
      // 失败也记进 failures(第一档已落库、照算 rows)→ 整组 partial → daily 守卫当天后续触发点重跑:
      // 快照型,当天没抓到就永久缺一格。重跑会把第一档也重抓一遍,触发点都在收盘后,覆盖写的是同一份收盘数据。
      try {
        const monthly = await opts.client.fetchMonthlyChain(u, SECOND_EXPIRY_MIN_DTE, chain.underlyingPrice);
        insertOptionChainRaw(opts.db, [toRaw(u, monthly)]);
      } catch (err) {
        failures.push(`${u} 第二档: ${(err as Error).message}`);
      }
    } catch (err) {
      failures.push(`${u}: ${(err as Error).message}`);
    }
  }

  // 成功的行已逐个落库;失败的标的一并回传,由上层 job 据此记 success/partial/failed
  // (与 quotes/macro/cboe 分组的三态一致),不让个别标的拖垮整批。
  return { rows, failures };
}

export { TARGET_DTE };
