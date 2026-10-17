/**
 * moomoo OpenD 期权链抓取器(WebSocket)。
 *
 * 返回 optionsSnapshot.ts 定义的 OptionChainSnapshot 结构,这样后续流水线
 * (select25Delta、原始数据归档)无需关心数据来源。moomoo 提供交易所级别的
 * OI/IV 以及预先算好的希腊字母(delta/gamma/vega/theta/rho),我们将其作为
 * 可选字段一并透传。
 *
 * 两步协议:
 *   1. GetOptionChain  → 拉取某个日期窗口内的静态信息(合约代码、行权价)
 *   2. GetSecuritySnapshot(按 ≤400 分批)→ 拉取动态数据(OI/IV/希腊字母/行情)
 *
 * 需要 OpenD 在运行且已开启 WebSocket(默认端口 33333),并在环境变量里配置
 * 鉴权 key。详见 .env:MOOMOO_WS_HOST / MOOMOO_WS_PORT / MOOMOO_WS_KEY。
 */

import type { OptionChainSnapshot, OptionContract, OptionsChainClient } from '../jobs/optionsSnapshot';
import { nextMonthlyExpiry } from '../jobs/monthlyExpiry';
import { QOT_MARKET_US, envConfig, rateGate, withConnection, type ConnOpts, type MoomooConfig } from './moomooClient';
import { fetchUsTradingDates } from './moomooHistoryKL';
import { lastClosedFrom } from '../jobs/tradingCalendar';
import { firstBy } from 'remeda';

const SNAPSHOT_BATCH = 400;

// moomoo 官方限频:GetOptionChain 每 30 秒 10 次、GetSecuritySnapshot 每 30 秒 60 次。
// 换成最小间隔再留点余量;闸门是模块级的 → 整个进程共用一份额度。
const CHAIN_INTERVAL_MS = 3_200;
const SNAPSHOT_INTERVAL_MS = 550;

type Gate = () => Promise<void>;
type Deps = { cfg: () => MoomooConfig; conn?: ConnOpts; chainGate: Gate; snapshotGate: Gate };

const DEFAULT_DEPS: Deps = {
  cfg: envConfig,
  chainGate: rateGate(CHAIN_INTERVAL_MS),
  snapshotGate: rateGate(SNAPSHOT_INTERVAL_MS),
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * moomoo 文档里 strikeTime 标注为 "yyyy-MM-dd"。这里选择校验而非盲信:
 * 一旦格式异常(例如返回的是 datetime),下游解析会得到 Invalid Date,
 * 从而悄无声息地破坏 25Δ 选取。宁可显式报错——抛出的异常会被 daily job
 * 的 options group 捕获并记录为一次失败。
 */
function expiryDate(raw: unknown): string {
  const s = String(raw ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Unexpected moomoo strikeTime format: ${JSON.stringify(raw)}`);
  }
  return s;
}

type StaticContract = { code: string; strikePrice: number };

async function fetchStaticChain(
  ws: any,
  gate: Gate,
  symbol: string,
  begin: string,
  end: string,
): Promise<StaticExpiry[]> {
  await gate();
  const res = await ws.GetOptionChain({
    c2s: {
      owner: { market: QOT_MARKET_US, code: symbol },
      beginTime: begin,
      endTime: end,
    },
  });
  const chains = res?.s2c?.optionChain ?? [];

  return chains.map((ch: any) => {
    const options: any[] = ch.option ?? [];
    const calls: StaticContract[] = options
      .filter((o) => o.call?.basic?.security?.code)
      .map((o) => ({ code: o.call.basic.security.code, strikePrice: o.call.optionExData?.strikePrice }));
    const puts: StaticContract[] = options
      .filter((o) => o.put?.basic?.security?.code)
      .map((o) => ({ code: o.put.basic.security.code, strikePrice: o.put.optionExData?.strikePrice }));

    return { expiry: expiryDate(ch.strikeTime), calls, puts };
  });
}

async function fetchSnapshots(ws: any, gate: Gate, codes: string[]): Promise<Map<string, any>> {
  const byCode = new Map<string, any>();
  for (let i = 0; i < codes.length; i += SNAPSHOT_BATCH) {
    const batch = codes.slice(i, i + SNAPSHOT_BATCH);
    await gate();
    const res = await ws.GetSecuritySnapshot({
      c2s: { securityList: batch.map((code) => ({ market: QOT_MARKET_US, code })) },
    });
    for (const s of res?.s2c?.snapshotList ?? []) {
      const code = s.basic?.security?.code;
      if (code) byCode.set(code, s);
    }
  }

  return byCode;
}

async function fetchSpot(ws: any, gate: Gate, symbol: string): Promise<number> {
  const v = (await fetchSnapshots(ws, gate, [symbol])).get(symbol)?.basic?.curPrice;
  if (typeof v !== 'number') throw new Error(`Could not get spot price for ${symbol}`);
  return v;
}

type StaticExpiry = { expiry: string; calls: StaticContract[]; puts: StaticContract[] };

/** 对选中到期日的所有行权价(看涨 + 看跌)拉 snapshot,拼成 OptionChainSnapshot。 */
async function buildSnapshot(
  ws: any,
  gate: Gate,
  symbol: string,
  best: StaticExpiry,
  spot: number | null,
): Promise<OptionChainSnapshot> {
  const snaps = await fetchSnapshots(
    ws,
    gate,
    [...best.calls, ...best.puts].map((c) => c.code),
  );
  const toContracts = (arr: StaticContract[]) =>
    arr.map((c) => toContract(c, snaps.get(c.code))).filter((c): c is OptionContract => c !== null);

  return {
    underlyingSymbol: symbol,
    underlyingPrice: spot,
    expirationDate: best.expiry,
    calls: toContracts(best.calls),
    puts: toContracts(best.puts),
  };
}

function toContract(staticC: StaticContract, snap: any): OptionContract | null {
  const ox = snap?.optionExData;
  const basic = snap?.basic;
  if (!ox || typeof ox.impliedVolatility !== 'number') return null;
  return {
    contractSymbol: staticC.code,
    strike: staticC.strikePrice,
    expiration: expiryDate(ox.strikeTime),
    // moomoo 的 IV 以百分数给出(19.296 表示 19.296%);这里归一化成小数
    //(0.20 表示 20%),与流水线约定一致。
    impliedVolatility: ox.impliedVolatility / 100,
    bid: typeof basic?.bidPrice === 'number' ? basic.bidPrice : null,
    ask: typeof basic?.askPrice === 'number' ? basic.askPrice : null,
    lastPrice: typeof basic?.curPrice === 'number' ? basic.curPrice : null,
    volume: basic?.volume != null ? Number(basic.volume) : null,
    openInterest: typeof ox.openInterest === 'number' ? ox.openInterest : null,
    inTheMoney: false, // moomoo 不直接给这个标记;需要时在后续环节推导
    lastTradeDate: basic?.updateTime ?? null,
    // 希腊字母全部归档:moomoo 已算好一并推来,快照型数据丢了补不回来。
    delta: typeof ox.delta === 'number' ? ox.delta : null,
    gamma: typeof ox.gamma === 'number' ? ox.gamma : null,
    vega: typeof ox.vega === 'number' ? ox.vega : null,
    theta: typeof ox.theta === 'number' ? ox.theta : null,
    rho: typeof ox.rho === 'number' ? ox.rho : null,
  };
}

export function defaultMoomooOptionsClient(deps: Deps = DEFAULT_DEPS): OptionsChainClient {
  return {
    // 权威美股交易日(Qot_RequestTradeDate),给快照打戳用;自开短连接,失败由上层兜底。
    async getTradingDate() {
      const days = await withConnection(deps.cfg(), (ws) => fetchUsTradingDates(ws), deps.conn);
      return lastClosedFrom(days);
    },

    async fetchChain(symbol, targetDte) {
      // 延迟读取配置:这样即便缺少 MOOMOO_WS_KEY,异常也会在 options group
      // 的 try/catch 里浮现(经 finishJobRun 记录),而不是在构造时就抛出、
      // 把整个 daily job 直接拖垮。
      const cfg = deps.cfg();
      return withConnection(
        cfg,
        async (ws) => {
          // 在目标 DTE 附近取一个窗口(±10 天),确保能命中一个已上市的到期日。
          const now = Date.now();
          const begin = isoDate(new Date(now + (targetDte - 10) * 86400_000));
          const end = isoDate(new Date(now + (targetDte + 10) * 86400_000));

          const expiries = await fetchStaticChain(ws, deps.chainGate, symbol, begin, end);
          if (expiries.length === 0) {
            throw new Error(`No expiries for ${symbol} in ${begin}..${end}`);
          }

          // 选取与 targetDte 距离最近的那个到期日(每个到期日的距离只算一次)。
          const target = now + targetDte * 86400_000;
          const best = firstBy(expiries, (e) => Math.abs(new Date(e.expiry + 'T16:00:00Z').getTime() - target))!;

          // 标的现价:对标的本身拉取 snapshot。指数(双点代码,如 .VIX)没有现货报价权限
          //(必回「暂不支持美股指数」),直接跳过、spot 存 null —— 25Δ 选取只用合约 delta,不依赖现货。
          // 个股/ETF 则必须拿到现货:取不到就报错,避免把瞬时故障静默存成 null。
          const spot = symbol.startsWith('.') ? null : await fetchSpot(ws, deps.snapshotGate, symbol);

          return buildSnapshot(ws, deps.snapshotGate, symbol, best, spot);
        },
        deps.conn,
      );
    },

    async fetchMonthlyChain(symbol, minDte, spot) {
      const kind = symbol === '.VIX' ? 'vix' : 'equity';
      const expiry = nextMonthlyExpiry(kind, new Date(), minDte);
      // 遇假日交易所把到期提前一个交易日 → 窗口带上前一天。两天都有到期时取哪个,两类相反:
      //   ETF:周四可能是日度 / 周度,月度只在周五休市时才落到周四(那时周五没有到期)→ 优先周五;
      //   VIX:周二只会是被假日提前的月度,周三那份此时是 VIXW 周度 → 优先周二。
      const begin = isoDate(new Date(new Date(expiry).getTime() - 86400_000));
      const preferred = kind === 'vix' ? begin : expiry;

      return withConnection(
        deps.cfg(),
        async (ws) => {
          const expiries = await fetchStaticChain(ws, deps.chainGate, symbol, begin, expiry);
          const best = expiries.find((e) => e.expiry === preferred) ?? expiries[0];
          if (!best) throw new Error(`No monthly expiry for ${symbol} on ${expiry}`);

          // 现货复用第一档拿到的(同一轮、同一标的),不再多打一次快照。
          return buildSnapshot(ws, deps.snapshotGate, symbol, best, spot);
        },
        deps.conn,
      );
    },
  };
}
