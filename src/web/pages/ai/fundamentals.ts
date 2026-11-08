// AI 产业链(基本面)各格的构造:按公司名单与数据源现算 ChartDoc 的格子(dim = fundamentals:<公司|buyer>),
// 每格一条线;拼成整份 doc 见 fundDoc。与固定面板同一套渲染(views/chartDoc/DocChart)。
import {
  KIND_RENDER,
  SEC_BUYER_FCF_KEY,
  SEC_BUYER_FCFQ_KEY,
  chainTickers,
  knownGap,
  segmentFactsOf,
  segmentKindOf,
  sourcesOf,
  fundKey,
  sideOf,
  currencyOf,
  hasSource,
  type ChainSource,
  type FundKind,
} from '../../../shared/aiChain';
import type { ChartDoc, Layer, Pane } from '../../views/chartDoc/chartDoc';

// SEC 基本面各格共用:季频数据的读法约束。写在每格开头,防止被当日频指标使。
const SEC_CAVEAT =
  '\n源:SEC XBRL 财报实际值(非预期、非市场定价)。**季频、滞后 4~8 周、会因重述回改** —— ' +
  '用途是证实/证伪叙事,不是择时;不要用它解释当天的价格。';
// 名单会变,所以只写**口径与条件**,不写「当前接了哪几家」——写状态的文案一定会过期。
// 两侧名单现算,别在文案里写死 —— 名单一改文案就过期。只列因果链内的(备查的那几家不是判据成员)。
function tickersOf(side: 'buyer' | 'seller') {
  return chainTickers(side).join('/');
}
const SEC_ROSTER_CAVEAT =
  `AI 链按判据分两侧(见 shared/aiChain 的 side):**买铲子的**(${tickersOf('buyer')} —— 花钱建算力)` +
  `进这条合计线;**卖铲子的**(${tickersOf('seller')} —— 收钱)只看毛利率、**不进**这条线。` +
  '分侧不是分类洁癖:卖方在涨价周期里正 FCF 极大,混进来会把零轴永远垫在下方,判据直接失效。' +
  '线上只汇总「已启用且属买方」的那几家(名单按「逐家核对毛利率后才开」推进),' +
  '故**买方一家都没开时这格是空的** —— 空 = 判据还没有数据,不是「FCF 为零」。';

/** 各家自己的实测事实(不会过期的历史值 / 一次性事项),挂在对应公司的格上。 */
const COMPANY_NOTES: Record<string, string> = {
  META:
    '⚠️ **组内异质点:它不卖云**。同组另外四家(MSFT/GOOGL/AMZN/ORCL)烧的 capex 有云收入对冲,' +
    'META 是**纯自用买家** —— 算力全给自家推荐与生成式产品,没有一分钱云租金回来。\n' +
    '所以它的 FCF 曲线读法不同:同样的 capex 增速,对它是纯支出、对别家是「先投后收」。' +
    '判断「capex 吞掉现金流」时它最先见效,也最能说明这轮扩产有多少是不计回报的军备竞赛。',
  ORCL:
    '⚠️ **组内异质点:举债最凶的样本**。TTM FCF 已经在零轴下方,而扩产靠的是外部融资 ——' +
    '实测 FY2026 已举债 430 亿 + 股权 50 亿、计划再融 400 亿。§6.14 判据里「capex 吞掉现金生成能力 →' +
    '扩张只能靠举债续」这句话,在它身上是**已经发生**的事实,不是预警。\n' +
    '**和 MSFT 并排看最有信息量**:同组、同样在扩产,一个 FCF 仍厚、一个已转负,' +
    '劈叉的大小就是「这轮扩产的资本结构差异」。',
  AVGO:
    '定位:算力芯片组的**定制 ASIC 那一半**。它给 CSP 做定制加速器(Google TPU / Meta MTIA)与' +
    'AI 网络(Tomahawk / Jericho)—— 这是**大厂绕开 NVDA 的替代路径,不是补充**。\n' +
    '**它与 NVDA/AMD 那一半的劈叉,就是大厂议价权变化的直接读数**:定制份额起来 = 通用 GPU 的' +
    '定价权在让渡。所以这两半必须同组对读,单看任何一半都得不出这个结论。\n' +
    '⚠️ **但毛利率这一格不能和 NVDA / AMD 比高低**,而且 2024 那个坑是会计不是生意:毛利率从 2023-10 的 ' +
    '**68.9%** 掉到 2024-11 的 **63.0%**、2026-05 又回到 **68.3%** —— 那 6 个百分点是 **VMware 收购的' +
    '无形资产摊销走 COGS**(GAAP 购置价格分摊),不是定价权变化。摊销现已基本走完。\n' +
    '· **capex 那一格没有信息量**:TTM 仅约 8.6 亿美元(对 328 亿 FCF)—— 博通是 **fabless**,' +
    '别和 TSM / MU / SKHY 的扩产并排看。\n' +
    '· 它在 AI 链上分量很重(定制加速器 XPU:Google TPU / Meta MTIA;AI 网络 Tomahawk / Jericho),' +
    '但**真正值钱的那个数是每季单独披露的「AI 收入」,在财报新闻稿(8-K)里、不在 XBRL** —— ' +
    'companyfacts 拿不到,所以这几格看不见它。故归备查、不作判据成员。',
  NVDA:
    '⚠️ 单季异常先查一次性事项:2025-04-27 那季单季毛利率 60.5% 是 H20 存货减值 45 亿的结果,' +
    '不是定价能力变化 —— TTM 口径会把它摊四个季度,别读成趋势。',
  SNDK:
    '定位:存储组里**唯一的纯 NAND 标的**(MU 是 DRAM+NAND 全谱、SKHY 重心在 DRAM/HBM)。' +
    '三家并排才拆得开两件事:**HBM 拉动**(AI 直接需求)与 **NAND 自身周期**(供需缺口)。' +
    'SNDK 这条线里没有 HBM,所以它动 = NAND 侧真的在动,不是被 HBM 带的。\n' +
    '⚠️ **2025-02-21 从西部数据(WDC)分拆,口径断点在分拆日、不在财年边界** —— 别按财年推:' +
    '分拆日落在 **2024-12-28~2025-03-28 那一季内部**,那一季自己就横跨两种口径。' +
    '该日之前是 carve-out(拟制)报表,之后是独立公司合并报表。\n' +
    '**但断点不是一刀切,得按格分** —— 依据是 FY2025 10-K 自己印的分摊表,它逐行列出母公司分摊落在哪:' +
    'R&D 189 / SG&A 158 / 分拆费用 50 / 离职等 5(FY2025,百万美元;FY2024 合计 1,165、FY2023 合计 1,263)。' +
    '**表里没有 cost of revenue 那一行**,于是:\n' +
    '· **毛利率 / 营收:那张表里没有 COGS 行 → 这两格不受 402 / 1,165 / 1,263 这笔分摊影响,跨断点可读**。' +
    '(只说可核的部分:同一份 10-K 的 MD&A 提到分摊还含「product sourcing / supply chain」这类' +
    '天然属 COGS 的支持成本,但它没落进这张按行拆的表 —— 所以说「不受这笔分摊影响」,不说「毫无失真」。)\n' +
    '· **FCF / 单季 FCF:分拆前不可比** —— 光 FY2024 就有 **11.65 亿美元**分摊走费用,还叠着母公司集中' +
    '资金管理(FY2024 全年 OCF **−3.09 亿美元**)。干净的单季自 2025-06-27 起,第一个干净的 TTM 点是 ' +
    '**2026-04-03**;在那之前**别把 FCF「转正」读成经营改善**,那是换了口径不是变好了。\n' +
    '⚠️ **最近摆得很猛**:TTM 毛利率从 27.9%(2025-10-03)**两个季度**冲到 ' +
    '**56.0%**(2026-04-03);干净单季看得更直白 —— 26.2%(2025-06-27)→ 29.8% → 50.9% → ' +
    '**78.4%**(2026-04-03)。同期**单季**营收同比 **+251%**(期末 2026-04-03 的 5,950 对去年同季 1,695;' +
    '这一格是单季同比,不是 TTM 同比)—— 这是 NAND 价格暴涨,不是份额或产品结构。' +
    '⚠️ 但**摆幅本身别和 MU 比高低**:MU 的 TTM 毛利率在库里 64 个点走过 87 个百分点(−14.5~72.6),' +
    'SNDK 只有 7 个点、区间 28 个百分点 —— 它是**同一个 NAND 周期的第二个读数,不是更极端的那个**。\n' +
    '· **capex 那一格读不出供给侧信息**:TTM 一直趴在 1.78~2.04 亿美元(对 132 亿 TTM 营收)——' +
    '它的产能在与铠侠(Kioxia)的合资厂 Flash Ventures 里走权益法 —— 表上有的是那笔**权益投资**,' +
    '**厂房设备不在**,所以扩产不体现为它自己的 capex。' +
    '别和 MU / TSM 的扩产并排看。同期单季 FCF 从 **+4.38 亿**(2025-10-03)冲到 **+29.93 亿美元**。\n' +
    '· 自校验:营收 − 成本对得上公司自己印的 `GrossProfit`(期末 2026-04-03:5,950 − 1,288 = 4,662,分毫不差);' +
    'TTM 营收在 2025-06-27 那点 = 7,355M,与 10-K 的 FY2025 全年值完全一致。\n' +
    '· ⚠️ **2025-10-03 那根同比柱多一周**:FY2026 是 53 周财年,多出的一周在 Q1(98 天对去年同季 91 天)。' +
    '**按周均线性折算,+22.6% 里约 8.8 个百分点来自多出的那一周**(把本季按 13/14 折成 2,143 再比去年同季 ' +
    '1,883,同比只剩 13.8%)。别当真实增速读。\n' +
    '· 线短是分拆的必然:毛利率/营收 7 点(2024-09-27 起)、FCF 6 点(2024-12-27 起)。',
  MU:
    '⚠️ 波幅远大于算力侧,读「在自身周期的哪个位置」而非跨公司比高低。库里实测历史标尺(2010 起):' +
    '最低 −14.5%(2023-11,亏损年)、上一轮 2018 存储周期峰值 59.6%。' +
    '**MU 毛利率是 DRAM/NAND 价格周期的免费代理** —— 权威现货价(TrendForce)要钱,而存储是纯周期品:' +
    '同样的晶圆,价格涨落几乎全反映在毛利率上,增量收入接近全额毛利。',
  AMD:
    '定位:**加速器侧的第二家,和 NVDA 对读**。同一批客户、同一波需求,毛利率差距就是定价权差距 ' +
    '(实测 2026Q2:AMD 53.8% 对 NVDA 同期 70%+)。**AMD 的毛利率抬升先于 NVDA 回落** = ' +
    '客户开始接受第二供应商,是稀缺溢价松动的早期读数;两家同步走高只是需求还在扩。\n' +
    '⚠️ 是**混合读数**:AMD 还有客户端/服务器 CPU。2026Q2 数据中心占营收约 58%(公布值),' +
    '占比越高这条线越接近纯加速器读数,但永远不是纯的。\n' +
    '⚠️ **FCF 那两格在 FY2025 偏高**(毛利率不受影响):AMD 那年有终止经营(ZT Systems 制造业务出售),' +
    'OCF 取的是总额(含终止经营),而 capex 那条腿的 us-gaap 科目按构造只含持续经营 —— ' +
    '实测 FY2025 全年虚高 1.216B(总额 7.709B vs 持续经营 6.493B),H1 那期虚高 0.549B。' +
    '不改成持续经营口径是因为那档「有终止经营才报」、Q1 就缺,换过去会在同一个差分组里换基础' +
    '(详见 TAG_CHAINS.ocf)。**2026 起已归零**(H1 2026 终止经营 OCF = 0),只影响 FY2025 那几点。',
  TSM:
    '定位:**整条链的物理瓶颈**,也是这套面板里唯一**两个源各管一半**的一家 ——\n' +
    '· 季度四格(毛利率/FCF/单季 FCF/capex)来自它交给 EDGAR 的季度合并财报 6-K,T+45,可回填到 2023Q1。\n' +
    '· 月营收两格来自台湾证交所,**T+10,全链最快** —— 比任何季报早一个月以上,而且是已发生的出货量、' +
    '不是指引。实测 2026-06:NT$442,680M、同比 +67.9%,源附备注「因先進製程產品需求增加所致」。\n' +
    '· 两个源交叉验证过:H1 2025 营收 6-K 报 1,773,045,533 千元,与 TWSE 月营收累计**完全一致**。\n' +
    '· 和 NVDA 对读:NVDA 的营收是 TSM 出货的下游结果,**TSM 月营收转弱会先于 NVDA 季报体现**;' +
    '毛利率则是「代工端议价权」,实测 2025Q2 58.6% → 2026Q1 66.2%,一路抬升。',
  ASML:
    '定位:**上游产能的最上游** —— EUV 光刻机的唯一供应商。它的出货是 TSM/存储厂真正扩产的物理前置。\n' +
    '⚠️ **不要照 NVDA/MU 那套读它的毛利率**:ASML 是垄断,定价权一直在,毛利率长期稳在 50~54%,' +
    '不随周期摆 —— 「见顶回落 = 供给追上需求」那条判据对它基本无效。\n' +
    '真正有信息量的是另外两个:**营收**(已发生的设备出货 = 产能什么时候真的到位)、' +
    '**capex**(它自己扩不扩产 = 对未来需求的下注)。\n' +
    '⚠️ **领先指标已经没了**:ASML **2026 年起停止披露净订单(net bookings)**,最后一次是 2025Q4' +
    '(实测 2026Q1/Q2 的新闻稿全文无 booking 字样,只剩一句「order intake remained extremely strong」)。' +
    '所以这里能看到的全是**已发生**的,看不到未兑现的需求。\n' +
    '⚠️ 单季 FCF 摆动极大(实测 2026Q1 −2,588 → Q2 +1,404 百万欧元),那是**营运资本节奏**' +
    '(为 2027 扩产备料吃现金),不是 §6.14 那种「capex 吃穿现金流」—— 形状像,成因完全不同。\n' +
    '⚠️ 单季 FCF 的**正向尖峰是客户预付款**,不是盈利跳升:实测 2026Q3 OCF 11,797.6 > 当季营收 11,662,' +
    '同期非流动合同负债(Contract liabilities)3,570.3 → 9,300.6,一季多收约 57 亿欧元定金;' +
    '2025Q4 那根(OCF 11,410.3)同理。读法:尖峰 = 客户抢机台的需求信号;定金交货时冲回,' +
    '之后几季 FCF 会被压低。盈利看毛利率那格。',
  INTC:
    '⚠️ **不是判据成员**(名单文案里不列它,合计线也不收它),放这里是当**供给侧的反向读数**。\n' +
    '· 符号和 NVDA/MU 相反:那两家「毛利率见顶回落 = 供给追上需求」;INTC 是' +
    '**毛利率修复 = 新产能/新供应商进场**,同样指向稀缺溢价见顶,但方向朝上。混着读会读反。\n' +
    '· 是**混合读数**,而且混得比 AMD 重:INTC 毛利率同时装着「晶圆厂利用率修复」' +
    '(自身周期,与 AI 无关)和「AI 芯片定价权」两件事,拆不开。实测 TTM 从 29.8%(2025-06-28)' +
    '抬到 38.6%(2026-06-27),同期公布的数据中心与 AI 营收同比 +59% —— 两个成因都在,占比不可分。\n' +
    '· FCF 那两格更要小心:INTC 是**自建晶圆厂**,它的 capex 是制造业产能投入,' +
    '不是 §6.14 那种「买算力」。所以它绝不进买方合计。实测 TTM FCF 刚由负转正' +
    '(2025-06-28 −10.9B → 2026-06-27 +2.8B),读的是「代工投入周期过峰」,不是 AI 判据。',
};

// 买方侧共用:我们的口径是「OCF − 总额现金 capex」,而**每家公司自己公布的 FCF 定义都不一样**,
// 四家买方实测出四种调整、两个方向。别指望能和新闻稿的数字对上。
const SEC_LEASE_CAVEAT =
  '⚠️ **口径:OCF − 总额现金 capex**。取的是「现金买固定资产」那一组科目(见 TAG_CHAINS.capex,' +
  '逐期裁决,同一家不同季度可能命中不同 tag)。**和公司公布的 FCF 对不上是正常的**,而且差的方向' +
  '两边都有 —— 实测:\n' +
  '  · MSFT:公司的「capex」含**融资租赁**(2026Q2 我们 35.8B vs 公布 41B)→ 我们的 FCF **偏高**。\n' +
  '  · META:同理含融资租赁本金(2026Q1 我们 19.00B vs 公布 19.84B)→ 我们偏高。\n' +
  '  · NVDA:它自己的 FCF 还要再减「PP&E/无形资产的本金还款」→ 我们偏高。\n' +
  '  · AMZN:它把**处置与激励回款净掉**了(TTM 差约 40 亿)→ 我们的 FCF 反而**偏低**。\n' +
  '这些调整项多是公司自定义 XBRL(extension),companyfacts 拿不到,所以统一用总额、不做各家特调。\n' +
  '\n' +
  '⚠️ **融资租赁那一条不只是「对不上新闻稿」,它动零轴** —— 已量化,读「离零轴还有多远」时要减掉:\n' +
  '  · 走融资租赁取得的产能**在 `OCF − capex` 里完全不出现**:取得时是非现金(不进 capex)、' +
  '本金还款走**筹资活动**、只有利息进经营。所以同一笔资产改成租的,当年 FCF 就好看一整笔,' +
  '而且**不是延后、是永远不来**。(经营租赁不同:付款全额走经营 → OCF 吃掉 → FCF 迟早反映。)\n' +
  '  · 实测各家最近一个财年的「融资租赁新增 / **同财年**现金 capex」:**MSFT 21.2%**(246 亿 / 1,159 亿,' +
  '财年止 2026-06-30)、ORCL 8.9%(另有经营租赁新增 182 亿 = capex 的 33%)、AMZN 2.3%、GOOGL 1.8%、META 0.9%。' +
  '**MSFT 两个财年前还是 1~2%** —— 这是新出现的,不是一直如此。\n' +
  '  · 合计影响:五家最近一个财年共约 **358 亿**。对当时的买方合计 TTM FCF **+1,259 亿**' +
  '(六个季度从 +2,232 亿掉下来,约 −250 亿/季),相当于**把零轴穿越提前约 1.4 个季度**。\n' +
  '  · **不翻符号,所以没做成第二条线**;而且数据也画不出干净的线(ORCL 一个季度数都没有、' +
  'META 断在 2025-12-31)。跳变靠告警守着(见 FINANCE_LEASE_SHARE_CEILING)。\n' +
  '\n' +
  '⚠️ **还有一层:AMZN 的 capex 口径本身就比另四家宽**,不只是调整项的差别。它命中的是 ' +
  '`PaymentsToAcquireProductiveAssets`(PP&E + 自用软件/网站开发),另四家是纯 PP&E。' +
  '换 tag 时留的唯一重叠期(FY2016)实测 **+15.8%**(6.737B vs 7.804B)。\n' +
  '  · **没有可选项**:AMZN 2017-03-31 之后就不再披露 us-gaap 的纯 PP&E tag,不是我们选错了 tag。\n' +
  '  · 也**无法更新这个百分比**:实例里没有任何自用软件分项(只有两个 extension:' +
  'VideoAndMusicContentCapitalizedCosts / ProceedsFromPropertyPlantAndEquipmentSalesAndIncentives),减不出纯 PP&E。\n' +
  '  · 后果:**合计线读趋势成立,读「离零轴还有多远」时 AMZN 那部分偏保守**(capex 记多了 → FCF 记少了)。\n' +
  '  · 对照:NVDA 2020 也换过同一个 tag,但三个重叠期差额**全为 0** —— 换 tag 不等于换口径,得量。\n' +
  '\n' +
  '**读法:比趋势与相对变化,别拿绝对值去对新闻稿**;要看某一家的公司口径 FCF,去它的财报。';
// 断档裁剪是后端统一做的(trailingContiguous),但**只对折线那几格**生效(见 shared/aiChain 的
// KIND_RENDER)—— 柱状不连、空档一眼可见,裁它只会白丢缺口之前的历史柱。
// 折线各家/各科目的起点因此长短不一,必须在那几格讲清楚,否则「怎么这条线只有几年」无处可查。
// 单季那格共用:为什么要它、以及它的陷阱。
const SEC_QUARTERLY_READ = [
  '**为什么单独画单季**:判据是「跌破零轴」,而 TTM 要四个季度累积才跌破 —— 转折看晚最多一年。',
  '实测:Alphabet 2026Q2 单季 FCF −5.9B(IPO 以来首次为负),而当时 TTM 还有 +53.3B;',
  '按当时的烧钱速度推,TTM 要到 2026Q4 才跌破零轴,**晚半年**(而且那还是假设烧钱不加速)。',
  'TTM 线上看不出这件事 —— 相邻 TTM 相减是「同比同季变化」(中间三项抵消,剩 Q(t)−Q(t−4)),不是当季值。',
  '',
  '⚠️ **只能同比同季比,不能顺序比**。单季受财年季节性影响极大(实测 MSFT 单季 FCF 在 5.9~25.7 之间摆、',
  'AMZN 的 Q4 +14.9 对 Q1 −18.2)—— 顺序看会把季节当成趋势。要判恶化,拿今年 Q1 对去年 Q1。',
  '',
  '分工:TTM 看**水平**(还有多厚)与**斜率**(同比在改善还是恶化);这条看**转折时点**。',
].join('\n');

/** **折线格专用**。柱状格别拼这条 —— 它们不裁,拼上就是一句和行为相反的口径说明。 */
const SEC_TRIM_NOTE =
  '⚠️ 只画**最近一段连续序列**:XBRL 里某些季度的原始行根本不存在(常见于早年,如 NVDA FY2013–FY2021 ' +
  '没有年度 capex 行、Q4 无从还原;毛利率也会因某季缺 revenue/cogs 而断),单季序列就断成孤岛。' +
  '折线只连点,断档两端会被连成一条**斜率是编的**直线,而这组判据全在读斜率,' +
  '故早于断档的孤立段一律裁掉(库里原始行全保留,只在读时裁)。各家各格的起点长短不一就是这个原因。';

/** **柱状格专用**:它们不裁断档,缺季就是少一根柱子。 */
const SEC_BAR_GAP_NOTE =
  '⚠️ 这一格画**柱状不画折线**,所以**不裁断档**:缺哪一季就是少一根柱子,一眼看得见。' +
  '(折线那几格必须裁 —— 折线只连点,断档两端会被连成一条斜率是编的直线。)' +
  '也因此,这条的起点可能比同 tab 的折线格更早。';

const SELLER_GM =
  '判据:卖铲子一侧的**稀缺溢价读数**。见顶回落 = 供给追上需求、议价权开始让渡,' +
  '与买方 FCF 转负是同一转折的两侧(一侧收钱变难,一侧花钱变多)。' +
  '读**相对自身近年中枢的趋势**,不设硬阈值 —— 要的是「连续多期离开中枢往下」这个形状,' +
  '不是某一次跌破某个数。';
const BUYER_GM = '定位:配角。买方的毛利率由本业(云 / 广告 / 软件)主导,不是 AI 判据;放这里只为和自家 capex 对读。';
const SELLER_FCF =
  '定位:**卖方的 FCF 不进买方合计线**(见「买方合计」tab)。卖方在涨价周期里正 FCF 极大,' +
  '混进合计会把零轴永远垫在下方,§6.14 的「跌破零轴」就永远不成立。这条只看这家自身的现金生成。';
const REV_READ = [
  '判据:**需求强度的直接读数**,不经过任何口径转换 —— 它就是已经收到的钱。',
  '  · 卖方(算力芯片 / 上游产能):营收 = 已发生的出货量 × 价格,比毛利率早一步反映需求变化。',
  '  · 买方:营收是本业规模,不是 AI 信号 —— 那一侧看 FCF,这一格只作分母参照。',
  '',
  '⚠️ **对毛利率结构性不动的公司,这是唯一有信息量的那一格**:ARM 是 IP 授权模式,',
  '毛利率四年只在 95.8~97.5% 之间动了 1.7 个百分点(是个常数不是读数),而 TTM 营收三年翻倍。',
].join('\n');

const REV_GROWTH_READ = [
  '定义:**单季**营收同比 = 本季 / 去年同季 − 1,按财季对齐(不按日期减 365 天 —— 13 周周历会漂)。',
  '',
  '为什么用单季而不是 TTM 同比:同比本身已经去掉季节性(比的是同一个财季),而单季比 TTM',
  '**早半年**反映拐点 —— TTM 同比里当季只占四分之一权重,拐点会被前三季稀释。',
  '这也是公司自己 headline 的口径(「营收同比 +22%」讲的都是单季)。',
  '',
  '  · 增速见顶回落 = 需求侧最早的转弱信号,先于毛利率、更先于买方 FCF 转负。',
  '  · 前四个季度不出点(没有可比基期);基期为 0 或负也不出点。',
].join('\n');

const BUYER_FCF_READ = [
  '判据(微观 §6.14):看的不是水平,是**会不会转负** —— 跌破零轴 = capex 吞掉了现金生成能力,',
  '扩张只能靠举债续,资本结构从自我造血转向外部融资。',
  '  · 零轴上方且抬升 = 扩张仍在自我造血,段位偏早。',
  '  · 抬升但斜率转平 = capex 增速追上 OCF 增速,离转折不远。',
  '  · 破零 = ③→④ 的硬信号。届时看举债路径(长期负债)确认。',
].join('\n');

// 每格依赖哪些科目 —— 用来把「已知结构性缺口」写进那一格的说明。
// 一格空着而 desc 不解释,下个月自己会当成 bug 去查(ORCL 的毛利率就是这种)。
// TWSE 那两格是空数组:KNOWN_GAPS 记的是 companyfacts 的科目缺口,与 TWSE 源无关。
const PANE_CONCEPTS: Record<FundKind, string[]> = {
  gm: ['revenue', 'cogs'],
  capex: ['capex'],
  fcf: ['ocf', 'capex'],
  fcfq: ['ocf', 'capex'],
  rev: ['revenue'],
  revGrowth: ['revenue'],
  capexCloud: ['capex', 'cloudRev'],
  revM: [],
  revYoy: [],
};

/**
 * kind → 画法。**柱 / 折线这件事只有一处真相**(shared/aiChain 的 KIND_RENDER),路由据它决定
 * 裁不裁断档、这里据它决定画法 —— 两处分别写一张表就会 desync,要么白裁要么留一条假斜率。
 * 这里只补 KIND_RENDER 表达不了的那点视觉细节:哪条折线要零基线。
 */
const BASELINE: Partial<Record<FundKind, Layer['render']>> = {
  fcf: { kind: 'line', baseline: 0 }, // TTM 滚动量 → 折线,但零轴是判据 → 加零基线
  // 比率的判据线是 1.0(当季 capex 恰好等于当季云收入),不是 0 —— 零轴对它没有含义。
  capexCloud: { kind: 'line', baseline: 1 },
};

/** 柱 ⇒ 符号柱(正绿负红、零基线);折线 ⇒ 默认折线,除非上表指定了基线。 */
function renderOf(kind: FundKind): Layer['render'] {
  return BASELINE[kind] ?? (KIND_RENDER[kind] === 'bar' ? { kind: 'signed' } : undefined);
}

/** 一格一条线。格子与图层的 id 先留空,拼成整份 doc 时按顺序编号(见 numbered) */
function paneOf(
  ticker: string,
  kind: FundKind,
  title: string,
  // signed(符号柱)不需要 color —— 正绿负红由画法决定,颜色不起作用
  color: string | undefined,
  lines: Array<string | undefined>,
): Pane {
  const gaps = PANE_CONCEPTS[kind].flatMap((c) => {
    const why = knownGap(ticker, c);
    return why ? [`⚠️ **这格是空的,而且不是 bug**:${ticker} 的 ${c} 拿不到 —— ${why}`] : [];
  });
  const render = renderOf(kind);

  return {
    id: '',
    stretch: 1,
    scales: [{ id: 'right', side: 'right' }],
    layers: [
      {
        id: '',
        series: fundKey(ticker, kind),
        scale: 'right',
        color: color ?? NEUTRAL,
        title,
        ...(render && { render }),
        // 不配 percentile:样本仅十余期,分位是噪声。
      },
    ],
    // 只丢 undefined —— '' 是段落分隔符,InfoTip 用 whitespace-pre-wrap 渲染,filter(Boolean) 会把它一起吃掉。
    desc: [...(gaps.length ? [...gaps, ''] : []), ...lines].filter((l) => l !== undefined).join('\n'),
  };
}

// 符号柱的图层颜色(画法正绿负红,不起作用)
const NEUTRAL = '#a3a3a3';

/** TWSE 三格共用:源的性质与币种。各格自己的端点与频率写在各自定义那一行。 */
const TWSE_CAVEAT =
  '\n源:台湾证交所(TWSE)OpenAPI 公开端点,**官方、免 key**,IFRS 口径。' +
  '金额单位是**百万新台币**(源给千元,已除 1000),不是美元 —— 别和其他 tab 的美元数直接比大小。';

/** 月营收那两格额外的时效说明(季度那格不适用:它慢得多)。 */
const TWSE_MONTHLY_SPEED =
  '端点是「营业收入汇总表」,每月 10 日左右出上月数(**T+10**)—— 这是整条 AI 链里最快的读数,' +
  '比任何季报早一个月以上,而且是已发生的出货量、不是指引。\n' +
  '⚠️ **但要攒够点才读得了**:快照源不可回填(见下),接入首日只有三个点、同比只有一个。' +
  '在攒满之前这一格是「有数但读不出趋势」,别拿单点当信号。';

const TWSE_SNAPSHOT_NOTE =
  '⚠️ **只能往前攒,补不了历史**。端点只返回最新一个月;台交所的历史月报页有反爬' +
  '(实测返回「FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED」)。' +
  '好在一次调用能拿到**三个点**(当月 / 上月 / 去年当月),所以接入当天就有同比可读,' +
  '但**中间会有约 11 个月的空档**,要等按月攒满。\n' +
  '所以这几格画**柱状不画折线**:折线只连点,断档两端会被连成一条斜率是编的直线' +
  '(实测:接入首日 2025-06 到 2026-05 之间空 11 个月,折线画出一条不存在的匀速上升)。' +
  '柱子之间不连,空档就是没有柱子 —— 缺哪个月一眼看得见,而不是被抹成趋势。';

const TWSE_REV_READ = [
  '判据:卖铲子一侧的**需求强度即时读数**。代工厂的月营收 = 上游产能的实际出货,',
  '比任何人的指引都硬 —— 它已经发生了,不是预期。',
  '  · 同比持续 +40% 以上 = 需求还在扩张,链条上游没松。',
  '  · 同比逐月走平/回落 = 拐点的**最早**信号(比季报早一个月,比 FCF 转负早几个季度)。',
  '实测 2026-06:同比 +67.9%,源附的备注写「因先進製程產品需求增加所致」。',
  '',
  '⚠️ **只能同比同月比,不能顺序比**:代工厂月营收有强季节性(消费电子拉货节奏),',
  '顺序看会把季节当趋势。也别拿单月绝对值当趋势 —— 一个月里的工作日天数、汇率都会晃。',
].join('\n');

/**
 * 走 TWSE 源的公司(目前只有 TSM):**只有月营收那两格**。
 *
 * 这里的格子种类必须与 shared/aiChain 的 `SOURCE_KINDS.twse` 一一对上 —— 路由按 `kindsOf`
 * 决定发哪些序列、也按它决定哪些进 `unavailable`。多造一格的后果是**哑空格**:
 * 路由既不发数据、也不报「暂不可用」,面板上就是一块什么都不说的空白。
 * (曾经这里还有一格 TWSE 季度毛利率,随「退掉 TWSE 季度综合损益表」一起去掉了 ——
 *  那是 6-K 的子集、无现金流、历史只能靠攒;TSM 的毛利率现在走 sec6k。)
 */
function twseCompanyPanes(ticker: string): Pane[] {
  return [
    // 两格都用符号柱:离散期间量,柱子不连、空档一眼可见(见 TWSE_SNAPSHOT_NOTE)。
    // 同比那格正绿负红本身就是判据方向;月营收恒正,柱色统一绿。
    paneOf(ticker, 'revYoy', `${ticker} 月营收同比(%)`, undefined, [
      `定义:${ticker} 当月营收对去年同月的增减(%)。**取源自己算的值**,不是我们除出来的 ——` +
        '源在同一条记录里给了这个字段,而我们攒的历史可能还缺去年那个月。' +
        TWSE_CAVEAT,
      '',
      TWSE_MONTHLY_SPEED,
      '',
      TWSE_REV_READ,
      '',
      TWSE_SNAPSHOT_NOTE,
    ]),
    paneOf(ticker, 'revM', `${ticker} 月营收(百万新台币)`, '#eab308', [
      `定义:${ticker} 单月合并营收。` + TWSE_CAVEAT,
      '',
      TWSE_MONTHLY_SPEED,
      '',
      '定位:同比那格的原始量。看绝对水平与「有没有再创新高」;判断方向请看同比那格。',
      '',
      TWSE_SNAPSHOT_NOTE,
    ]),
  ];
}

/** 金额格的单位标签。TSM 报表是新台币,和别家的美元数**不能比大小**。 */
const MONEY_UNIT: Record<'USD' | 'TWD' | 'EUR' | 'KRW', string> = {
  USD: '百万美元',
  TWD: '百万新台币',
  EUR: '百万欧元',
  KRW: '百万韩元',
};

/**
 * 走 sec6k 源(季度合并财报 6-K)的额外口径说明 —— 数据不是 companyfacts 的 XBRL,
 * 是解析 HTML 报表来的,而且是 IFRS 而非 US GAAP。这两点都影响可比性。
 */
const SEC6K_CAVEAT =
  '\n⚠️ **这家的四个科目来自另一条源**:它是**外国私人发行人(FPI)**,豁免 10-Q,季报以 6-K 提交' +
  '且**不强制 XBRL 标记** —— companyfacts 因此只有年频。所以走它交给 EDGAR 的季报 6-K,' +
  '解析 HTML 报表得到:官方原文、可回填,但**不是 XBRL**,没有 tag 级溯源' +
  '(库里 tag_used 是为复用下游算法借的 us-gaap 名字,真溯源看同行的 accn)。\n' +
  '· 跨公司比绝对值前先看单位 —— 币种见本格标题。';

/**
 * 走 dart 源(韩国金融监督院公示)的口径说明。它和 6-K 那条不是一回事:数据是**结构化的**
 * (按 IFRS 标准 account_id 取,不解析 HTML),但**完全不在 SEC 体系内**。
 */
const DART_CAVEAT =
  '\n⚠️ **这家的四个科目来自韩国 DART**(금융감독원 전자공시),不是 SEC。它 2026-07 才在美上市,' +
  'SEC 侧**零财务 XBRL** —— companyfacts 只有 5 个非财务 tag,6-K 与英文财报稿都只给' +
  '营收 / 营业利润 / 净利,**没有营业成本、没有现金流**,所以毛利率和 FCF 在 SEC 那边根本算不出来。\n' +
  '· 口径 **K-IFRS 合并**(fs_div=CFS),币种**韩元** —— 别和别家的美元数直接比大小。\n' +
  '· 取数按 **IFRS 标准 account_id**,不按科目中文名:实测「기타영업외수익」会被误当营收、' +
  '「유형자산의 처분」(处分)会被误当 capex 且符号相反。\n' +
  '· **时效 T+45**(韩国分기보고서法定期限),比 6-K 的 T+25 慢 —— 但 6-K 那条给不出这两格要的科目。\n' +
  '· 报表给年初至今累计,单季由相邻两期相减还原;可回填到 **2016 年**。';

/** 走 6-K 那条的各家,各自的口径与时效差异。 */
const SEC6K_NOTES: Record<string, string> = {
  TSM:
    '· 口径是 **IFRS** 而非 US GAAP。报表只给年初至今累计,单季由相邻两期相减还原。\n' +
    '· 时效:**毛利率约 T+16,FCF/capex 约 T+45**,两格会差一个季度 —— 不是 bug。' +
    '财报稿(T+16)只给营收与毛利,现金流一定要等合并报表(T+45,台湾证交法 45 日的法定期限)。' +
    '毛利率走「财报稿先补、报表到了按 filed 更大覆盖」;财报稿是**未经会计师核阅**的管理层数,' +
    'job 每轮拿它和最近一个已核阅季度对一次,差超 0.5% 就报警(实测只差舍入)。',
  ASML:
    '· 口径**真的是 US GAAP**(ASML 是少见的用美国准则报的外国发行人),币种欧元。\n' +
    '· 报表**单季直给**,不用差分;**T+16~17** 就出(实测 2026-06-28 那期 07-15 交),' +
    '四个科目同时到位 —— 没有 TSM 那种「毛利率先到、FCF 后到」的错位。\n' +
    '· 解析有自校验:报表自己印了本期毛利率,算出来的对不上就抛(它的本期在**第 2 列**,' +
    '与 TSM 相反,取错列不会报错只会静默拿到去年的数)。',
};

function companyPanes(ticker: string): Pane[] {
  const seller = sideOf(ticker) === 'seller';
  const note = COMPANY_NOTES[ticker];
  const unit = MONEY_UNIT[currencyOf(ticker)];
  // 非 companyfacts 的源要多一段口径说明:数据不是 SEC 的 XBRL,可审计程度与会计准则都不同。
  const srcNote = hasSource(ticker, 'sec6k')
    ? SEC6K_CAVEAT + (SEC6K_NOTES[ticker] ? `\n${SEC6K_NOTES[ticker]}` : '')
    : hasSource(ticker, 'dart')
      ? DART_CAVEAT
      : '';

  return [
    paneOf(ticker, 'gm', `${ticker} TTM 毛利率(%)`, '#eab308', [
      `定义:${ticker} TTM 毛利率 =(营收 − 营业成本)/ 营收。` + SEC_CAVEAT + srcNote,
      '',
      seller ? SELLER_GM : BUYER_GM,
      '',
      SEC_TRIM_NOTE,
      ...(note ? ['', note] : []),
    ]),
    paneOf(ticker, 'fcf', `${ticker} TTM 自由现金流(${unit})`, '#22c55e', [
      `定义:${ticker} TTM 自由现金流 = 经营现金流 − 资本开支。` + SEC_CAVEAT + srcNote,
      '',
      seller ? SELLER_FCF : BUYER_FCF_READ,
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_TRIM_NOTE,
    ]),
    paneOf(ticker, 'fcfq', `${ticker} 单季自由现金流(${unit})`, undefined, [
      `定义:${ticker} **单季**自由现金流 = 该季经营现金流 − 该季资本开支(不是 TTM)。` + SEC_CAVEAT + srcNote,
      '',
      SEC_QUARTERLY_READ,
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_BAR_GAP_NOTE, // 这格是柱状 → 不裁,别拼 SEC_TRIM_NOTE
    ]),
    paneOf(ticker, 'rev', `${ticker} TTM 营收(${unit})`, '#a78bfa', [
      `定义:${ticker} TTM 营收(最近四个季度之和)。` + SEC_CAVEAT + srcNote,
      '',
      REV_READ,
      '',
      SEC_TRIM_NOTE,
    ]),
    paneOf(ticker, 'revGrowth', `${ticker} 单季营收同比(%)`, undefined, [
      `定义:${ticker} ` + REV_GROWTH_READ + SEC_CAVEAT + srcNote,
      '',
      SEC_BAR_GAP_NOTE, // 柱状 → 不裁
    ]),
    paneOf(ticker, 'capex', `${ticker} TTM 资本开支(${unit})`, '#60a5fa', [
      `定义:${ticker} TTM 资本开支(购置固定资产付现)。` + SEC_CAVEAT + srcNote,
      '',
      seller
        ? '定位:配角,和上面两条对读 —— 卖铲子的自身 capex 相对其 OCF 微不足道,这正是「卖铲子 vs 买铲子」现金流结构差异的直观佐证。真正吃 FCF 的是买方。'
        : '判据:capex 的斜率就是 §6.14 的分子。它加速而 OCF 不跟上 = FCF 见顶的直接成因;要和同 tab 的 FCF 格对读,单看 capex 抬升不构成信号(收入同步扩张时是健康扩产)。',
      '',
      ...(seller ? [] : [SEC_LEASE_CAVEAT, '']),
      SEC_TRIM_NOTE,
    ]),
    // 分部格只给真披露了分部收入的那家(见 shared/aiChain 的 SEGMENT_FACTS)。
    // 不用 sideOf/hasSource 判:披露不披露是**这一家的事**,与它属于哪一侧、走哪个源无关。
    ...segmentFactsOf(ticker).map((seg) =>
      paneOf(ticker, segmentKindOf(seg.concept), `${ticker} 单季 capex / ${seg.label} 收入(倍)`, '#2dd4bf', [
        `定义:该季资本开支 ÷ 该季 ${seg.label} 分部收入。两条腿**都是单季**,不是 TTM;无量纲。` + SEC_CAVEAT + srcNote,
        '',
        '读法:1.0 是参考线(当季 capex 恰好等于当季云收入)。这一格问的不是「赚不赚钱」,' +
          '而是**建设强度相对唯一能直接卖算力的那块收入有多大**。看斜率不看单点:' +
          '一路抬升 = capex 的增速持续跑赢云收入的增速,即产能在赌未来的需求而不是在跟当期的需求。',
        '',
        `⚠️ 分子分母**不同口径,不是一门生意的投入产出比**:分子是${ticker} 全公司 capex(还建了搜索/` +
          'YouTube/自研模型训练的算力),分母只有云这一个分部。所以它天然偏高,绝对值不能与别家的' +
          '「capex/云收入」横比,只能自己和自己比时间序列。',
        '',
        '⚠️ 分部口径由公司自己划,重划过就不可比(Alphabet 历史上调整过分部构成)。' +
          '线上出现无法用业务解释的台阶时,先去核那一期的分部附注,别当成信号读。',
        '',
        SEC_TRIM_NOTE,
      ]),
    ),
  ];
}

const buyerQuarterlyPane: Pane = {
  id: '',
  stretch: 1,
  scales: [{ id: 'right', side: 'right' }],
  layers: [
    {
      id: '',
      series: SEC_BUYER_FCFQ_KEY,
      scale: 'right',
      color: NEUTRAL,
      title: 'AI 链买方合计 单季自由现金流(百万美元)',
      render: { kind: 'signed' }, // 符号柱:正绿负红、零基线
    },
  ],
  desc: [
    '定义:买方各家**单季** FCF 之和(不是 TTM),按日历季度对齐。' + SEC_CAVEAT,
    '',
    '⚠️ 口径先读这条:' + SEC_ROSTER_CAVEAT,
    '',
    SEC_QUARTERLY_READ,
    '',
    SEC_LEASE_CAVEAT,
    '',
    SEC_BAR_GAP_NOTE, // 这格是柱状 → 不裁,别拼 SEC_TRIM_NOTE
  ].join('\n'),
};

const buyerAggregatePane: Pane = {
  id: '',
  stretch: 1,
  scales: [{ id: 'right', side: 'right' }],
  layers: [
    {
      id: '',
      series: SEC_BUYER_FCF_KEY,
      scale: 'right',
      color: '#22c55e',
      title: 'AI 链买方合计 TTM 自由现金流(百万美元)',
      render: { kind: 'line', baseline: 0 },
    },
  ],
  desc: [
    '定义:**买方**(花钱建算力那一侧)已启用各家 TTM 自由现金流之和。' + SEC_CAVEAT,
    '',
    '⚠️ 口径先读这条:' + SEC_ROSTER_CAVEAT,
    '',
    BUYER_FCF_READ,
    '  · 覆盖不全时读趋势不读绝对值:少一家买方,零轴的位置就没有可比性。',
    '',
    SEC_LEASE_CAVEAT,
    '',
    SEC_TRIM_NOTE,
  ].join('\n'),
};

/**
 * source → 那家有哪几格。查表而非分支:加源时漏加一档是编译错误(Record 要求键齐),
 * 不是静默给它套上 SEC 那四格(那会画出四条永远空的线)。与 shared/aiChain 的 SOURCE_KINDS 配对。
 */
const SOURCE_PANES: Record<ChainSource, (ticker: string) => Pane[]> = {
  sec: companyPanes,
  // dart 的原始行落进同一张表、派生同一套 SEC_* 序列 → 格子构造也是同一个,只在说明里多一段口径差异。
  dart: companyPanes,
  // sec6k 的原始行落进同一张表、派生同一套 SEC_* 序列 → 格子构造也是同一个
  // (只在说明里多一段口径差异,见 SEC6K_CAVEAT)。
  sec6k: companyPanes,
  twse: twseCompanyPanes,
};

/** 格子按顺序编号成整份 doc(p1 / l1 起,一格一层) */
function numbered(panes: Pane[]): ChartDoc {
  return {
    v: 1,
    panes: panes.map((p, i) => ({
      ...p,
      id: `p${i + 1}`,
      layers: p.layers.map((l) => ({ ...l, id: `l${i + 1}` })),
    })),
  };
}

/**
 * 基本面 dim 的 ChartDoc:who = 公司代码,或 'buyer'(买方合计两格)。
 * 一家可能走多个源(TSM:季度四格来自 sec6k、月营收两格来自 twse)—— 各源的格子按 sources
 * 顺序拼起来。同一条序列只留一次:sec 与 sec6k 共用 companyPanes,同时声明两者时会重。
 */
export function fundDoc(who: string): ChartDoc {
  if (who === 'buyer') return numbered([buyerAggregatePane, buyerQuarterlyPane]);

  const seen = new Set<string>();
  return numbered(
    sourcesOf(who)
      .flatMap((src) => SOURCE_PANES[src](who))
      .filter((p) => !seen.has(p.layers[0].series) && seen.add(p.layers[0].series)),
  );
}
