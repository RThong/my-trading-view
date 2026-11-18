// 期权链抓取器(moomoo / CBOE / Deribit)共同实现的接口与数据形状;消费方是 jobs/ 下的期权快照流程(optionsSnapshot / daily 及一次性修复、对比脚本)。

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

/** 抓取器满足的最小 client 接口。 */
export type OptionsChainClient = {
  fetchChain(symbol: string, targetDte: number): Promise<OptionChainSnapshot>;
  /** 权威「最近已收盘交易日」,给快照打戳用。moomoo 实现(Qot_RequestTradeDate);
   *  不实现(如 Deribit)或返回 null 时,上层回退 lastClosedTradingDate。 */
  getTradingDate?(): Promise<string | null>;
  /** 第二档:第一个 DTE ≥ minDte 的标准月度到期(见 analytics/monthlyExpiry);spot 复用第一档拿到的现货。
   *  只存原始链,不进 25Δ 表。不实现(Deribit)= 不抓第二档。 */
  fetchMonthlyChain?(symbol: string, minDte: number, spot: number | null): Promise<OptionChainSnapshot>;
};
