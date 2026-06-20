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

// @ts-expect-error — moomoo-api 没有附带类型声明
import mmWebsocket from 'moomoo-api';
import type { OptionContract, OptionsChainClient } from '../jobs/optionsSnapshot';

const QOT_MARKET_US = 11;
const SNAPSHOT_BATCH = 400;
const LOGIN_TIMEOUT_MS = 10_000;

type MoomooConfig = {
  host: string;
  port: number;
  key: string;
};

function envConfig(): MoomooConfig {
  const key = process.env.MOOMOO_WS_KEY ?? '';
  if (!key) throw new Error('MOOMOO_WS_KEY not set');
  return {
    host: process.env.MOOMOO_WS_HOST ?? '127.0.0.1',
    port: Number(process.env.MOOMOO_WS_PORT ?? '33333'),
    key,
  };
}

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

/** 建立连接,执行 `fn`,然后无论如何都关闭 socket。 */
async function withConnection<T>(
  cfg: MoomooConfig,
  fn: (ws: any) => Promise<T>,
): Promise<T> {
  const ws = new mmWebsocket();
  ws.start(cfg.host, cfg.port, false, cfg.key);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenD login timeout')), LOGIN_TIMEOUT_MS);
      ws.onlogin = (ret: boolean, msg: string) => {
        clearTimeout(timer);
        ret ? resolve() : reject(new Error(`OpenD login failed: ${msg}`));
      };
    });
    return await fn(ws);
  } finally {
    // stop() 只是注销推送回调。底层 socket 及其重连定时器挂在 ws.websock 上
    // —— close() 会把这两者一起关掉,否则这个句柄会让事件循环一直存活,
    // daily CLI 永远退不出去。
    ws.stop();
    ws.websock?.close();
  }
}

type StaticContract = { code: string; strikePrice: number };

async function fetchStaticChain(
  ws: any,
  symbol: string,
  begin: string,
  end: string,
): Promise<{ expiry: string; calls: StaticContract[]; puts: StaticContract[] }[]> {
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

async function fetchSnapshots(ws: any, codes: string[]): Promise<Map<string, any>> {
  const byCode = new Map<string, any>();
  for (let i = 0; i < codes.length; i += SNAPSHOT_BATCH) {
    const batch = codes.slice(i, i + SNAPSHOT_BATCH);
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

export function defaultMoomooOptionsClient(): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte) {
      // 延迟读取配置:这样即便缺少 MOOMOO_WS_KEY,异常也会在 options group
      // 的 try/catch 里浮现(经 finishJobRun 记录),而不是在构造时就抛出、
      // 把整个 daily job 直接拖垮。
      const cfg = envConfig();
      return withConnection(cfg, async (ws) => {
        // 在目标 DTE 附近取一个窗口(±10 天),确保能命中一个已上市的到期日。
        const now = Date.now();
        const begin = isoDate(new Date(now + (targetDte - 10) * 86400_000));
        const end = isoDate(new Date(now + (targetDte + 10) * 86400_000));

        const expiries = await fetchStaticChain(ws, symbol, begin, end);
        if (expiries.length === 0) {
          throw new Error(`No expiries for ${symbol} in ${begin}..${end}`);
        }

        // 选取与 targetDte 距离最近的那个到期日(每个到期日的距离只算一次)。
        const target = now + targetDte * 86400_000;
        const best = expiries
          .map((e) => ({ e, diff: Math.abs(new Date(e.expiry + 'T16:00:00Z').getTime() - target) }))
          .reduce((a, b) => (b.diff < a.diff ? b : a)).e;

        // 对选中到期日的所有行权价(看涨 + 看跌)拉取 snapshot。
        const allStatic = [...best.calls, ...best.puts];
        const snaps = await fetchSnapshots(ws, allStatic.map((c) => c.code));

        const calls = best.calls
          .map((c) => toContract(c, snaps.get(c.code)))
          .filter((c): c is OptionContract => c !== null);
        const puts = best.puts
          .map((c) => toContract(c, snaps.get(c.code)))
          .filter((c): c is OptionContract => c !== null);

        // 标的现价:对标的本身拉取 snapshot。
        const underlyingSnap = await fetchSnapshots(ws, [symbol]);
        const spot = underlyingSnap.get(symbol)?.basic?.curPrice;
        if (typeof spot !== 'number') {
          throw new Error(`Could not get spot price for ${symbol}`);
        }

        return {
          underlyingSymbol: symbol,
          underlyingPrice: spot,
          expirationDate: best.expiry,
          calls,
          puts,
        };
      });
    },
  };
}
