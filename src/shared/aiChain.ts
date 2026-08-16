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
 *  · dart  = 韩国金融监督院 DART 的季度全表(SK 海力士唯一可行源 —— 它的 SEC 侧零财务 XBRL、
 *            6-K 只有营收与营业利润,算不出毛利率与 FCF)。要免费 key,T+45,可回填到 2016
 * 加新源时:加一个 ChainSource 值 → SOURCE_KINDS 补它的格子 → SOURCE_NEEDS 声明它要哪个
 *          标识符 → job 的分派表补 updater → 面板的分派表补 pane 构造。全是查表。
 */
export type ChainSource = 'sec' | 'sec6k' | 'twse' | 'dart';

/**
 * 每个源要哪个标识符。**一家可以同时走多个源**(TSM:毛利率/FCF 走 sec6k、月营收走 twse)——
 * 各测度的最佳来源本来就不同,硬塞进一个 source 会逼着二选一。
 * 类型上两个标识符都可选,由 aiChain.test 的不变式测试保证「声明了源就得有对应标识符」——
 * 判别联合表达不了「多源」这件事,而漏标识符会在 job 里变成运行时错误,故用测试兜。
 */
export const SOURCE_NEEDS: Record<ChainSource, 'cik' | 'twseCode' | 'dartCorpCode'> = {
  sec: 'cik',
  sec6k: 'cik',
  twse: 'twseCode',
  dart: 'dartCorpCode',
};

// inChain=false:已启用、有 tab 可看,但**不作判据成员**——面板的名单文案不把它列进去,
// 买方合计线也不收它(见 isAggregateMember)。目前只有 INTC:它和 TSM 同在代工层,
// 但处在衰退期,毛利率是**供给侧读数**、符号与稀缺溢价相反(INTC 毛利率修复 = 新产能进场),
// 所以它在组里是**对照样本**而不是判据成员。理由写在 COMPANY_NOTES.INTC。
/**
 * 面板上的分组。**按「这一格该怎么读」分,不是按行业分** —— 同组的 tab 可以互相比,
 * 跨组的不能。顺序即**资金流向**,也就是 §6.16 产业链投资法的正向拆解链:
 * FCF 增厚 → 扩 capex → 买设备。
 *
 *  · payer       capex 买单方(§6.14 的主角组)。判据是 FCF 会不会转负,毛利率是配角。
 *                组内两个异质点值得单独看:META **不卖云**(纯自用买家,没有云收入对冲),
 *                ORCL 是**举债最凶**的样本(§6.21 绑定链条的中间环节)—— 它和 MSFT 并排
 *                看 capex/FCF 劈叉最有信息量。
 *  · accelerator 算力芯片。**组内分两半读**:NVDA/AMD 是通用 GPU(CUDA 生态 = 结构性护城河),
 *                AVGO/ARM 是定制 ASIC + IP(**CSP 绕开 NVDA 的替代路径,不是补充**)。
 *                两半劈叉 = 大厂议价权变化的直接读数。
 *  · foundry     代工。TSM 是**结构性高毛利**样本(先进制程 + 设计生态);INTC 同层但在衰退期,
 *                是对照(它的毛利率修复 = 新产能进场,符号与稀缺溢价相反)。
 *  · memory      存储。MU/SKHY/SNDK 是**周期性高毛利**(供需缺口的产物,临界点低、重构快猛)。
 *                三家分工:MU = DRAM+NAND 全谱,SKHY = DRAM/HBM 重心,SNDK = **纯 NAND**。
 *                并排才拆得开「HBM 拉动」与「NAND 自身周期」。
 *  · equipment   设备。ASML 单列 —— 它不是「上游产能」,它是**产能的供给方**,差一层
 *                (EUV 近乎垄断无替代)。也是「FCF 增厚 → 扩 capex → 落到设备」这条传导的终点验证。
 *
 * ⚠️ **代工与存储必须分列,这是 §6.16 判据的前置条件**:结构性高毛利见顶后能维持许久,
 * 周期性高毛利见顶即退坡。两组毛利率分开才比得出来 —— 混在一组等于放弃这条判别力。
 *
 * 后续扩位时组结构不用改,直接挂进去(尚未接入,记在这里免得重新设计):
 *   payer      +AAPL(§6.21 的反差样本:同组内它的 capex 不该跟着爆)
 *   算力承包   +CRWV(neocloud 单列一层,ORCL 若要移出 payer 也归这里)
 *   equipment  +AMAT / LRCX / Advantest
 *   电力配套   +VRT / GEV(新层)
 *   中游软件   +IGV / CRM / VEEV(新层,§6.13 时间轴指向 2026)
 */
export type ChainGroup = 'payer' | 'accelerator' | 'foundry' | 'memory' | 'equipment';

export const GROUP_ORDER: ChainGroup[] = ['payer', 'accelerator', 'foundry', 'memory', 'equipment'];
export const GROUP_LABELS: Record<ChainGroup, string> = {
  payer: 'capex 买单',
  accelerator: '算力芯片',
  foundry: '代工',
  memory: '存储',
  equipment: '设备',
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
  /** DART 的 8 位고유번호(≠ 종목코드)。SK 海力士 = 00164779,종목코드 000660。 */
  dartCorpCode?: string;
  /** 报表币种,省略 = 'USD'。面板标题与说明按它写单位 —— 新台币的数不能和美元的比大小。 */
  currency?: 'USD' | 'TWD' | 'EUR' | 'KRW';
};

export const SEC_COMPANIES: Company[] = [
  // 卖铲子:看毛利率
  { ticker: 'NVDA', cik: '1045810', side: 'seller', inChain: true, group: 'accelerator' },
  { ticker: 'MU', cik: '723125', side: 'seller', inChain: true, group: 'memory' }, // 美光:毛利率 = DRAM/NAND 价格周期的免费代理
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
    group: 'foundry',
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
    group: 'equipment',
    currency: 'EUR',
  },
  // 买铲子:进合计 FCF
  { ticker: 'MSFT', cik: '789019', side: 'buyer', inChain: true, group: 'payer' },
  { ticker: 'GOOGL', cik: '1652044', side: 'buyer', inChain: true, group: 'payer' },
  { ticker: 'AMZN', cik: '1018724', side: 'buyer', inChain: true, group: 'payer' },
  { ticker: 'META', cik: '1326801', side: 'buyer', inChain: true, group: 'payer' },
  { ticker: 'ORCL', cik: '1341439', side: 'buyer', inChain: true, group: 'payer' },
  // 备查但**不建议开**(inChain 省略 = false),开了只会给对应那条线加噪声。
  // 已移除:AAPL(不在 AI 链上,FCF 由 iPhone 主导)、DELL(整机厂,毛利率不反映芯片稀缺溢价)。
  //
  // ⚠️ **买方这一侧到此封口**,上面五家已覆盖绝大部分 AI capex。剩下的候选要么私有
  // (xAI / OpenAI / Anthropic)、要么在另一套数据源体系里(阿里/腾讯/字节)、要么已排除(AAPL)。
  // **neocloud(CoreWeave / Nebius 那类)尤其不要往合计里塞**,两条都踩:
  //  · 数据只到 2022~2023,而 AI 扩产周期正是 2023 起 —— 合计线要求每季每家都有点,
  //    加进来会把扩产前的基线整段砍掉,判据一上来就在周期中段、没有参照。
  //  · 它们的商业模式就是举债建产能再租出去,FCF 天然长期为负 —— 会把零轴永远压在下方,
  //    和「卖方不能进合计」是同一类污染,只是方向相反。
  // 真要看 neocloud,那是另立一条线的事。
  // 存储的第二家。**唯一走 dart 源的** —— 它 2026-07 才在美上市,SEC 侧零财务 XBRL
  // (companyfacts 只有 `ffd` 命名空间 5 个 tag),6-K 与英文财报稿都只给营收/营业利润/净利,
  // **没有营业成本、没有现金流**。四科目只能从韩国 DART 拿(T+45,可回填到 2016)。
  // 与 MU 对读:同为存储,DRAM/NAND 价格周期的两个独立读数;它的 HBM 占比更高。
  {
    ticker: 'SKHY',
    dartCorpCode: '00164779',
    sources: ['dart'],
    side: 'seller',
    inChain: true,
    group: 'memory',
    currency: 'KRW',
  },
  // 存储的第三家,也是**唯一的纯 NAND 标的**(MU 是 DRAM+NAND、SKHY 重心在 DRAM/HBM)——
  // 三家并排才分得开「HBM 拉动」与「NAND 自身周期」这两件不同的事。
  //
  // ⚠️ 2025-02-21 从西部数据(WDC)分拆,**口径断点在分拆日、不在财年边界**(别按财年推:
  // 分拆日落在 2024-12-28~2025-03-28 那一季**内部**,那一季自己就横跨两种口径)。
  // 该日之前是 carve-out(拟制)报表,之后是独立公司合并报表。
  //
  // **但断点不是一刀切,按格分** —— 依据是 FY2025 10-K 自己印的分摊表(accession 0002023554-25-000034),
  // 它逐行列出母公司分摊落在哪:R&D 189 / SG&A 158 / 分拆费用 50 / 离职等 5(FY2025,百万美元;
  // FY2024 合计 1,165、FY2023 合计 1,263)。**表里没有 cost of revenue 那一行**:
  //  · 毛利率 / 营收 —— 这两格**不受这笔分摊影响**(表里没有 COGS 行),故**跨断点可读**。
  //    ⚠️ 只说可核的部分:同一份 10-K 的 MD&A 提到分摊还含「product sourcing / supply chain」这类
  //    天然属 COGS 的支持成本,但它没落进这张按行拆的表 —— 所以是「不受这 402/1,165/1,263 影响」,
  //    不是「毫无失真」。别把这句加强了往下抄。
  //  · FCF / 单季 FCF —— 分拆前**不可比**:光 FY2024 就有 11.65 亿分摊走费用,还叠着母公司集中资金管理
  //    (FY2024 全年 OCF −3.09 亿美元)。干净的单季自 2025-06-27 起,第一个干净的 TTM 点是 2026-04-03。
  //
  // 实测 companyfacts:四科目齐、单季跨度 91 天(FY2026 是 53 周财年,Q1 = 98 天,仍在 80~100 的判据内)。
  // 原始单季最早:营收/成本 2023-12-29,ocf/capex 2024-03-29;派生侧 GM/REV TTM 起于 2024-09-27、
  // FCF/CAPEX TTM 起于 2024-12-27、单季 FCF 起于 2024-03-29。**营收与成本对得上公司自己印的
  // `GrossProfit`**(期末 2026-04-03:5,950 − 1,288 = 4,662,分毫不差)—— 这是它的自校验。
  { ticker: 'SNDK', cik: '2023554', side: 'seller', inChain: true, group: 'memory' },
  // 代工层的**对照样本**(inChain 省略 = false,不作判据成员):和 TSM 同层但在衰退期,
  // 它的毛利率修复 = 新产能进场,符号与「稀缺溢价见顶回落」相反 —— 同组是为了**对照着读**,
  // 不是为了横向比高低。见 COMPANY_NOTES.INTC。
  { ticker: 'INTC', cik: '50863', side: 'seller', group: 'foundry' },
  // 博通。算力芯片组的**定制 ASIC 那一半** —— 它给 CSP 做定制加速器 XPU(Google TPU / Meta MTIA)
  // 与 AI 网络(Tomahawk / Jericho),是**大厂绕开 NVDA 的替代路径,不是补充**。
  // 它与 NVDA/AMD 那一半的劈叉 = 大厂议价权变化的直接读数,所以必须同组才比得出来。
  //
  // 实测(2018 起 33 个 TTM 点、零断档):毛利率 2023-10 的 68.9% → 2024-11 的 63.0% → 2026-05 回到 68.3%。
  // 那 6 个百分点的坑是 **VMware 收购的无形资产摊销走 COGS**(GAAP 购置价格分摊),
  // **不是定价权变化**,而且方向和「软件占比高 → 毛利率高」的直觉相反。摊销现已基本走完。
  //
  // 另外两格没有信息量:
  //  · capex TTM 仅约 8.6 亿美元(对 328 亿 FCF)—— 它是 **fabless**,这一格读不出任何供给侧信息,
  //    别和 TSM / MU / SKHY 的扩产并排看。
  //  · FCF 巨大且不进买方合计(seller),只反映它自身现金生成。
  // 读它的毛利率时要知道 2024 那个坑的成因(见上),别当成定价权变化。
  //
  // ⚠️ 它真正值钱的数是**每季单独披露的「AI 收入」** —— 那在财报新闻稿(8-K)里,
  // **不在 XBRL**,companyfacts 拿不到。要它得另接一条解析路径,另立需求。
  { ticker: 'AVGO', cik: '1730168', side: 'seller', inChain: true, group: 'accelerator' },
  // ARM(UK,FPI —— 20-F 年报 + **带完整 inline XBRL 的 6-K 季报**,所以 companyfacts 里
  // 90/91 天的单季跨度都在;TSM/ASML 的 6-K 是 0 份带标记,完全不同,见 isPeriodicForm)。
  //
  // **毛利率那一格是常数,别读**:IP 授权模式,四年只在 95.8~97.5% 之间动了 1.7 个百分点。
  // 有信息量的是**营收那两格** —— 权利金收入 ≈ 用它 IP 的芯片出货量,TTM 三年翻倍
  // (26.6 亿 → 51.6 亿美元)。这也正是给 sec 源加 rev / revGrowth 的直接动因。
  // capex 从 0.86 亿涨到 5.88 亿(自研 CSS/chiplet),但绝对值太小,不作供给侧读数。
  //
  // 与 AVGO 同属**定制 ASIC + IP 那一半**:CSP 自研芯片基本都从它的指令集与 CSS 起步,
  // 所以它是那条替代路径的底座。读它只看营收两格 —— 毛利率是常数,答不了稀缺溢价那一问。
  { ticker: 'ARM', cik: '1973239', side: 'seller', inChain: true, group: 'accelerator' },
];

/** 已逐家核对过、可入库的标的。核对一家开一家 —— 未核对的进来会污染派生线。 */
export const ACTIVE_TICKERS = [
  // 顺序即 tab 顺序(GROUP_ORDER × 组内保持这里的先后)。按资金流向排:
  // capex 买单 → 算力芯片 → 代工 → 存储 → 设备。
  'MSFT',
  'GOOGL',
  'AMZN',
  'META',
  'ORCL',
  'NVDA',
  'AMD',
  'AVGO',
  'ARM',
  'TSM',
  'INTC',
  'MU',
  'SKHY',
  'SNDK',
  'ASML',
];

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
export const dartCorpCodeOf = (ticker: string): string | undefined =>
  hasSource(ticker, 'dart') ? find(ticker)?.dartCorpCode : undefined;

export const sideOf = (ticker: string): SecSide | undefined => find(ticker)?.side;
export const groupOf = (ticker: string): ChainGroup | undefined => find(ticker)?.group;
/** 某组里当前启用的标的,保持名单原顺序。 */
export const activeByGroup = (group: ChainGroup): string[] => ACTIVE_TICKERS.filter((t) => groupOf(t) === group);
export const currencyOf = (ticker: string): 'USD' | 'TWD' | 'EUR' | 'KRW' => find(ticker)?.currency ?? 'USD';

/** 某个源下、当前启用的标的(job 分派用)。一家可能出现在多个源里。 */
export const activeBySource = (source: ChainSource): string[] => ACTIVE_TICKERS.filter((t) => hasSource(t, source));

/**
 * 原始行落在 `sec_fundamentals` 表里的那些源 —— 派生量(TTM / 毛利率 / FCF)对它们是同一套算法,
 * 所以 writeDerived 的范围是这个并集,不是单个源。少了 sec6k 那家的线永远不出。
 */
export const activeInSecTable = (): string[] =>
  ACTIVE_TICKERS.filter((t) => hasSource(t, 'sec') || hasSource(t, 'sec6k') || hasSource(t, 'dart'));

// ── 对外序列键(路由与面板必须用同一套,故在此定义一次)────────────────────────

/**
 * 每个源产出哪几种格子。**不同源的格子种类不同**,不能共用一张 kind 列表:
 * SEC 给四科目 → 能算毛利率/capex/FCF;TWSE 只给营收 → 只有月营收与同比。
 *
 * fcfq = **单季** FCF(不是 TTM)。判据是「跌破零轴」,而 TTM 要四季累积才跌破 ——
 * 实测 Alphabet 2026Q2 单季 −5.9B(IPO 以来首次为负)时 TTM 还有 +53.3B,按当时的烧钱速度
 * 推算 TTM 要到 2026Q4 才跌破零轴,**晚半年**。所以两个口径都得画。
 */
/** 落在 `sec_fundamentals` 表里的那几个源,格子种类完全一致(见 SOURCE_KINDS)。 */
const SEC_TABLE_KINDS = ['gm', 'capex', 'fcf', 'fcfq', 'rev', 'revGrowth'] as const;

export const SOURCE_KINDS = {
  // rev / revGrowth:**营收那两格**。加它们是因为四科目对某些公司答不了问题 ——
  // ARM 是 IP 授权模式,毛利率结构性恒在 97% 上下(四年只动 1.7 个百分点),那一格是常数不是读数;
  // 而它的 TTM 营收三年翻倍,权利金收入 ≈ 用它 IP 的芯片出货量,才是真信号。
  // 对 NVDA/MU/AVGO 这些也有用:营收同比比毛利率更早反映需求变化。
  // sec / sec6k / dart 的原始行都落进同一张 sec_fundamentals、派生同一套 SEC_* 序列,
  // 所以格子种类必然相同 —— 引用同一个常量而不是抄三份,免得改一处漏两处。
  sec: SEC_TABLE_KINDS,
  sec6k: SEC_TABLE_KINDS,
  dart: SEC_TABLE_KINDS,
  twse: ['revM', 'revYoy'],
} as const satisfies Record<ChainSource, readonly string[]>;

/** 分部科目(带 XBRL 维度、companyfacts 拿不到的那些)。见 SEGMENT_FACTS。 */
export type SegmentConcept = 'cloudRev';

/**
 * 分部科目 → 它撑起哪一格。**只有报了该分部的公司才有这一格**,不能塞进 SEC_TABLE_KINDS ——
 * 那会给其余每一家买方都挂上一格永远「暂不可用」的线。
 *
 * capexCloud = 单季 capex / 单季云收入。买方判据问的是「这一轮建的算力多久能变现」,
 * FCF 只答了「烧了多少」;分母换成**唯一能直接卖算力的那块收入**才答得了另一半。
 *
 * 写成 `Record<SegmentConcept, …>` 而不是手列一个 kind 数组:加第二个分部科目时漏加格子
 * **直接编译报错**。手列的话数据会正常落库、面板上却什么都不出现 —— 静默,正是要防的那类。
 */
const SEGMENT_KIND = { cloudRev: 'capexCloud' } as const satisfies Record<SegmentConcept, string>;

export type SecKind = (typeof SOURCE_KINDS)['sec'][number] | (typeof SEGMENT_KIND)[SegmentConcept];
export type TwseKind = (typeof SOURCE_KINDS)['twse'][number];
export type FundKind = SecKind | TwseKind;

/**
 * 每种格子**画折线还是画柱**。放这里(而不是各自写一张)是因为路由和面板都要用它,
 * 而两处一旦不一致,要么白裁、要么留一条假斜率:
 *  · line — 连续的滚动量(TTM)。折线只连点,断档两端会被连成一条**斜率是编的**直线,
 *           故折线序列必须裁断档(见 analytics 的 trailingContiguous)。
 *  · bar  — 离散的期间量(单季 FCF、月营收)。柱子之间不连,空档就是没有柱子 →
 *           **不裁**。裁了反而会把缺口之前的历史柱全砍掉,白丢数据。
 */
export const KIND_RENDER: Record<FundKind, 'line' | 'bar'> = {
  gm: 'line',
  capex: 'line',
  fcf: 'line',
  // TTM 营收是连续滚动量 → 折线;同比是逐季的离散比率、正负是重点 → 柱(同 revYoy)。
  rev: 'line',
  revGrowth: 'bar',
  fcfq: 'bar',
  // capex/云收入是**连续的比率**、读的就是斜率(图上那条从 1.0 抬到 1.8 的线)→ 折线,
  // 因而必须裁断档(缺一季会把两端连成一条编出来的斜率,而斜率正是这一格的全部信息)。
  capexCloud: 'line',
  revM: 'bar',
  revYoy: 'bar',
};

/** 这条线要不要裁断档。判据只有一个:**它是不是折线**。 */
export const trimsGaps = (kind: FundKind): boolean => KIND_RENDER[kind] === 'line';

/**
 * 这家会有哪几个格子 = 它各个源的格子并集(去重,按 sources 顺序)。
 * 面板与路由都从这里派生,加源/加公司都不用改它们。
 */
/** 分部科目 → 它那一格。面板/守卫都从这里取,**别在别处写死 kind 名** —— 写死的地方
 *  加第二个分部科目时不会编译报错,只会生成两个同 key 的格子,新那格永不出现。 */
export const segmentKindOf = (concept: SegmentConcept): SecKind => SEGMENT_KIND[concept];

/** 这家的**分部格**(可能为空)。守卫要单独对待它们:见 jobs/secFundamentals 的断档告警。 */
export const segmentKindsOf = (ticker: string): SecKind[] =>
  segmentFactsOf(ticker).map((s) => segmentKindOf(s.concept));

export const kindsOf = (ticker: string): readonly FundKind[] => [
  ...new Set([
    ...sourcesOf(ticker).flatMap((s) => SOURCE_KINDS[s] as readonly FundKind[]),
    // 分部格不挂在源上而挂在**这家披露了哪几个分部科目**上:同一个源(sec)下只有 GOOGL 报云收入。
    ...segmentFactsOf(ticker).map((s) => SEGMENT_KIND[s.concept] as FundKind),
  ]),
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
    '组件还改过名(2019 年是 orcl:CloudServicesAndLicenseSupportExpenses)。' +
    '另:库里还留着 2009-02~2011-05 共 8 行旧 cogs(那时 CostOfRevenue 还在报)。' +
    '它们凑不出四季 TTM 窗口、又与今天差十几年,断档裁剪也会把它们挡在可见段外,故这格实际是空的 —— ' +
    '留着是为可审计,不是遗漏。',
};

export const knownGap = (ticker: string, concept: string): string | undefined => KNOWN_GAPS[`${ticker}.${concept}`];

/**
 * 各家用**公司自定义(extension)概念**报的科目。键 `TICKER.concept`,值是实例里的元素全名。
 *
 * 为什么需要这张表:companyfacts **只聚合标准 taxonomy,不收 extension** —— 公司拿自定义概念
 * 报的那几期,在 API 里直接消失,而且**不报错**。实测 NVDA:FY2023 的三份 10-Q 把 capex 标成
 * `nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets`(2022Q1 = 3.61 亿),FY2024 起才换回
 * `us-gaap:PaymentsToAcquireProductiveAssets` —— 于是 companyfacts 里那三期是空的,TTM 凑不满
 * 四季、整段作废,再被断档裁剪砍掉,NVDA 的 capex/FCF 线只剩 11 点(MSFT 有 69)。
 *
 * ⚠️ **只有 jobs/secBackfillInstances 用它**(读原始申报实例回填),日常 job 不碰 ——
 * 每轮为几十份历史申报各拉 1~2MB 实例不划算,而这类缺口是历史事实、补一次就好。
 * 加一档之前先用实例确认元素全名:extension 名字各家各年都不一样,猜不中就是白拉。
 */
export const EXTENSION_TAGS: Record<string, string[]> = {
  'NVDA.capex': ['nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets'],
};

export const extensionTags = (ticker: string, concept: string): string[] =>
  EXTENSION_TAGS[`${ticker}.${concept}`] ?? [];

/**
 * **分部(segment)科目**:哪家报了分部收入,以及它在申报实例里的元素与维度成员。
 *
 * ⚠️ 这一档与 EXTENSION_TAGS 是**两种不同的病**,别混:
 *  · extension 是「公司自定义概念,companyfacts 不聚合」→ 历史事实,补一次就好。
 *  · segment 是「事实带 XBRL 维度,companyfacts **按设计**一律不收」→ 每一期都拿不到,
 *    包括还没发生的那些。实测 GOOGL 的 companyfacts 里 us-gaap 只有合并口径的收入,
 *    `goog` 这个 extension 命名空间整个不存在。
 *
 * 后果:有这张表的公司,日常 job **每份新申报都要多读一次实例**(GOOGL 实测 2.9MB,
 * 一年 4 次),不是只在 companyfacts 落后时才读。历史要靠 jobs/secBackfillInstances 补。
 *
 * 成员名各家自取(Alphabet 是 `goog:GoogleCloudMember`),加一家之前必须先对着实例确认 ——
 * 猜不中不会报错,只会静默少一条线。`members` 是数组正因为**公司会改成员名**:
 * 同一个分部的历任名字全列上,少列一个就是静默丢掉那一段历史。
 */
type SegmentFactDef = {
  element: string;
  /** 维度轴。**必须一起比**:只比成员名的话,同一个成员挂在别的轴上(如按产品线拆的
   *  `srt:ProductOrServiceAxis`)也会被当成分部总数收进来,值不对却不报错。 */
  axis: string;
  /** 该分部的历任维度成员名 —— **公司会改名**,少列一个就是静默丢掉那一段历史。 */
  members: string[];
  /**
   * 这个分部**最早哪一期才有季度数**(期末,含)。缺口判定的下界 —— 没有它,回填工具永不收敛:
   * 公司开始单列这个分部之前的每一期都会被算成缺口,于是每轮都去拉那几十份实例、对这一档
   * 一行贡献都没有、下一轮原样再拉一遍,`stillMissing` 也永远不为零(永久黄灯淹真信号)。
   * 值要**实测**:拉一份那个年份的实例 grep 成员名,别按公司什么时候「开始做云」推。
   */
  from: string;
  label: string;
};

export type SegmentFact = SegmentFactDef & { concept: SegmentConcept };

/**
 * 按 concept 索引(而不是数组)—— **一个分部科目恰好一条配置**,由类型保证。
 * 数组形状允许同 concept 挂多条,而下游是「一个 concept = 一格面板 = 一条序列」:
 * 真挂两条就会生成两个同 key 的 pane、`stillMissing` 重复列同一项,而这些都不报错。
 */
export const SEGMENT_FACTS: Record<string, Partial<Record<SegmentConcept, SegmentFactDef>>> = {
  GOOGL: {
    cloudRev: {
      element: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
      axis: 'us-gaap:StatementBusinessSegmentsAxis',
      // 2022 年改过名:2022Q1 及更早是 `…SegmentMember`,之后是 `…Member`。元素与值的口径没变
      // (2022Q1 两边都是 5.821B),只认新名字会丢掉 2022Q2 之前的全部历史 ——
      // 而那正是这条线最有信息量的一段(比值还在 1.0 附近)。
      members: ['goog:GoogleCloudMember', 'goog:GoogleCloudSegmentMember'],
      // **分部轴上最早的季度就是 2020Q1**,这是量出来的,不是按「什么时候开始做云」推的:
      //  · 2019 年那几份申报的实例里 Cloud 一条都没有 —— Alphabet 是 FY2020 10-K(2021-02 申报)
      //    才把 Cloud 列成独立报告分部的。
      //  · 那份 10-K 确实把 2018/2019 **追溯重列**到了分部轴上,但**只有全年**
      //    (FY2018 5.838B / FY2019 8.918B),没有季度,也没有 9M —— 还原不出 2019 的四个季度。
      //  · 2019 的季度只存在于 2020 年那几份 10-Q 的比较期,而那时 Cloud 挂的是
      //    `srt:ProductOrServiceAxis`(产品线)+ `StatementBusinessSegmentsAxis=goog:GoogleInc.Member`
      //    —— 两个维度、轴也不对(实测 2020Q1 那份:2019Q1 = 1.825B)。取它等于在序列头部混进
      //    另一套分部口径,而且 2019Q4 得拿「分部轴的全年 − 产品线轴的 9M」相减,两条腿不同基础。
      //    已评估并放弃(2026-08),要 4 个点不值这个口径代价。
      from: '2020-03-31',
      label: 'Google Cloud',
    },
  },
};

export const segmentFactsOf = (ticker: string): readonly SegmentFact[] =>
  Object.entries(SEGMENT_FACTS[ticker] ?? {}).map(([concept, def]) => ({
    ...(def as SegmentFactDef),
    concept: concept as SegmentConcept,
  }));

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
 * 「这一格的线被断档裁短了」。**必须让读图的人看见**:裁剪本身是对的(折线只连点,断档两端
 * 会被连成一条斜率是编的直线),但**裁掉这件事一直是静默的** —— 用户只看到一条短一点的线,
 * 分不清是「这家上市晚」还是「中间缺了三个季度、TTM 整段作废」。
 *
 * 实测的量级足以误导:AMZN capex 66 点裁到 33(断在 2017 年那次换 tag,源少一个 H1 检查点)、
 * NVDA 16 裁到 11(FY2023 Q1/Q2 的 capex 在 companyfacts 里压根没有)、买方合计 40 裁到 33。
 *
 * ⚠️ 只在面板上说,**不在 job 里报警**:这些缺口是源侧的(补 tag 链没用,得换源),
 * 报出来就是一盏永远修不掉的常驻黄灯 —— 同 KNOWN_GAPS 与 CAPEX_SCOPE_EXPECTED 的理由。
 */
export type FundTrim = {
  key: string; // fundKey(...)
  dropped: number; // 被裁掉的点数
  gapFrom: string; // 断档前的最后一点(被裁掉的那侧)
  gapTo: string; // 断档后的第一点(可见段起点)
};

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
