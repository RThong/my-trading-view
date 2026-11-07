// 「利率」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';
import { FICC_TRIANGLE } from '../../views/regime/descSnippets';

// 通胀发布日竖线:CPI 黄、PCE 蓝(与 desc 里的说明对应,改色要同步改文案)。
const RELEASE_CPI = '#facc15';
const RELEASE_PCE = '#60a5fa';
const RELEASE_OPACITY = 0.55;

export const RATES_DOCS = {
  // 利率水平 + 利率波动率:MOVE 是债市波动率,与利率同宗(和股市 VIX 相关性一般),故与 10Y 收益率配对。
  ratesVol: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'dgs10',
            scale: 'right',
            color: '#22d3ee',
            title: '10Y 国债收益率',
            percentile: {}, // 方向不单一,不设风险端,只给 P5/P95 参考
          },
        ],
        desc: [
          '定义:美国 10 年期国债收益率。长端利率锚。',
          '方向不单一(增长 or 通胀 / 供给都能推),故不设风险端,只给 P5/P95 参考。',
          '⭐ 上冲到「估值不可承受」区间(高 CAPE + 杠杆集中时约 5%)= 拥挤主线吸不动资金 → 踩踏。',
          '该阈值绑定当期估值与集中度,环境变了要重估。',
          '',
          FICC_TRIANGLE,
          '⚠️ 波动率比水平更前置 —— 配 MOVE 一起读。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'move',
            scale: 'right',
            color: '#f43f5e',
            title: 'MOVE (债市波动率)',
            percentile: { riskTail: 'low' }, // MOVE 压扁=自满=风险
          },
        ],
        desc: [
          '定义:美银美林美债期权波动率指数。债市版 VIX。',
          '低 = 自满(风险端,红),也是集中度行情敢 all-in 的前提;',
          '抬升 = 贴现率重定价 → 曲线剧动 → 杀成长股。',
          '⭐ 它不是与 VIX 平级的指标,是**上游** —— 债券层先动,再传到权益层与外汇层。',
          '',
          '⚠️ 与 VIX 相关性一般,VIX 平静不能代替看它(「股市静、债市先动」是常见领先形态)。',
        ].join('\n'),
      },
    ],
  },
  // 加息定价走势:SOFR OIS 反推的「到 N 为止累计计入几次」逐日历史 + 核心 CPI / PCE 发布日竖线。
  // 快照(远期曲线 vs 点阵图)在「利率 → 加息定价」那个 tab。
  policyRepricing: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'oisHikes12m',
            scale: 'right',
            color: '#f43f5e',
            title: '12 个月内计入(次)',
            render: { kind: 'line', baseline: 0 },
          },
          { id: 'l2', series: 'oisHikes3m', scale: 'right', color: '#fde047', title: '3 个月内(次)' },
          { id: 'l3', series: 'oisHikes6m', scale: 'right', color: '#fb923c', title: '6 个月内(次)' },
          { id: 'l4', series: 'oisHikes2y', scale: 'right', color: '#a78bfa', title: '2 年内(次)' },
          {
            id: 'l5',
            series: 'coreCpiRelease',
            scale: 'right',
            color: RELEASE_CPI,
            title: '核心 CPI 发布日',
            render: { kind: 'events', opacity: RELEASE_OPACITY },
          },
          {
            id: 'l6',
            series: 'corePceRelease',
            scale: 'right',
            color: RELEASE_PCE,
            title: '核心 PCE 发布日',
            render: { kind: 'events', opacity: RELEASE_OPACITY },
          },
        ],
        desc: [
          '定义:SOFR OIS(Eris)反推的分段远期 − 当日 SOFR 定盘值(FRED),÷ 25bp。「12 个月内」= 9M–12M 那段远期相对今天高几次。',
          '正 = 计入加息,负 = 计入降息。逐日用当天整条曲线重算。',
          '',
          '⭐ 竖线 = 例行发布日:**黄 = 核心 CPI,蓝 = 核心 PCE**(ALFRED 首发日,季调修订那类不算)。',
          '线在竖线当天跳 = 这次重定价大概率是数据推的;没竖线的跳变去查别的(FOMC、就业、讲话)。',
          '',
          '⚠️ **近似值,精度约几 bp**:OIS 节点间隔约 3 个月,相邻两次 FOMC 被抹平,不拆单次会议(单会议概率看 CME FedWatch)。',
          '⚠️ 1Y 以上是按年付息 bootstrap 的,「2 年内」那条比短端几条更糙。历史从 2020-10 起(Eris SOFR 曲线起点)。',
        ].join('\n'),
      },
    ],
  },
  // 长端分解:名义 = 预期腿 + 期限溢价,通胀那一块则由 5y5y 远期锚住。与「实际走势」两格配套读。
  // ⚠️ 这个维度里各格口径不同级 —— t5yifr 是从市场价格减出来的,tp10Kw / expShort10Kw / r* 是模型输出。
  // 故只给前者套分位徽标 / 背景带,模型量一律不套分位:它们不是可交易价差,不该和判据线长一样。
  // (0 基线只给会穿零的 tp10Kw;expShort10Kw / r* 不穿零,补基线只会把纵轴压扁。)
  ratesDecomp: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 't5yifr',
            scale: 'right',
            color: '#38bdf8',
            title: '5y5y 通胀远期 (T5YIFR)',
            percentile: { riskTail: 'high' }, // 高 = 长期通胀锚在上移 = 风险
          },
        ],
        desc: [
          '定义:5 年后起算、往后 5 年的通胀补偿(圣路易斯联储官方口径,日频 %)。',
          '剥掉了近 5 年的当期通胀噪声,只看**第 6-10 年**的定价 —— 比 10Y BEI 更贴「长期通胀锚」。',
          '⭐ 央行真正在意的是这条:近端 BEI 随油价跳无所谓,这条脱锚才是信誉出问题。',
          '',
          '⚠️ 仍是通胀**补偿**不是纯预期 —— 含通胀风险溢价与 TIPS 流动性溢价,和 BEI 同一类偏差。',
          '⚠️ 与 10Y BEI 分歧时以这条为准判长期,以 BEI 判当期。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'tp10Kw',
            scale: 'right',
            color: '#a78bfa',
            title: '10Y 期限溢价 · Kim-Wright 模型估计',
            render: { kind: 'line', baseline: 0 }, // 可转负,且**刻意不套分位** —— 见上方口径注释
          },
          // ACM(纽约联储,月频)叠同格当独立对照。**两条之间的间距才是这格的产品** ——
          // 分成两格就读不出带宽了。ACM 月频走阶梯:一月一个点,中间画斜坡是伪造信息。
          {
            id: 'l3',
            series: 'tp10Acm',
            scale: 'right',
            color: '#f472b6',
            title: '对照:ACM 模型估计(纽约联储,月频)',
            render: { kind: 'line', step: true },
          },
        ],
        desc: [
          '定义:10 年期零息债的期限溢价 —— **两套模型并排**,不是一个数。',
          '  · 主线(日频)= Kim-Wright (2005) 三因子无套利模型,美联储理事会',
          '  · 对照线(月频阶梯)= Adrian-Crump-Moench (ACM),纽约联储',
          '= 长端名义 − 未来 10 年预期短端路径均值。正值 = 持有久期被额外索取补偿。',
          '⭐ 长端上行时的关键分岔:溢价在涨 = 久期风险 / 财政供给重估;溢价不动 = 只是政策路径被重定价。',
          '',
          '⭐ **怎么读两条线:间距 = 置信度,不是误差。** 两条贴在一起 = 这个水平可信;',
          '张开 = 长端里有多少是溢价这件事,模型之间都没共识,此时别拿任一条去下结论。',
          '实测 440 个月重叠:两者平均差 **57 bp**、中位 47、P90 124、最大 222 —— 张开是常态不是异常。',
          '',
          '⚠️ **这是模型估计值,不是价差。** 减号右边那个「预期短端路径均值」没有对应的可交易证券 ——',
          'BEI 出错错的是解释(数字本身是对的),期限溢价出错错的是**数字本身**:预期路径模型错多少它就吸收多少。',
          '故此格不套分位徽标 / 背景带,别把它当判据线读。',
          '⚠️ 两条频率不同级:KW 日频、ACM 月频(当月最后一个交易日)。**带宽只在 ACM 有点的那天是真的**,',
          '其余日子那条是上个月的值横着走。别把阶梯线的平台段当成「ACM 今天就这么认为」。',
          "⚠️ 别拿理事会的 DKW(D'Amico-Kim-Wei)当第三条对照:它与 KW 平均只差 8.5 bp ——",
          '同一个 Don Kim,同族精化不是独立模型,加进来会让带宽看起来收窄而其实没有。',
          '⚠️ 只发布到 10Y。30Y 段没有公开模型序列,那一段只能靠「实际走势」那格的 TIPS 实际收益率来拆',
          '(名义 = 实际 + BEI,看实际那一半怎么动)。',
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        // 两条线并排,**刻意不相减**(理由见 desc 的四层近似)。L 那条走阶梯:它的分辨率由季频的
        // r* 那一半决定,一眼看得出「下面这条一个季度才动一次」—— 相减成单序列会把这个信息抹平。
        // 也刻意不套分位:这格读的是「谁在上面」,给其中一条套背景带会把视觉重心压回单条线。
        layers: [
          { id: 'l4', series: 'expShort10Kw', scale: 'right', color: '#fbbf24', title: 'A:10Y 预期短端均值(KW,日频)' },
          {
            id: 'l5',
            series: 'lProxyHlwT5yifr',
            scale: 'right',
            color: '#34d399',
            title: 'L 代理:HLW r* + 5y5y(季频)',
            render: { kind: 'line', step: true },
          },
        ],
        desc: [
          '定义:分解式 `长端 = 预期短端路径均值 + 期限溢价` 里的**预期腿(A)**,并排叠上长期中枢的粗代理(L)。',
          '  · A(日频)= Kim-Wright 拟合的 10Y 零息收益率 − 同模型的 10Y 期限溢价(两条 FRED 序列现减)',
          '    = 「市场认为未来十年联邦基金利率平均落在哪」',
          '  · L(季频阶梯)= 名义长期中枢的**粗代理** = HLW r* + 5y5y 通胀远期',
          '',
          '⭐ A 自身的读法:长端上行时,涨的是这条 = 政策路径被重定价;涨的是期限溢价 = 久期风险重估。',
          '',
          '⭐ 两条线一起看时,**唯一的判据是符号,不是两者之差**:',
          '  · A 在 L 上方 → 30Y−10Y 在水平上**低估**两段期限溢价之差',
          '  · A 在 L 下方 → **高估**',
          '短端离中性哪一边基本决定这个符号 —— 该判断不依赖系数、不依赖口径统一、也不依赖两模型可比。',
          '',
          '⚠️ **为什么这格不给出「偏差项」那个数。** 分解式本身是干净的:令 T₁<T₂、零息口径、',
          '第 T₁ 年后预期路径走平在 L,则 `y_T₂ − y_T₁ = (TP_T₂ − TP_T₁) + ((T₂−T₁)/T₂)·(L − A)`',
          '(T₁=10、T₂=30 时系数 2/3;换期限对要重算)。但用现有输入去算 `L − A`,四层近似串在一起:',
          '  ① L 与 A 出自不同模型家族(HLW 宏观状态空间 vs Kim-Wright 期限结构)——',
          '     差里装着两个模型的分歧,而那个分歧无法与真实的 L − A 分离;',
          '  ② L 要的是第 11–30 年通胀锚,T5YIFR 是第 6–10 年,而第 6–10 年恰好还在 A 的覆盖区间内(共用了一段);',
          '  ③ HLW r* 是**当下**的自然利率(现时状态量),不是「第 10 年以后的预期短端」;',
          '  ④ 口径混用:THREEFY10 是零息,而要对照的 30Y−10Y 来自 par yield。',
          '输出一个两位小数的序列,会把不可识别的量做成看起来可识别的 —— 而且假在图上看不出来。',
          '',
          '⚠️ A 与「期限溢价」那格的**主线(KW)**是同一个模型的一体两面,不是独立佐证:模型把长端',
          '切成两块,预期腿估错多少,KW 溢价就反向吸收多少,两者永远相加等于该模型的拟合收益率。',
          '(那格的**对照线 ACM** 不在此列 —— 它是另一套模型,正是 A 所缺的那个独立佐证。)',
          '',
          '⚠️ 两条线频率不同级,而这一点本身是要看的:季度分辨率的量,解释不了日频利差的**变动**。',
          '要定量得先有一条口径对得上的 L,现有这个代理不够格 —— 它能给符号,给不了量级。',
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        // 季频 → 阶梯线:一年只发 4 次,两次发布之间值就是不变的,平滑折线是在伪造发布间的信息。
        // 同 tp10Kw / expShort10Kw:模型估计值不套分位徽标 / 背景带。
        layers: [
          {
            id: 'l6',
            series: 'rstarHlwCurrent',
            scale: 'right',
            color: '#34d399',
            title: '自然利率 r* · HLW current estimates(季频)',
            render: { kind: 'line', step: true },
          },
          {
            id: 'l7',
            series: 'rstarSepImplied',
            scale: 'right',
            color: '#fbbf24',
            title: '联储口径:SEP 长期利率 − 2%(季频)',
            render: { kind: 'line', step: true },
          },
        ],
        desc: [
          '定义:Holston-Laubach-Williams 估的美国**短期**自然实际利率(纽约联储,季频,一年只发 4 次)。',
          '= 产出处于潜在水平、通胀稳定时对应的实际短端利率。',
          '',
          '叠加线(黄):**联储自己怎么定价 r*** = SEP 点阵图长期利率中位数 − 2%(长期 PCE 目标),',
          '每次 SEP(3/6/9/12 月 FOMC)一个点。读的是它自己怎么变,不是和 HLW 的差。',
          '⚠️ **别拿 HLW 当它的领先指标。** 圣路易斯联储说「SEP r* 滞后地向替代估计靠拢」,',
          '那个替代估计是六个模型的合成,不是 HLW 单独 —— 两者可以一个在 SEP 上方、一个在下方,信号相反。',
          '⚠️ SEP 是**当期信念**,历史点是当时发布的值;HLW 是事后重估的 current estimates,两者前视偏差不对等。',
          '',
          '⭐ 它的用途是**当长期中枢(L)的实际那一半用**:`L = r* + 5y5y 通胀远期`,',
          '拿去与 A 在「A vs L 缺口」那格**并排读符号** —— 不是相减出量级,理由见那格的 ⓘ。',
          '',
          '⚠️ **不要拿 `10Y 实际 − r*` 当实际期限溢价。** 展开是:',
          '   `10Y实际 − r* = (A_real − r*) + 实际期限溢价`',
          '   第一项是政策周期残留 —— 10Y 实际里装的是未来十年实际短端的**平均**,不是中性水平。',
          '   当前短端远在中性之上,这一项显著为正,直接相减会**高估**实际期限溢价。r* 是 L,不是减数。',
          '',
          '⚠️ **历史值经事后重估。** 这是 current estimates:整条历史曲线是**今天用全部数据回头重画的**,',
          '2021 年那个点不是 2021 年的人看得到的值。**不能用它论证「当时市场定价错了」** —— 那是前视偏差。',
          '要做回测须换官方的 real-time estimates 那一套(本面板未接)。',
          '',
          '⚠️ 季频,与同视角的日频线不同级。另外**别把它当期限溢价的对照读** ——',
          'r* 与期限溢价是两个不同的量,不构成互相印证。期限溢价的对照在上面「期限溢价」那格:',
          'Kim-Wright 与纽约联储 ACM 两条并排,间距就是带宽。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
