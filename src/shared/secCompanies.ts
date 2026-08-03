// AI 链的 SEC 名单。**前后端共用**:job 用它决定抓谁、算谁的合计;面板用它派生「一家一个横 tab」。
// CIK 取自官方 company_tickers.json。TSM(0001046179)报 20-F、走 IFRS taxonomy,不在 us-gaap 里,另立需求。
//
// side 决定这家进哪条判据,**不是分类标签而是口径**:
//  · buyer(花钱建算力)= §6.14「capex 有没有吃穿现金流」的对象,只有这一侧进买方合计 FCF。
//  · seller(收钱)= 看毛利率(稀缺溢价 / 产能紧张),**绝不能进合计**——卖方在涨价周期里正 FCF 极大
//    (实测 NVDA+MU 一度垫 +1290 亿),混进来会把零轴永远垫在下方,「跌破零轴」永远不成立。
export type SecSide = 'buyer' | 'seller';

// inChain=false:CIK 在目录里备查,但**不在这两条信号的因果链上**(DELL/INTC 的毛利率不反映 AI
// 稀缺溢价),不建议开启用;面板文案不把它当判据成员列出,买方合计线也不收它(见 buyerTickers)。
type Company = { ticker: string; cik: string; side: SecSide; inChain?: boolean };

export const SEC_COMPANIES: Company[] = [
  // 卖铲子:看毛利率
  { ticker: 'NVDA', cik: '1045810', side: 'seller', inChain: true },
  { ticker: 'AVGO', cik: '1730168', side: 'seller', inChain: true },
  { ticker: 'MU', cik: '723125', side: 'seller', inChain: true }, // 美光:毛利率 = DRAM/NAND 价格周期的免费代理
  // 买铲子:进合计 FCF
  { ticker: 'MSFT', cik: '789019', side: 'buyer', inChain: true },
  { ticker: 'GOOGL', cik: '1652044', side: 'buyer', inChain: true },
  { ticker: 'AMZN', cik: '1018724', side: 'buyer', inChain: true },
  { ticker: 'META', cik: '1326801', side: 'buyer', inChain: true },
  { ticker: 'ORCL', cik: '1341439', side: 'buyer', inChain: true },
  // 以下两家备查但**不建议开**(inChain 省略 = false),开了只会给对应那条线加噪声。
  // (AAPL 已移除:它压根不在 AI 链上,FCF 由 iPhone 主导。)
  { ticker: 'DELL', cik: '1571996', side: 'seller' },
  { ticker: 'INTC', cik: '50863', side: 'seller' },
];

/** 已通过逐家毛利率核对、可入库的标的。核对一家开一家 —— 未核对的进来会污染派生线。 */
export const SEC_ACTIVE_TICKERS = ['NVDA', 'MU'];

export const cikOf = (ticker: string): string | undefined => SEC_COMPANIES.find((c) => c.ticker === ticker)?.cik;
export const sideOf = (ticker: string): SecSide | undefined => SEC_COMPANIES.find((c) => c.ticker === ticker)?.side;

// ── 对外序列键(路由与面板必须用同一套,故在此定义一次)────────────────────────

export type SecKind = 'gm' | 'capex' | 'fcf';
export const SEC_KINDS: SecKind[] = ['gm', 'capex', 'fcf'];

/** 因果链内的标的(面板文案列出这些,不列备查的那几家)。 */
export const chainTickers = (side: SecSide): string[] =>
  SEC_COMPANIES.filter((c) => c.inChain && c.side === side).map((c) => c.ticker);

/** 能进买方合计线的标的:**必须同时是 buyer 且在因果链内**。
 *  把它做成判据而不是靠「备查的那几家恰好都是 seller」这个巧合 —— 哪天往目录里加个
 *  非链内的 buyer(如 AAPL 那种 FCF 由本业主导的),它会静默把零轴垫高、判据直接失效。 */
export const isAggregateMember = (ticker: string): boolean =>
  SEC_COMPANIES.some((c) => c.ticker === ticker && c.inChain && c.side === 'buyer');

export const secKey = (ticker: string, kind: SecKind): string => `sec:${ticker}:${kind}`;
export const SEC_BUYER_FCF_KEY = 'sec:buyerFcf';
