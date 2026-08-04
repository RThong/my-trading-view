// AI 链的 SEC 名单。**前后端共用**:job 用它决定抓谁、算谁的合计;面板用它派生「一家一个横 tab」。
// CIK 取自官方 company_tickers.json。(TSM / ASML 为何进不来,见下方名单末尾的说明。)
//
// side 决定这家进哪条判据,**不是分类标签而是口径**:
//  · buyer(花钱建算力)= §6.14「capex 有没有吃穿现金流」的对象,只有这一侧进买方合计 FCF。
//  · seller(收钱)= 看毛利率(稀缺溢价 / 产能紧张),**绝不能进合计**——卖方在涨价周期里正 FCF 极大
//    (实测 NVDA+MU 一度垫 +1290 亿),混进来会把零轴永远垫在下方,「跌破零轴」永远不成立。
export type SecSide = 'buyer' | 'seller';

// inChain=false:CIK 在目录里备查,但**不在这两条信号的因果链上**(INTC 的毛利率不反映 AI 稀缺溢价),
// 不建议开启用;面板文案不把它当判据成员列出,买方合计线也不收它(见 isAggregateMember)。
type Company = { ticker: string; cik: string; side: SecSide; inChain?: boolean };

export const SEC_COMPANIES: Company[] = [
  // 卖铲子:看毛利率
  { ticker: 'NVDA', cik: '1045810', side: 'seller', inChain: true },
  { ticker: 'MU', cik: '723125', side: 'seller', inChain: true }, // 美光:毛利率 = DRAM/NAND 价格周期的免费代理
  // 买铲子:进合计 FCF
  { ticker: 'MSFT', cik: '789019', side: 'buyer', inChain: true },
  { ticker: 'GOOGL', cik: '1652044', side: 'buyer', inChain: true },
  { ticker: 'AMZN', cik: '1018724', side: 'buyer', inChain: true },
  { ticker: 'META', cik: '1326801', side: 'buyer', inChain: true },
  { ticker: 'ORCL', cik: '1341439', side: 'buyer', inChain: true },
  // 备查但**不建议开**(inChain 省略 = false),开了只会给对应那条线加噪声。
  // 已移除:AAPL(不在 AI 链上,FCF 由 iPhone 主导)、DELL(整机厂,毛利率不反映芯片稀缺溢价)、
  // AVGO(合并了 VMware,毛利率是「AI 硅片定价权 + 软件占比」的混合读数,当稀缺溢价用不干净)。
  //
  // TSM / ASML **不能进这条管线**:两家都只报 20-F(TSM 还走 ifrs-full taxonomy),
  // 实测四个科目的季度行均为 0 → 一个 TTM 点都算不出。它们真正有价值的读数也不在 SEC ——
  // TSM 是月营收(TWSE,每月 10 日)、ASML 是季度 net bookings(IR 季报),都要另立需求。
  { ticker: 'INTC', cik: '50863', side: 'seller' },
];

/** 已通过逐家毛利率核对、可入库的标的。核对一家开一家 —— 未核对的进来会污染派生线。 */
export const SEC_ACTIVE_TICKERS = ['NVDA', 'MU', 'MSFT', 'ORCL'];

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

// ── 各 side 的**必需科目**与已知结构性缺口 ────────────────────────────────────

/**
 * 完整性体检要求的科目,按 side 分 —— 守卫该要求「判据真正用到的」,不是「四个都齐」。
 *  · buyer 的判据是 FCF(ocf − capex);它的毛利率由本业(云/广告/软件)主导,是配角。
 *  · seller 的判据是毛利率(稀缺溢价);它的 FCF 不进合计线。
 * 非必需科目缺了照样在日志里提一句,但不把 job 变黄 —— 常驻黄灯会把真信号淹掉。
 */
export const REQUIRED_CONCEPTS_BY_SIDE: Record<SecSide, string[]> = {
  buyer: ['ocf', 'capex'],
  seller: ['revenue', 'cogs'],
};

/**
 * 已知的**结构性缺口**:这个 (ticker, concept) 在 companyfacts 里永远拿不到,报警也修不掉。
 * 键是 `TICKER.concept`。命中就完全不报 —— 这不是「还没修」,是「换源才能修」,
 * 而换源是另立需求。面板那格会空着,desc 里写明原因。
 *
 * ⚠️ 不要写成「SEC 里没有」:数在 SEC 的**原始 XBRL** 里,只是 companyfacts API
 * 不聚合公司自定义(extension)概念。两件事的处置方向完全不同。
 */
export const KNOWN_GAPS: Record<string, string> = {
  'ORCL.cogs':
    'ORCL 2018 年后用公司自定义 XBRL 分项披露收入成本(实测 2026Q3 10-Q,accession ' +
    '0001193125-26-101045:orcl:CloudAndSoftwareExpenses 4.776B + orcl:HardwareExpenses 0.183B + ' +
    'orcl:ServicesExpense 1.133B = 6.092B,对营收 17.190B → 毛利率约 64.6%)。' +
    'companyfacts 只聚合标准 taxonomy、不收 extension → 这条线要接原始 XBRL / DERA ZIP 才有,另立需求。' +
    '注:ORCL 把无形资产摊销单列在这三个直接成本之外,真接入时口径与其他公司不同。' +
    '组件还改过名(2019 年是 orcl:CloudServicesAndLicenseSupportExpenses)。',
};

export const knownGap = (ticker: string, concept: string): string | undefined => KNOWN_GAPS[`${ticker}.${concept}`];

export const secKey = (ticker: string, kind: SecKind): string => `sec:${ticker}:${kind}`;
export const SEC_BUYER_FCF_KEY = 'sec:buyerFcf';
