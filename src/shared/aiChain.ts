// AI 链名单。**前后端共用**:job 用它决定抓谁、走哪个源;面板用它派生「一家一个横 tab」。
//
// side 决定这家进哪条判据,**不是分类标签而是口径**:
//  · buyer(花钱建算力)= §6.14「capex 有没有吃穿现金流」的对象,只有这一侧进买方合计 FCF。
//  · seller(收钱)= 看毛利率(稀缺溢价 / 产能紧张),**绝不能进合计**——卖方在涨价周期里正 FCF 极大
//    (实测 NVDA+MU 一度垫 +1290 亿),混进来会把零轴永远垫在下方,「跌破零轴」永远不成立。
export type SecSide = 'buyer' | 'seller';

/**
 * 数据源。**不是所有公司都能走 SEC** —— 非美国发行人只报 20-F/6-K,拿不到季度 XBRL,
 * 所以名单里每家自带 source,job / 路由 / 面板都按 source 查表分派(见 SOURCE_KINDS)。
 *  · sec  = data.sec.gov companyfacts(季度四科目 → 毛利率/capex/FCF/单季 FCF)
 *  · twse = 台湾证交所 OpenAPI(月营收 + 月营收同比;官方、T+10 天)
 * 加新源时:加一个 ChainSource 值 → 在 SOURCE_KINDS 补它的格子 → 在 job 的分派表补 updater
 *          → 在面板的分派表补 pane 构造。四处都是查表,漏一处是编译错误而不是静默降级。
 */
export type ChainSource = 'sec' | 'twse';

// 判别联合:SEC 那侧必须有 cik、TWSE 那侧必须有 twseCode —— 让「加了公司但忘了标识符」不可表达。
// inChain=false:已启用、有 tab 可看,但**不作判据成员**——面板的名单文案不把它列进去,
// 买方合计线也不收它(见 isAggregateMember)。给 INTC 用:它的毛利率是**供给侧读数**,
// 与 NVDA/MU 的「稀缺溢价」符号相反(INTC 毛利率修复 = 新产能进场 = 溢价见顶的旁证),
// 混在同一句「见顶回落 = 供给追上需求」里会读反。理由写在 COMPANY_NOTES.INTC。
type Common = { ticker: string; side: SecSide; inChain?: boolean };
type Company = (Common & { source?: 'sec'; cik: string }) | (Common & { source: 'twse'; twseCode: string });

export const SEC_COMPANIES: Company[] = [
  // 卖铲子:看毛利率
  { ticker: 'NVDA', cik: '1045810', side: 'seller', inChain: true },
  { ticker: 'MU', cik: '723125', side: 'seller', inChain: true }, // 美光:毛利率 = DRAM/NAND 价格周期的免费代理
  { ticker: 'AMD', cik: '2488', side: 'seller', inChain: true }, // 加速器侧的第二家,与 NVDA 对读(见 COMPANY_NOTES)
  // 代工:走 TWSE 而不是 SEC。TSM 的 SEC 侧实测只有**半年频**(180/181 天)且最新一期停在
  // 2024-12-31(ifrs-full 命名空间下四科目都在,但期间粒度和时效都不能用)。
  // TWSE 月营收反而是整条链里最快的读数(每月 10 日左右,T+10)。
  { ticker: 'TSM', twseCode: '2330', source: 'twse', side: 'seller', inChain: true },
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
  // 还进不来的:ASML(只报 20-F;有价值的是季度 net bookings,在 IR 季报里,另立需求)、
  // SK 海力士(2026-07 才在美上市,companyfacts 无财务 XBRL;它的 6-K 只有营收与营业利润、
  // **没有营业成本**,算不出毛利率 → 要毛利率得走韩国 DART,需要一个免费 API key)。
  { ticker: 'INTC', cik: '50863', side: 'seller' },
];

/** 已逐家核对过、可入库的标的。核对一家开一家 —— 未核对的进来会污染派生线。 */
export const ACTIVE_TICKERS = ['NVDA', 'MU', 'AMD', 'INTC', 'TSM', 'MSFT', 'ORCL', 'GOOGL', 'AMZN', 'META'];

const find = (ticker: string) => SEC_COMPANIES.find((c) => c.ticker === ticker);

export const cikOf = (ticker: string): string | undefined => {
  const c = find(ticker);
  return c && (c.source ?? 'sec') === 'sec' ? (c as { cik: string }).cik : undefined;
};
export const twseCodeOf = (ticker: string): string | undefined => {
  const c = find(ticker);
  return c?.source === 'twse' ? c.twseCode : undefined;
};
export const sideOf = (ticker: string): SecSide | undefined => find(ticker)?.side;
/** source 省略即 'sec' —— 多数公司走 SEC,不必每行都写。 */
export const sourceOf = (ticker: string): ChainSource => find(ticker)?.source ?? 'sec';
/** 某个源下、当前启用的标的(job 分派用)。 */
export const activeBySource = (source: ChainSource): string[] => ACTIVE_TICKERS.filter((t) => sourceOf(t) === source);

// ── 对外序列键(路由与面板必须用同一套,故在此定义一次)────────────────────────

/**
 * 每个源产出哪几种格子。**不同源的格子种类不同**,不能共用一张 kind 列表:
 * SEC 给四科目 → 能算毛利率/capex/FCF;TWSE 只给营收 → 只有月营收与同比。
 *
 * fcfq = **单季** FCF(不是 TTM)。判据是「跌破零轴」,而 TTM 要四季累积才跌破 ——
 * 实测 Alphabet 2026Q2 单季 −5.9B(IPO 以来首次为负)时 TTM 还有 +53.3B,按当时的烧钱速度
 * 推算 TTM 要到 2026Q4 才跌破零轴,**晚半年**。所以两个口径都得画。
 */
export const SOURCE_KINDS = {
  sec: ['gm', 'capex', 'fcf', 'fcfq'],
  twse: ['revM', 'revYoy'],
} as const satisfies Record<ChainSource, readonly string[]>;

export type SecKind = (typeof SOURCE_KINDS)['sec'][number];
export type TwseKind = (typeof SOURCE_KINDS)['twse'][number];
export type FundKind = SecKind | TwseKind;

export const SEC_KINDS: readonly SecKind[] = SOURCE_KINDS.sec;
/** 这家会有哪几个格子 —— 面板与路由都从这里派生,加源不用改它们。 */
export const kindsOf = (ticker: string): readonly FundKind[] => SOURCE_KINDS[sourceOf(ticker)];

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

/**
 * 各家 capex 的**已知口径**(analytics 的 CapexScope 值)。未列出的按 `ppe`。
 *
 * 为什么要声明而不是直接报「大家不一致」:AMZN 2017-03-31 之后就不再披露 us-gaap 的纯 PP&E tag
 * (companyfacts 实测:ppe 覆盖到 2017-03-31,productive_assets 从 2016-12-31 起到今天),
 * **没有可选项** —— 这个不一致永远存在,报成 failed 就是一盏永久黄灯,会把真信号淹掉
 * (同 REQUIRED_CONCEPTS_BY_SIDE 的理由)。
 *
 * 真正值得报的是**偏离声明**:某家的 tag 换了档(如 AMZN 哪天又开始报纯 PP&E,
 * 或第五家买方切过去)。那时口径变了,合计线的可比性也变了,必须有人看一眼。
 * 不可比本身写在面板文案里(见 regimeChart.hooks 的 SEC_LEASE_CAVEAT),不靠告警提醒。
 */
export const CAPEX_SCOPE_EXPECTED: Record<string, string> = {
  AMZN: 'productive_assets',
};

export const expectedCapexScope = (ticker: string): string => CAPEX_SCOPE_EXPECTED[ticker] ?? 'ppe';

/**
 * 「远端已交更新的 10-Q/10-K,但我们库里还没有那一期」。后端由 sec_watermark 与
 * sec_fundamentals 比 filed 得出(见 storage/repository 的 getSecLag),前端据此在那一格
 * 标注「这条线不是最新已报季度」—— 否则读图的人会把三个月前的点当成最新读数。
 */
export type SecLag = {
  ticker: string;
  remoteFiled: string; // submissions 里最新定期报告的申报日
  localFiled: string | null; // 我们已有的最新申报日;null = 这家一行都没有
  latestPeriodEnd: string | null; // 我们已有的最新期末,用来在文案里说清「截至哪一期」
};

/**
 * 面板/路由之间传数据用的键。前缀 `fund:` 表示「基本面序列」,**与来源无关** ——
 * 早先叫 `sec:`,加了 TWSE 源之后那个前缀就成了谎(`sec:TSM:revM` 的数据来自台湾证交所)。
 * 路由的缓存规则也按这个前缀判断,改前缀时两处要一起改。
 */
export const fundKey = (ticker: string, kind: FundKind): string => `fund:${ticker}:${kind}`;
export const FUND_KEY_PREFIX = 'fund:';
export const SEC_BUYER_FCF_KEY = 'fund:buyerFcf';
export const SEC_BUYER_FCFQ_KEY = 'fund:buyerFcfQ';
