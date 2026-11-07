// 「情绪」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { Pane } from '../../views/chartDoc/chartDoc';
import { BREADTH_CHECK, SIGMA_ID, RESONANCE } from '../../views/regime/descSnippets';
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';

/**
 * QQQ 现货,**波动率与情绪两个视角共用同一份**(不抄两遍 —— 抄了就会改一处漏一处)。
 * 放在两个视角的第一格(故 id 固定 p1 / l1,两个 tab 的其余格从 p2 / l2 起编),
 * 补的是各格自身读法之外的**第三层信息:背离**。
 * 各格原有的读法照旧(见各自 desc),这一格不取代它们 ——
 * 它只回答「同一时点价格在干什么」,那是单看任何一条恐慌线都答不了的。
 * ⚠️ 蜡烛格不套分位/背景带:它是参照物,不是判据。
 */
const QQQ_SPOT_PANE: Pane = {
  id: 'p1',
  stretch: 1,
  scales: [{ id: 'right', side: 'right' }],
  layers: [
    {
      id: 'l1',
      series: 'qqq',
      scale: 'right',
      color: '#38bdf8',
      title: 'QQQ (纳指 100 现货)',
      render: { kind: 'candle' }, // ETF 现货 K 线(/api/price/QQQ,上市日起)
    },
  ],
  desc: [
    '定义:QQQ(纳指 100 ETF)日线蜡烛。**不是判据,是参照物** —— 用来看恐慌线与价格背离。',
    '  · 价格新高 + 波动率不再下压 = 涨势在买保护,心虚。',
    '  · 恐慌冲高 + 价格没破位 = 常是过度反应。',
    '  · 价格跌 + 恐慌涨 = 互相印证,去杠杆真在发生。',
    '',
    '⚠️ 口径不配对:同 tab 多数指标(VIX / VIXEQ / COR1M / RXM)以标普为基,只有 VXN 是纳指。',
    '严格配对该看 SPY;放 QQQ 是因为这轮方向由科技权重主导。',
  ].join('\n'),
};

export const SENTIMENT_DOCS = {
  vol: {
    v: 1,
    panes: [
      QQQ_SPOT_PANE,
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'vix',
            scale: 'right',
            color: '#eab308',
            title: 'VIX',
            percentile: { riskTail: 'low' }, // 波动率低=压扁=自满=风险(逆向,恐慌飙高=机会)
          },
        ],
        desc: [
          '定义:标普 500 未来 30 天隐含波动率。是波动率保险的价格,不是方向指标。',
          '高 = 恐慌 / 保险贵;低 = 自满,诱导加杠杆(风险端,红)。',
          '事件级诊断要两条同现:① 水平冲高 ② 期限结构翻正(见 VX1−V3 格)。只满足 ① 不算。',
          '',
          '⚠️ 低位不是安全。「低波看杠杆,高波看流动性」——高波第一动作是减仓。',
          '⚠️ 高波也不自动等于底部(顶部派发 / 底部出清 / 真空期中段都长这样),要等结构翻转 + 流动性确认。',
          '⚠️ 极致缩圈下 VIX 被少数权重按住而失真,改用 VIXEQ 作权益侧代理。',
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'vxn',
            scale: 'right',
            color: '#f97316',
            title: 'VXN (纳指波动率)',
            percentile: { riskTail: 'low' },
          },
        ],
        desc: [
          '定义:纳指 100 隐含波动率。科技股版 VIX,通常高于 VIX。',
          '高 = 科技端定价了风险;低 = 自满(风险端,红)。',
          'VXN−VIX 走阔 = 风险向科技端集中;两者同时压扁 = 共振红灯。',
          '',
          '⚠️ 纳指是集中度最高的一端 —— VXN 被压低更可能是资金涌入少数权重把指数 vol 按住,不是风险变小。',
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l4',
            series: 'vixeq',
            scale: 'right',
            color: '#ec4899',
            title: '成分股波动率 VIXEQ',
            percentile: { riskTail: 'low' },
          },
        ],
        desc: [
          '定义:标普成分股平均单股隐含波动率。低 = 个股层面也自满(风险端,红);高 = 单股波动定价高。',
          '⭐ 核心不是水平,是 VIXEQ / VIX 比值 —— 读它等于读相关性 / 离散度(比值曲线见「特色指标 · 集中度」)。',
          SIGMA_ID,
          '比值抬升 = 集中度脆弱升高(头部压住 VIX、其余缺血推高 VIXEQ);',
          '缺口暴力收拢 = 相关性奔向 1 = 齐杀,系统性事件。',
          '',
          '⚠️ 比值本身中性,要看缺口怎么撑开的:真分化(宽度仍在)还是被巨头按住(宽度已塌)。',
          BREADTH_CHECK,
        ].join('\n'),
      },
      {
        id: 'p5',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l5',
            series: 'db:VX1',
            calc: { op: '-', series: 'db:VX3' },
            scale: 'right',
            color: '#a3a3a3', // 柱状正绿负红,颜色不起作用
            title: 'VX1−V3 期限结构',
            render: { kind: 'signed' }, // 期限结构:符号柱状图,不套分位带
          },
        ],
        desc: [
          '定义:VIX 期货近月 C1 − 三月 C3(绿正红负,仅表符号)。结构比水平更早给阶段信号。',
          '  · 红 / 负(contango,近低远高)= 常态。',
          '  · 绿 / 正持续走深 = 极度恐慌,须与 VIX 冲高同现才算事件级。',
          '  · ⭐ 由正翻负 = 核心翻转点,「事件消退」的最早数字证据。水平回落但仍残余正值 = 不算出清。',
          '',
          '⚠️ 不是「期权贵不贵」的判据 —— 它是期货曲线,管的是 VXX 那类工具的 carry。',
          '挑期权期限看下面 VIX−3M 那格。',
        ].join('\n'),
      },
      {
        id: 'p6',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l6',
            series: 'vixSpot',
            calc: { op: '-', series: 'vix3m' },
            scale: 'right',
            color: '#a3a3a3', // 柱状正绿负红,颜色不起作用
            title: 'VIX−VIX3M 即期期限结构',
            render: { kind: 'signed' }, // 同 VX1−V3:符号柱状图,不套分位带
          },
        ],
        desc: [
          '定义:VIX(30 天)− VIX3M(3 个月),两者都是恒定期限的即期隐含波动率。',
          '减号方向同 VX1−V3(近端 − 远端):绿 / 正 = backwardation,红 / 负 = contango(常态)。',
          '**挑期权期限看这格,不看 VX1−V3。** 转正 = 市场在抢短期保护,也意味着已经在事件里了 ——',
          '保护该在转正之前布置,不是之后。',
          '',
          '⚠️ 与 VX1−V3 不可互换:实测 9.5% 的交易日两者符号相反(VX3 是远期短期量、VIX3M 是即期长期量,',
          '且 VX1 滚动自带月度锯齿)。',
          '⚠️ 它是年化波动率**指数**,不是某张合约的报价 —— 只答「曲线哪段相对高低」,答不了「那张 put 贵不贵」。',
          '⚠️ SPX 口径。CBOE 不发纳指期限结构,对冲 QQQ 只能读 SPX 形状、承受基差。',
        ].join('\n'),
      },
      {
        id: 'p7',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l7',
            series: 'vix6m',
            scale: 'right',
            color: '#f97316',
            title: 'VIX6M(6 个月隐含波动率)',
            percentile: { riskTail: 'low' }, // 同 VIX:低 = 压扁 = 自满 = 风险
          },
        ],
        desc: [
          '定义:SPX 6 个月恒定期限隐含波动率。上面几格全是 30 天口径,而保护很少只布置一个月。',
          '低 = 市场认为未来很久都没事(风险端,红);高 = 长端保护也在涨价。',
          'P5/P95 带回答「你要持有的那个期限,现在在自身历史什么位置」。',
          '',
          '⚠️ 别当择时信号:长端波动率均值回归极慢,低分位可以待很久。',
          '⚠️ 是年化波动率指数,不是具体合约的权利金。',
        ].join('\n'),
      },
      {
        id: 'p8',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l8',
            series: 'skew',
            scale: 'right',
            color: '#38bdf8',
            title: 'CBOE SKEW(SPX 尾部偏度)',
            percentile: { riskTail: 'high' }, // 高 = 尾部保护被抢贵
          },
        ],
        desc: [
          '定义:用 SPX 30 天整条期权曲线算的风险中性偏度。100 = 正态(30 天内跌 2σ 的隐含概率约 2.3%),140 约 7.8%(CBOE 换算表)。',
          'VIX 量平值附近的波动;SKEW 量**深度虚值 put 相对 call 贵多少** —— 谁在为远端极端下跌付钱。',
          '高 = 尾部保护被抢贵。2018 年以来 74% 的交易日在 120~150,≥160 只占 3.8%。',
          '',
          '⚠️ 不是择时信号:SKEW 高常与 VIX 低同时出现(机构在平静期买便宜的尾部保险),历史上对随后跌幅的预测力很弱。',
          '要和 VIX、期限结构(VIX−3M)同看:三者一起抬 = 真在抢保护;只有 SKEW 冲 = 只是尾部变贵。',
          '⚠️ 只有 SPX 口径。对 QQQ 的尾部看「期权 · QQQ」的 25Δ skew(近平值那一翼,口径不同)。',
        ].join('\n'),
      },
      {
        id: 'p9',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l9',
            series: 'vixCotLm',
            scale: 'right',
            color: '#c084fc',
            title: 'CFTC VIX 期货净持仓 · Leveraged Money (% of OI)',
            // 不用 signed 柱:这条 95% 的周是净空,符号柱几乎恒红 = 零信息量。
            // 判据全在「当前净空在自身历史的哪个位置」,所以走 line + 分位带,0 线仍画出来。
            render: { kind: 'line', baseline: 0 },
            percentile: { riskTail: 'low' }, // 极端净空 = 卖波动拥挤 = 风险端
          },
        ],
        desc: [
          '定义:CFTC VIX 期货对冲基金净持仓 ÷ 总持仓。上面几格是期权市场在**定价**什么,这格是机构实际怎么**押注**。',
          '负 = 净空波动率(常态,95% 的周都是);跌到 P5 = 卖波动拥挤,一旦反转要回补,自己就是加速器。',
          '',
          '⚠️ **周频且滞后 3 天**:周二收盘持仓、周五 15:30 ET 才发。图上最右端是上周二的状态 ——',
          '波动率爆发的那几天恰好是它最没用的时候。只能当背景 regime,做不了触发器。',
          '⚠️ 归一化到 OI 是必须的:OI 在 20.8 万~65.4 万张之间摆(无趋势但 3 倍摆幅),',
          '裸净持仓的分位读的是「当时市场多大」不是「持仓多极端」。',
          '⚠️ 结构性常年净空(卖波动策略 + 短波动 ETP 对冲),负值本身不是信号,P5/P95 才是。',
          '⚠️ 美国政府关门期间停发(2019 那次停 3 个月),历史序列被事后补齐了,但实时会卡住。',
        ].join('\n'),
      },
      {
        id: 'p10',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l10',
            series: 'vixCotAm',
            scale: 'right',
            color: '#2dd4bf',
            title: 'CFTC VIX 期货净持仓 · Asset Manager (% of OI)',
            render: { kind: 'line', baseline: 0 },
            percentile: {}, // 方向不单一(信号在与上格的背离),不设风险端,只给 P5/P95 参考
          },
        ],
        desc: [
          '定义:CFTC VIX 期货资管盘净持仓 ÷ 总持仓。与上面对冲基金那格是两种钱。',
          '资管在 VIX 里更多是**买保护**的一侧(77% 的周净多),对冲基金是**卖波动**的一侧 ——',
          '所以看的是两者的背离:资管加保护 + 对冲基金仍深度净空 = 买方在撤、卖方还没转向,后周期形态。',
          '',
          '⚠️ 同上格:周频、滞后 3 天、读分位不读绝对值。方向不单一,故只给 P5/P95 参考不设风险端。',
          '⚠️ 类别归属是 CFTC 自己按申报主体划的,ETP 发行商的对冲流不一定落在你以为的那一桶里。',
        ].join('\n'),
      },
    ],
  },
  sentiment: {
    v: 1,
    panes: [
      QQQ_SPOT_PANE,
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'fng',
            scale: 'right',
            color: '#3b82f6',
            title: 'Fear & Greed',
            percentile: { riskTail: 'high' }, // 高=贪婪=风险
          },
        ],
        desc: [
          '定义:CNN Fear & Greed 综合情绪(0-100),多因子合成、粗略。',
          '高 = 贪婪(风险端,红);低 = 恐惧(常是机会)。读的是散户狂热度。',
          '',
          '⚠️ 单维极端只值得关注,不构成信号。真正危险的是共振——',
          RESONANCE,
          '⚠️ 反直觉:「热闹」时要警惕专业资金正在撤 —— 极端高波常来自大资金离场造成的流动性空白。',
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'cor1m',
            scale: 'right',
            color: '#22c55e',
            title: '隐含相关性 COR1M',
            percentile: { riskTail: 'low' }, // 低=分化/自满=风险
          },
        ],
        desc: [
          '定义:标普隐含相关性,成分股共动程度。低 = 隐含分化(风险端,红);高 = 共动更强。',
          '与 VIXEQ / VIX 比值是同一件事的两种写法(相关性 ≈ 1/比值²):相关性低 = 比值抬升;高 = 比值回落到 1 附近。',
          '⭐ 奔向 1 = 系统性事件:齐跌、分散化失效。',
          '',
          '⚠️ 低相关判不了好坏:可能是基本面真分化,也可能是集中度把指数 vol 按住的假象。',
          BREADTH_CHECK,
          '⚠️ 低相关 + 低 VIX 同现 = 平静建立在极少数支柱上,越极端越接近「差一个点火」。',
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l4',
            series: 'cor3m',
            scale: 'right',
            color: '#f59e0b',
            title: '隐含相关性 COR3M',
            percentile: { riskTail: 'low' }, // 同 COR1M:低=分化/自满=风险
          },
        ],
        desc: [
          '定义:Cboe 3 个月隐含相关性,标普前 50 大成分股两两隐含相关性均值。读法同上一格 COR1M,期限更长、更平稳(2018 起日变动标准差 2.5,COR1M 3.8)。',
          '2018 起最低 7.19(2026-07-10)。与 COR1M 之差见下一格。',
        ].join('\n'),
      },
      {
        id: 'p5',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l5',
            series: 'cor3m',
            calc: { op: '-', series: 'cor1m' },
            scale: 'right',
            color: '#14b8a6',
            title: '隐含相关性期限结构 COR3M − COR1M (pp)',
            render: { kind: 'line', baseline: 0 }, // 0 线即倒挂线
          },
        ],
        desc: [
          '定义:COR3M − COR1M,百分点。同日两腿相减,缺日跳过、不前向填充。',
          '常态 3M 在 1M 之上(正值):2006 起 77% 的交易日为正,中位 +3.9;2018 起 75%,中位 +3.0。',
          '收窄 = 两腿靠拢;**跌破 0(倒挂)= 近端共动定价高于远端**。',
          '例:2025-02-26 起倒挂,03-11 最深 −6.7,03-31 ~ 04-03 回正,04-04 ~ 04-08(关税冲击)再倒挂(最深 −3.2)。',
          '2018-02-05(Volmageddon)1M 82.9 / 3M 52.8,−30.2 是 2018 起最深。',
          '',
          '⚠️ 倒挂常是短暂的:2018 起共 114 段负值,35 段只持续 1 个交易日,最长 30 个交易日。',
          '⚠️ 期限结构只说「近端比远端紧」,不说方向;水位高低看 COR1M / COR3M 两格。',
        ].join('\n'),
      },
      {
        id: 'p6',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l6',
            series: 'rxm',
            calc: { op: '/', series: 'spx' },
            scale: 'right',
            color: '#a855f7',
            title: 'RXM/SPX (风险逆转相对表现)',
            percentile: {}, // 无可靠方向,只给 P5/P95 参考 + 徽标,不染背景带
          },
        ],
        desc: [
          '定义:Cboe 风险逆转指数 RXM(买 25Δ call / 卖 25Δ put 滚动策略)÷ SPX。',
          '衡量为「上行参与」付出 vs 为「下行保护」收取的净平衡。',
          '高 = 更愿卖 PUT、乐观,常对应市场被低估;低 = 下行保护偏贵,常对应高估阶段。',
          '低比值 + 低波动 = 典型「虚假平静」,共振清单里的期权情绪一格。',
          '',
          '⚠️ 累计表现比,水平受历史路径影响 —— 看「相对自身历史的低位」,不看绝对数。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
