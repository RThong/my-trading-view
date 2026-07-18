// 标的目录:一条 = 一个标的的全部元数据。前后端都从这里派生,消灭原来散在
// 前端 tab / IV_INDEX、server 白名单、VRP RECIPE、抓取 job 腿列表里的多份平行配置
// (改一处即全局生效)。本文件 JSON-safe:不 import 任何前端/后端代码。
//
// 边界:catalog 只声明"是什么";异构的**抓取行为**(VIX 双写、DVOL 走 deribit、
// 指数无现货)仍留在各 job/adapter,不塞进这里。
export type MarketAsset = {
  underlying: string; // 数据键 / 期权代码(SPY / .VIX / BTC / NOBL)
  optionSource: 'moomoo' | 'deribit' | 'none'; // none = 只做价格(NOBL)
  tab?: { id: string; label: string }; // 有 → 进「期权」视角横 tab(NOBL 无)
  index?: boolean; // 指数(.VIX):无现货报价,不抓 price
  vrp?: { ivIndex: string; window: number; periodsPerYear: number }; // 有 → 做 VRP;spot 恒 = underlying
};

export const MARKET_CATALOG: MarketAsset[] = [
  {
    underlying: 'SPY',
    optionSource: 'moomoo',
    tab: { id: 'spy', label: 'SPY' },
    vrp: { ivIndex: 'VIX', window: 21, periodsPerYear: 252 },
  },
  {
    underlying: 'QQQ',
    optionSource: 'moomoo',
    tab: { id: 'qqq', label: 'QQQ' },
    vrp: { ivIndex: 'VXN', window: 21, periodsPerYear: 252 },
  },
  { underlying: '.VIX', optionSource: 'moomoo', tab: { id: 'vix', label: 'VIX' }, index: true }, // 指数,无现货 / 无 VRP
  { underlying: 'TLT', optionSource: 'moomoo', tab: { id: 'tlt', label: 'TLT' } }, // 无免费波动率指数,只 2-pane
  {
    underlying: 'GLD',
    optionSource: 'moomoo',
    tab: { id: 'gld', label: 'GLD' },
    vrp: { ivIndex: 'GVZ', window: 21, periodsPerYear: 252 },
  },
  {
    underlying: 'USO',
    optionSource: 'moomoo',
    tab: { id: 'uso', label: 'USO' },
    vrp: { ivIndex: 'OVX', window: 21, periodsPerYear: 252 },
  },
  {
    underlying: 'BTC',
    optionSource: 'deribit',
    tab: { id: 'btc', label: 'BTC' },
    vrp: { ivIndex: 'DVOL', window: 30, periodsPerYear: 365 },
  },
  { underlying: 'NOBL', optionSource: 'none' }, // 只做价格:攻防指标的防御腿
];

/** 某期权源的标的清单(moomoo / deribit 白名单;none = 仅价格如 NOBL)。 */
export const optionUnderlyings = (source: MarketAsset['optionSource']): string[] =>
  MARKET_CATALOG.filter((a) => a.optionSource === source).map((a) => a.underlying);

export type VrpRecipe = { iv: string; spot: string; window: number; periodsPerYear: number };

/** VRP 配方:underlying → { iv 指数, spot(=underlying), RV 窗口, 年化周期 }。 */
export const vrpRecipes = (): Record<string, VrpRecipe> =>
  Object.fromEntries(
    MARKET_CATALOG.filter((a) => a.vrp).map((a) => [
      a.underlying,
      { iv: a.vrp!.ivIndex, spot: a.underlying, window: a.vrp!.window, periodsPerYear: a.vrp!.periodsPerYear },
    ]),
  );

/** 前端图例:underlying → IV 指数名(SPY→VIX 等)。 */
export const ivIndexByUnderlying = (): Record<string, string> =>
  Object.fromEntries(MARKET_CATALOG.filter((a) => a.vrp).map((a) => [a.underlying, a.vrp!.ivIndex]));

/** 走 OpenD/Yahoo 抓现货价的标的:非指数、非 deribit(BTC 价由 crypto job 单独抓)。 */
export const priceLegUnderlyings = (): string[] =>
  MARKET_CATALOG.filter((a) => !a.index && a.optionSource !== 'deribit').map((a) => a.underlying);

/** 从 CBOE 抓的 IV 指数腿:moomoo VRP 标的的 ivIndex,排除 VIX(它另经 VX 链路双写,不走这条)。 */
export const cboeIvLegs = (): string[] =>
  MARKET_CATALOG.filter((a) => a.vrp && a.optionSource === 'moomoo' && a.vrp.ivIndex !== 'VIX').map(
    (a) => a.vrp!.ivIndex,
  );
