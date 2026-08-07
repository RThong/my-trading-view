// AI 链名单。**前后端共用**:job 用它决定抓谁、走哪个源;面板用它派生「一家一个横 tab」。
//
// side 决定这家进哪条判据,**不是分类标签而是口径**:
//  · buyer(花钱建算力)= §6.14「capex 有没有吃穿现金流」的对象,只有这一侧进买方合计 FCF。
//  · seller(收钱)= 看毛利率(稀缺溢价 / 产能紧张),**绝不能进合计**——卖方在涨价周期里正 FCF 极大
//    (实测 NVDA+MU 一度垫 +1290 亿),混进来会把零轴永远垫在下方,「跌破零轴」永远不成立。
export type SecSide = 'buyer' | 'seller';

/**
 * 数据源。**不是所有公司都能走 SEC companyfacts** —— 非美国发行人只报 20-F/6-K,
 * 拿不到季度 XBRL。所以名单里每家自带 sources,job / 路由 / 面板都按 source 查表分派。
 *  · sec   = data.sec.gov companyfacts(季度四科目 → 毛利率/capex/FCF/单季 FCF)
 *  · sec6k = TSM 交给 EDGAR 的季度合并财报 6-K(`tsm-fs*`)。HTML 报表,不是 XBRL,
 *            但**能回填**(实测 13 份、2023Q1 起)且**含现金流**,所以四个科目全有。
 *  · twse  = 台湾证交所 OpenAPI 月营收(官方、T+10 天,全链最快;不可回填)
 * 加新源时:加一个 ChainSource 值 → SOURCE_KINDS 补它的格子 → SOURCE_NEEDS 声明它要哪个
 *          标识符 → job 的分派表补 updater → 面板的分派表补 pane 构造。全是查表。
 */
export type ChainSource = 'sec' | 'sec6k' | 'twse';

/**
 * 每个源要哪个标识符。**一家可以同时走多个源**(TSM:毛利率/FCF 走 sec6k、月营收走 twse)——
 * 各测度的最佳来源本来就不同,硬塞进一个 source 会逼着二选一。
 * 类型上两个标识符都可选,由 aiChain.test 的不变式测试保证「声明了源就得有对应标识符」——
 * 判别联合表达不了「多源」这件事,而漏标识符会在 job 里变成运行时错误,故用测试兜。
 */
export const SOURCE_NEEDS: Record<ChainSource, 'cik' | 'twseCode'> = {
  sec: 'cik',
  sec6k: 'cik',
  twse: 'twseCode',
};

// inChain=false:已启用、有 tab 可看,但**不作判据成员**——面板的名单文案不把它列进去,
// 买方合计线也不收它(见 isAggregateMember)。给 INTC 用:它的毛利率是**供给侧读数**,
// 与 NVDA/MU 的「稀缺溢价」符号相反(INTC 毛利率修复 = 新产能进场 = 溢价见顶的旁证),
// 混在同一句「见顶回落 = 供给追上需求」里会读反。理由写在 COMPANY_NOTES.INTC。
/**
 * 面板上的分组。**按「这一格该怎么读」分,不是按行业分** —— 同组的 tab 可以互相比,
 * 跨组的不能(口径与符号都不同)。顺序即资金流向:云厂商花钱 → 算力芯片收钱 → 上游产能。
 *  · cloud       买铲子。判据是 FCF 会不会转负(§6.14),它们的毛利率是配角。
 *  · accelerator 直接卖加速器。毛利率 = 定价权,组内可横向比(NVDA vs AMD)。
 *  · upstream    代工与存储。物理瓶颈那一层;各自读法不同(TSM 看产能、MU 看价格周期),
 *                但都属于「供给能不能跟上」这一问,故同组。
 *  · watch       备查,**不作判据成员**。目前只有 INTC:它的毛利率符号与稀缺溢价相反。
 */
export type ChainGroup = 'cloud' | 'accelerator' | 'upstream' | 'watch';

export const GROUP_ORDER: ChainGroup[] = ['cloud', 'accelerator', 'upstream', 'watch'];
export const GROUP_LABELS: Record<ChainGroup, string> = {
  cloud: '云厂商',
  accelerator: '算力芯片',
  upstream: '上游产能',
  watch: '备查',
};

type Company = {
  ticker: string;
  side: SecSide;
  inChain?: boolean;
  group: ChainGroup;
  /** 省略 = ['sec']。多数公司只走一个源。 */
  sources?: ChainSource[];
  cik?: string;
  twseCode?: string;
  /** 报表币种,省略 = 'USD'。面板标题与说明按它写单位 —— 新台币的数不能和美元的比大小。 */
  currency?: 'USD' | 'TWD' | 'EUR';
};

export const SEC_COMPANIES: Company[] = [
  // 卖铲子:看毛利率
  { ticker: 'NVDA', cik: '1045810', side: 'seller', inChain: true, group: 'accelerator' },
  { ticker: 'MU', cik: '723125', side: 'seller', inChain: true, group: 'upstream' }, // 美光:毛利率 = DRAM/NAND 价格周期的免费代理
  { ticker: 'AMD', cik: '2488', side: 'seller', inChain: true, group: 'accelerator' }, // 加速器侧的第二家,与 NVDA 对读(见 COMPANY_NOTES)
  // 代工:**两个源各管一半**。companyfacts 那条不行(ifrs-full 下四科目都在,但期间只有
  // 半年/全年、且最新一期停在 2024-12-31),所以季度四科目走它交给 EDGAR 的季度合并财报 6-K,
  // 月营收走 TWSE(T+10,全链最快)。报表币种是新台币。
  {
    ticker: 'TSM',
    cik: '1046179',
    twseCode: '2330',
    sources: ['sec6k', 'twse'],
    side: 'seller',
    inChain: true,
    group: 'upstream',
    currency: 'TWD',
  },
  // 设备:同样是 FPI(荷兰),同样只能走季报 6-K。但比 TSM 好办 —— 它用 **US GAAP** 报、
  // 报表**单季直给**(不用差分)、**T+16**(不是 T+45),而且报表自己印了毛利率可作自校验。
  // ⚠️ 它 2026 年起**停发净订单(net bookings)**,最后一次是 2025Q4 —— 原先「ASML 的价值
  // 在季度订单」那个理由已不成立,现在读的是已发生的出货与它自己的扩产,不是领先指标。
  {
    ticker: 'ASML',
    cik: '937966',
    sources: ['sec6k'],
    side: 'seller',
    inChain: true,
    group: 'upstream',
    currency: 'EUR',
  },
  // 买铲子:进合计 FCF
  { ticker: 'MSFT', cik: '789019', side: 'buyer', inChain: true, group: 'cloud' },
  { ticker: 'GOOGL', cik: '1652044', side: 'buyer', inChain: true, group: 'cloud' },
  { ticker: 'AMZN', cik: '1018724', side: 'buyer', inChain: true, group: 'cloud' },
  { ticker: 'META', cik: '1326801', side: 'buyer', inChain: true, group: 'cloud' },
  { ticker: 'ORCL', cik: '1341439', side: 'buyer', inChain: true, group: 'cloud' },
  // 备查但**不建议开**(inChain 省略 = false),开了只会给对应那条线加噪声。
  // 已移除:AAPL(不在 AI 链上,FCF 由 iPhone 主导)、DELL(整机厂,毛利率不反映芯片稀缺溢价)、
  // AVGO(合并了 VMware,毛利率是「AI 硅片定价权 + 软件占比」的混合读数,当稀缺溢价用不干净)。
  //
  // 还进不来的:SK 海力士(2026-07 才在美上市,companyfacts 无财务 XBRL;它的 6-K 只有营收与营业利润、
  // **没有营业成本**,算不出毛利率 → 要毛利率得走韩国 DART,需要一个免费 API key)。
  { ticker: 'INTC', cik: '50863', side: 'seller', group: 'watch' },
];

/** 已逐家核对过、可入库的标的。核对一家开一家 —— 未核对的进来会污染派生线。 */
export const ACTIVE_TICKERS = ['NVDA', 'MU', 'AMD', 'INTC', 'TSM', 'ASML', 'MSFT', 'ORCL', 'GOOGL', 'AMZN', 'META'];

const find = (ticker: string) => SEC_COMPANIES.find((c) => c.ticker === ticker);

/** sources 省略即 ['sec'] —— 多数公司只走 companyfacts,不必每行都写。 */
export const sourcesOf = (ticker: string): ChainSource[] => find(ticker)?.sources ?? ['sec'];
export const hasSource = (ticker: string, source: ChainSource): boolean => sourcesOf(ticker).includes(source);

/** cik 只在这家真的走某个吃 cik 的源时才给 —— 否则 SEC job 会拿它去 companyfacts 白打一轮。 */
export const cikOf = (ticker: string): string | undefined => (hasSource(ticker, 'sec') ? find(ticker)?.cik : undefined);
/** sec6k 也吃 cik,但走的是 EDGAR Archives 而不是 companyfacts,故单独一个取值口。 */
export const sec6kCikOf = (ticker: string): string | undefined =>
  hasSource(ticker, 'sec6k') ? find(ticker)?.cik : undefined;
export const twseCodeOf = (ticker: string): string | undefined =>
  hasSource(ticker, 'twse') ? find(ticker)?.twseCode : undefined;

export const sideOf = (ticker: string): SecSide | undefined => find(ticker)?.side;
export const groupOf = (ticker: string): ChainGroup | undefined => find(ticker)?.group;
/** 某组里当前启用的标的,保持名单原顺序。 */
export const activeByGroup = (group: ChainGroup): string[] => ACTIVE_TICKERS.filter((t) => groupOf(t) === group);
export const currencyOf = (ticker: string): 'USD' | 'TWD' | 'EUR' => find(ticker)?.currency ?? 'USD';

/** 某个源下、当前启用的标的(job 分派用)。一家可能出现在多个源里。 */
export const activeBySource = (source: ChainSource): string[] => ACTIVE_TICKERS.filter((t) => hasSource(t, source));

/**
 * 原始行落在 `sec_fundamentals` 表里的那些源 —— 派生量(TTM / 毛利率 / FCF)对它们是同一套算法,
 * 所以 writeDerived 的范围是这个并集,不是单个源。少了 sec6k 那家的线永远不出。
 */
export const SEC_TABLE_SOURCES: ChainSource[] = ['sec', 'sec6k'];
export const activeInSecTable = (): string[] =>
  ACTIVE_TICKERS.filter((t) => SEC_TABLE_SOURCES.some((s) => hasSource(t, s)));

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
  // sec6k 产出的原始行落进同一张 sec_fundamentals 表,派生量走同一套算法 → 格子种类相同。
  sec6k: ['gm', 'capex', 'fcf', 'fcfq'],
  twse: ['revM', 'revYoy'],
} as const satisfies Record<ChainSource, readonly string[]>;

export type SecKind = (typeof SOURCE_KINDS)['sec'][number];
export type TwseKind = (typeof SOURCE_KINDS)['twse'][number];
export type FundKind = SecKind | TwseKind;

export const SEC_KINDS: readonly SecKind[] = SOURCE_KINDS.sec;

/**
 * 这家会有哪几个格子 = 它各个源的格子并集(去重,按 sources 顺序)。
 * 面板与路由都从这里派生,加源/加公司都不用改它们。
 */
export const kindsOf = (ticker: string): readonly FundKind[] => [
  ...new Set(sourcesOf(ticker).flatMap((s) => SOURCE_KINDS[s] as readonly FundKind[])),
];

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
 * 各买方「融资租赁新增 ROU / 该财年现金 capex」的**已声明档位**(上限)。只报**超出声明**的。
 *
 * 为什么需要这张表:走融资租赁取得的产能在 `ocf − capex` 里完全不出现(取得非现金、本金走筹资,
 * 只有利息进经营)—— 一家把采购改成租赁,当年 FCF 就无偿好看一整笔,而且不是延后是永远不来。
 * **MSFT 最近两个财年从 1~2% 跳到 21%,跳的时候没有任何人知道。** 这张表就是为了下次跳的时候有人知道。
 *
 * 同 CAPEX_SCOPE_EXPECTED 的思路:不报「大家不一致」(那是一盏永久黄灯,会把真信号淹掉),
 * 只报偏离。值是实测值向上留一档余量,**不是精确值** —— 目的是抓跳变,不是抓小数点。
 * 实测(新增 ROU / **同财年**现金 capex,守卫对真 companyfacts 跑出来的):
 *   MSFT 21.2%(财年止 2026-06-30) · ORCL 8.9% · AMZN 2.3% · GOOGL 1.8% · META 0.9%
 *
 * ⚠️ 这条守卫**只在「有新申报、真的拉了 companyfacts」那一轮报**(同 tagConflicts,原因也相同:
 * 这个科目不落库,事后查不出来)。稳态下水位不动 → 整段跳过 → 不报。所以它的可见性是
 * 「一个季度一次、在吃进新 10-K 的那天让 job 变黄」,不是「每轮复发」(那是完整性体检的性质)。
 * 改了下面的值不会立刻复查,要下一份定期报告进来才生效 —— 想立刻验就 `--force` 单跑那一家。
 *
 * 量化后的判据影响写在面板文案里(见 regimeChart.hooks 的 SEC_LEASE_CAVEAT),不靠告警传达 ——
 * 告警只回答「有没有变」,不回答「有多重要」。为什么不做成序列见 analytics 的 financeLeaseShare。
 */
export const FINANCE_LEASE_SHARE_CEILING: Record<string, number> = {
  MSFT: 0.3,
  ORCL: 0.15,
  AMZN: 0.05,
  GOOGL: 0.05,
  META: 0.05,
};

export const financeLeaseCeiling = (ticker: string): number | undefined => FINANCE_LEASE_SHARE_CEILING[ticker];

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
