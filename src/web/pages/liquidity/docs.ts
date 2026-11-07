// 「流动性」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';

// 跨格复用的框架文本:同一判据被多个 desc 引用,抽常量避免改一处漏一处。
// 一律写成条件判据,不写「某年某月读数」——快照会过期,而图上就有当期值。
const FIVE_STEPS =
  '五步观测:① 净流动性转头(预警)→ ② RRP 见底(缓冲耗尽)→ ③ IORB−SOFR 跌破 0 + ④ repo 冒尖(咬人)→ ⑤ canary 齐跌(系统性)。';

export const LIQUIDITY_DOCS = {
  liquidity: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'netLiquidity',
            scale: 'right',
            color: '#22c55e',
            title: '净流动性 (WALCL−TGA−RRP,十亿美元)',
          },
        ],
        desc: [
          '定义:净流动性(粗略代理)= 总资产 WALCL − 财政部账户 TGA − 逆回购 RRP,周三时点,周频。',
          '升 = 宽松倾向(利多风险资产);降 = 收紧倾向。',
          '看拐点不看水平——绝对水位无普适阈值,高点转头 = 量边际收紧 = 最早预警。',
          '',
          '⚠️ 是启发式存量代理,**不是实际流入市场的资金量**。',
          '⚠️ 降息 ≠ 宽松:短端降息 + 长期缩表 = 利率松而总量紧,流动性仍在收。',
          '⚠️ 储备管理阶段(RMP)最易出假信号:补储抬升 WALCL,不等于政策转向宽松。',
          '⚠️ 含 ~2.5T 流通现金与海外官方回购池(周波动可达 ±30B),水位看准备金那格。',
          '⚠️ TGA 是单日时点:缴税日(4/15·6/15·9/15·12/15)/ 季末那周的单周大跌先认日历,几周内回吐的不算转头。',
          FIVE_STEPS,
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'reserves',
            scale: 'right',
            color: '#3b82f6',
            title: '准备金 (WRBWFRBL 周三时点,十亿美元)',
          },
        ],
        desc: [
          '定义:银行存在美联储的准备金余额,周三时点,周频(H.4.1 周四发)。',
          '升 = 银行体系现金变多;降 = 被 TGA 回补 / 缩表 / RRP 上升(资金停回联储)抽走。',
          '和净流动性的分工:净流动性看拐点方向,准备金看**水位** —— 离「充裕下沿」多远要拿它比(联储不公布下沿,各方估计不一,故不画线)。',
          '',
          '⚠️ 单周跳变先认日历:企业缴税日(4/15·6/15·9/15·12/15)、季末、国债大额结算。',
          '⚠️ RRP ≈ 0 之后 TGA 每涨 1 美元准备金几乎就少 1 美元 —— 要提前看,回财政部 DTS 查日度 TGA。',
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [{ id: 'l3', series: 'reverseRepo', scale: 'right', color: '#14b8a6', title: '逆回购 RRP (十亿美元)' }],
        desc: [
          '定义:货币基金等把现金隔夜停在美联储的量(ON RRP)。过剩流动性的泄洪垫。',
          '高 = 缓冲厚;下降 = 现金回到货币市场、同时缓冲在消耗;',
          '见底 ≈ 0 = 缓冲耗尽,此后任何冲击直接打在准备金上。',
          '',
          '⚠️ 下降本身偏释放,但常被 TGA 重建 / QT 抵消 —— 后两者才是真正收紧。',
          '⚠️ 归零 ≠ 已缺水,含义是「缓冲没了」——它把后续冲击的传导时间压到最短。',
          '⚠️ 它测缓冲、不测分布;分布看回购用量那格。',
          FIVE_STEPS,
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          { id: 'l4', series: 'repoUsage', scale: 'right', color: '#ec4899', title: '回购用量 (隔夜正回购 RPONTSYD)' },
        ],
        desc: [
          '定义:美联储隔夜正回购总量(含常备回购便利 SRF)。安全阀 —— 动用 = 联储后备融资相对私人市场变得划算。',
          '低 / 近零 = 后备融资少被调用;集群 / 持续抬升 = 市场融资相对变贵,结构性咬人。',
          '最敏感的一盏灯——它测「分布」,比利差更早暴露碎片化。',
          '',
          '⚠️ SRF 是常设工具,有经济性时本就会被用 —— 单次动用不等于私人市场已失灵。',
          '⚠️ 剔除月末 / 季末 / 缴税日的技术性尖刺,只在这些日子冒尖不算信号。',
          FIVE_STEPS,
        ].join('\n'),
      },
      {
        id: 'p5',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l5',
            series: 'iorb',
            calc: { op: '-', series: 'sofr' },
            scale: 'right',
            color: '#a855f7',
            title: '回购压力 (IORB−SOFR)',
            render: { kind: 'line', baseline: 0 },
          },
        ],
        desc: [
          '定义:准备金利率 IORB − 隔夜 SOFR。正 = SOFR 低于 IORB = 融资宽松。',
          '收窄 = 融资边际趋紧;跌破 0 = 从「摩擦」升级到「缺氧」,继续走负 = SOFR 上冲(2019 钱荒型)。',
          '',
          '⚠️ 别拿固定区间当基准 —— 中枢随准备金变稀缺整体下移,要比的是相对自身近年中枢有没有收窄。',
          '⚠️ 它测「融资可用性」,不测「储备总量」;回到正值区 ≠ 流动性已恢复。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
