import { firstBy } from 'remeda';
import { fetchWithTimeout } from './http';
import { nextMonthlyExpiry } from '../../shared/calc/monthlyExpiry';
import type { OptionChainSnapshot, OptionContract, OptionsChainClient } from './optionsChain';

// CBOE 网页「延迟报价」背后的期权链 JSON(无文档、免 key)。一个文件 = 该标的全部到期日的全部合约,
// 带 IV(小数)/ 希腊值 / OI / 全市场最优买卖价。2026-11 实测覆盖所有美国上市期权(个股 / ETF / 指数,指数前加 `_`)。
// 与 moomoo 逐合约对比(2026-11-13):不分红的 ETF IV 差 ≤ 0.2pp、OI 全同;TLT 差约 1pp —— CBOE 计入分红、moomoo 不计;
// VIX 差 4~7pp —— moomoo 以 VIX 现货(而非同到期远期)算 IV,且约八成快照抓在夜盘(报价空或极宽);
// CBOE 按中间价 + 同到期远期(Black-76),同日用中间价反解可复现到 1pp 内。
// 只有当天快照,盘中 15 分钟延迟。⚠️ 待验证:daily 首个触发点(冬令 JST 11:00 = 美东 21:00)已在 VIX 期权夜盘时段,
// 工作日夜里文件里的 VIX 是否仍是常规时段收盘报价,并行试跑时核对(看 last_trade_time 与价差)。周末样本是收盘值。
const URL_BASE = 'https://cdn-api.cboe.com/api/global/delayed_quotes/options/';
const UA = 'Mozilla/5.0 (compatible; my-trading-view/0.1)';
const DAY_MS = 86_400_000;
// 约 30 天那档:目标 DTE ±10 天内取最近的到期日(同 moomoo,见 moomooOptions.fetchChain)
const EXPIRY_WINDOW_DAYS = 10;

type CboeOption = {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  open_interest: number;
  volume: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  last_trade_price: number;
  last_trade_time: string | null;
};
type CboeChain = { current_price: number; options: CboeOption[] };

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** '.VIX' → '_VIX'(指数);ETF / 个股原样。 */
export function cboeSymbol(u: string): string {
  return u.startsWith('.') ? `_${u.slice(1)}` : u;
}

// OCC 代码:根代码 + YYMMDD + C/P + 行权价 × 1000(8 位)。VIX 有 VIX(月度)/ VIXW(周度)两个根,同一到期日通常只属于其中一个;VIXW 不用(见 fetchChain)
const OCC = /^([A-Z]+?)(\d{6})([CP])(\d{8})$/;

type Parsed = { expiry: string; type: 'C' | 'P'; contract: OptionContract };

export function parseCboeChain(data: CboeChain): Parsed[] {
  const spot = data.current_price;

  return data.options.flatMap((o): Parsed[] => {
    const m = OCC.exec(o.option);
    if (!m) return [];
    const expiry = `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4)}`;
    const type = m[3] as 'C' | 'P';
    const strike = Number(m[4]) / 1000;
    // CBOE 对没有报价的合约把 iv / delta 填 0(约一到两成,多是深度价外),与 moomoo 同,select25Delta 会剔掉
    return [
      {
        expiry,
        type,
        contract: {
          contractSymbol: o.option,
          strike,
          expiration: expiry,
          impliedVolatility: o.iv,
          bid: o.bid,
          ask: o.ask,
          lastPrice: o.last_trade_price || null,
          volume: o.volume,
          openInterest: o.open_interest,
          inTheMoney: type === 'C' ? strike < spot : strike > spot,
          lastTradeDate: o.last_trade_time,
          delta: o.delta,
          gamma: o.gamma,
          vega: o.vega,
          theta: o.theta,
          rho: o.rho,
        },
      },
    ];
  });
}

/** 文件里最后一笔成交的美东日期 = 这份快照所属的交易日(认假日,不用自己推交易日历)。 */
export function lastTradeDay(data: CboeChain): string | null {
  return (
    data.options
      .map((o) => o.last_trade_time)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1)
      ?.slice(0, 10) ?? null
  );
}

/** VIX 的周度合约(根代码 VIXW):没有同到期的 VX 期货,CBOE 的 IV / delta 按错的远期算(见 fetchChain),一律不用。 */
function isVixWeekly(p: Parsed): boolean {
  return p.contract.contractSymbol.startsWith('VIXW');
}

/** 某个到期日的链;VIX 只取月度合约(万一同一天也挂了 VIXW,不混进来)。 */
function snapshotOf(symbol: string, data: CboeChain, expiry: string): OptionChainSnapshot {
  const rows = parseCboeChain(data).filter((p) => p.expiry === expiry && !(symbol === '.VIX' && isVixWeekly(p)));
  if (!rows.length) throw new Error(`CBOE ${symbol}: 到期日 ${expiry} 没有合约`);
  return {
    underlyingSymbol: symbol,
    underlyingPrice: data.current_price || null,
    expirationDate: expiry,
    calls: rows.filter((p) => p.type === 'C').map((p) => p.contract),
    puts: rows.filter((p) => p.type === 'P').map((p) => p.contract),
  };
}

export function createCboeOptionsClient(
  deps: { fetch?: typeof fetchWithTimeout; now?: () => Date } = {},
): OptionsChainClient {
  const doFetch = deps.fetch ?? fetchWithTimeout;
  const now = deps.now ?? (() => new Date());
  // 同一轮里一个标的只下载一次(第一档 / 第二档 / 定交易日共用;大标的一份几 MB)
  const cache = new Map<string, Promise<CboeChain>>();
  const load = (u: string) => {
    const sym = cboeSymbol(u);
    if (!cache.has(sym)) {
      cache.set(
        sym,
        (async () => {
          // 2026-11-19 起不带 cboe.com 的 Referer 一律 403(Cloudflare);官网期权页自己请求时就带这个,存档 fetch.sh 同
          const headers = { 'User-Agent': UA, Referer: 'https://www.cboe.com/' };
          const res = await doFetch(`${URL_BASE}${sym}.json`, { headers }, 60_000);
          if (!res.ok) throw new Error(`CBOE 期权 ${sym} 下载失败:${res.status}`);
          const body = (await res.json()) as { data?: CboeChain };
          if (!body.data?.options?.length) throw new Error(`CBOE 期权 ${sym}:没有合约(结构可能变了)`);
          return body.data;
        })(),
      );
    }
    return cache.get(sym)!;
  };

  return {
    // 用 QQQ 那份的最后成交日打戳:QQQ 每个交易日都有成交,且在标的名单里(缓存复用、不多下载)。
    // 原用 SPY,2026-11-20 起 SPY 不抓链(25Δ 改用 SPX 30 天),换 QQQ 免得为定交易日单独下 6MB
    async getTradingDate() {
      return lastTradeDay(await load('QQQ'));
    },

    async fetchChain(symbol, targetDte) {
      const data = await load(symbol);
      const today = now().toISOString().slice(0, 10);
      const target = now().getTime() + targetDte * DAY_MS;
      // 窗口按日历日期框(同 moomoo:begin / end 是日期,两端都含),再按时刻取最近的那个
      const begin = isoDay(now().getTime() + (targetDte - EXPIRY_WINDOW_DAYS) * DAY_MS);
      const end = isoDay(now().getTime() + (targetDte + EXPIRY_WINDOW_DAYS) * DAY_MS);
      // VIX 只挑月度(根代码 VIX,不要周度 VIXW),且不卡 ±10 天窗口(月度间隔可达 35 天,窗口里可能一个都没有)。
      // 周度没有同到期的 VX 期货,CBOE 给的 IV / delta 按错的远期算:2026-11-20(VIX 收 35.89)12-23 周度按平价反推远期 25.6,
      // CBOE 却把行权价 27 的 put 算成 Δ−0.25、IV 222%(实为价内),skew 读成 +112;同日 12-16 月度远期 27.5、delta 与 VX 期货一致
      const vix = symbol === '.VIX';
      const expiries = [
        ...new Set(
          parseCboeChain(data)
            .filter((p) => !vix || !isVixWeekly(p))
            .map((p) => p.expiry),
        ),
      ].filter((e) => e > today && (vix || (e >= begin && e <= end)));
      const best = firstBy(expiries, (e) => Math.abs(Date.parse(`${e}T16:00:00Z`) - target));
      if (!best)
        throw new Error(
          vix
            ? `CBOE ${symbol}: 没有未到期的月度合约`
            : `CBOE ${symbol}: 目标 ${targetDte} 天 ±${EXPIRY_WINDOW_DAYS} 天内没有到期日`,
        );

      return snapshotOf(symbol, data, best);
    },

    // 第二档:同 moomoo 的选法(见 moomooOptions.fetchMonthlyChain),一次文件就有全部到期日,不用另查
    async fetchMonthlyChain(symbol, minDte) {
      const data = await load(symbol);
      const kind = symbol === '.VIX' ? 'vix' : 'equity';
      const have = new Set(parseCboeChain(data).map((p) => p.expiry));
      // 遇假日交易所把到期提前一天:ETF 优先周五(周四可能是周度),VIX 优先周二(周三那份是 VIXW 周度)
      const actual = (expiry: string) => {
        const before = isoDay(Date.parse(expiry) - DAY_MS);
        return (kind === 'vix' ? [before, expiry] : [expiry, before]).find((e) => have.has(e));
      };
      const minDay = isoDay(now().getTime() + minDte * DAY_MS);
      const first = nextMonthlyExpiry(kind, now(), minDte);
      // 提前一天后可能跌破 minDte(如 Good Friday 那个月)→ 改取下一个月度
      const firstActual = actual(first);
      const best =
        firstActual && firstActual >= minDay
          ? firstActual
          : // 从 first 的次日起找下一个月度(按日历日,与运行时刻无关)
            actual(nextMonthlyExpiry(kind, new Date(Date.parse(first) + DAY_MS), 0));
      if (!best) throw new Error(`CBOE ${symbol}: 没有月度到期 ${first}`);

      return snapshotOf(symbol, data, best);
    },
  };
}
