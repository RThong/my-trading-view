// 「BTC」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import { normalBand, type Layer, type Pane } from '../../views/chartDoc/chartDoc';

/**
 * 周末灰色背景带(周六 / 周日):BTC 7×24,周末成交 / 波动偏少,和工作日分开看。背景色带只在日线画。
 * id 按格传:图层 id 在整张图里必须唯一
 */
function weekendBg(id: string): Layer {
  return { id, series: 'weekendFlag', scale: 'right', color: '#a3a3a3', title: '周末', render: { kind: 'background' } };
}
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';

/**
 * BTC 现货蜡烛,**「现货/夏普」与「链上」两个 tab 共用同一份**(同 QQQ_SPOT_PANE 的理由:抄两遍必漂)。
 * 链上那格要对着价格读:筹码密度冲高之后往哪边破,只有价格答得了。
 */
const BTC_SPOT_PANE: Pane = {
  id: 'p1',
  stretch: 1,
  // 2012 起跨 4 个数量级(约 2.9 万倍):普通坐标下早年几轮周期全压在底部,走对数轴
  scales: [{ id: 'right', side: 'right', log: true }],
  layers: [
    {
      id: 'l1',
      series: 'btc',
      scale: 'right',
      color: '#f7931a',
      title: 'BTC 现货 (USD)',
      render: { kind: 'candle' },
    },
    weekendBg('wk1'),
  ],
  desc: [
    '定义:BTC 现货日线蜡烛,Bitstamp 全段(UTC 0 点切日;Yahoo BTC-USD 降级)。**参照物,不是判据**。',
    '「现货/夏普」tab 和下一格夏普同读:价格新高但夏普走低 = 这轮涨幅是靠加波动换来的,不是趋势变强。',
    '「链上」tab 和下一格供应密度同读:密度冲过 15% 之后往哪边破,看这格。',
    '',
    '⚠️ 含周末(crypto 7 天有数),与本站其它 5 天口径的序列并排看时注意日期对不齐。灰色背景 = 周六 / 周日(只在日线画)。',
    '⚠️ 单一交易所:收盘与综合价差 ~0.02%,但急跌时 Bitstamp 盘口薄、影线可能比别处深几个点(只影响影线)。',
    '⚠️ 起于 2012-01(比全站其它序列的 2018 早得多):四轮周期才够看夏普顶部递减,故 BTC 单独放长。',
  ].join('\n'),
};

export const BTC_DOCS = {
  // BTC:现货蜡烛 + 成交额 + 1Y 滚动夏普。「涨了多少」「多少人在买卖」「这些涨幅值不值那点波动」。
  btc: {
    v: 1,
    panes: [
      BTC_SPOT_PANE,
      {
        id: 'p3',
        stretch: 0.5,
        // 不夹轴:周 / 月线按期求和后数值大一个量级,写死的上限会把所有柱子顶满
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'btcVolume',
            scale: 'right',
            color: '#94a3b8',
            title: 'BTC 现货日成交额 (Binance, 亿美元)',
            render: { kind: 'volume' },
          },
          weekendBg('wk2'),
        ],
        desc: [
          '定义:Binance 现货 BTCUSDT 每天的成交额(USDT 计 ≈ 美元),亿美元,2017-08 起。周 / 月线下按期求和。',
          '放量下跌 = 有人真在卖;缩量阴跌 = 没人接也没人砸。和上一格蜡烛对着看。',
          '',
          '年度中位(亿美元/日):2018 2.4、2020 6.1、2021 29、2022 27、2023 13、2024 19、2025 18、2026 12。',
          '',
          '⚠️ 2022-07-08 ~ 2023-03 零手续费活动:刷量把那段吹高(期间中位 47,前一年 20、后一年 12),不是真实活跃度;',
          '   单日最高的 5 天也都在这段里:2023-03-13~17 SVB 那周 108~175、2022-11-08 FTX 148。',
          '⚠️ 单一交易所:全球现货量的一部分,份额随年份变(和 K 线的 Bitstamp 不是同一家,UTC 0 点切日相同)。',
          '⚠️ 只到昨天(UTC):当天还在累计的那根不画,免得看起来像突然缩量。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'btcSharpe1y',
            scale: 'right',
            color: '#8b5cf6',
            title: 'BTC 1Y 滚动夏普 (年化)',
            render: { kind: 'line', baseline: 0 },
            refLines: normalBand(-2, 2.9),
          },
          weekendBg('wk3'),
        ],
        desc: [
          '定义:过去 365 天日对数收益的 均值/标准差 × √365。「每承受一单位波动换回多少超额涨幅」。',
          '穿零 = 这一年白折腾(风险调整后没赚)。高 = 涨得又稳又多;深负 = 跌且乱。',
          '',
          '带的两端不是同一种东西,分开读:',
          '  · **下限 −2.0 是硬底**:2015 / 2018 / 2022 三轮投降都停在 −2 附近就不再深了。触到 = 熊市末段的形态。',
          '  · **上限 2.9 是「比上一轮还热」的门**,不是历史高位 —— 每轮顶部在递减',
          '    (2013 顶 5.07 → 2017 顶 3.59 → 2021 顶 3.30 → 2024 顶 2.89),资产变大、超额收益变薄。',
          '    所以突破 2.9 的含义是「热过上一轮」,而不是「接近历史极值」。',
          '',
          '⚠️ 顶部递减这条趋势只有四个点,别拿它当可外推的直线用 —— 它解释过去,不定位下一个顶在哪。',
          '⚠️ 未减无风险利率(纯 return/vol);rf 只挪 ~0.08,不影响读法。',
          '⚠️ 滚动 365 天 = **回看**,不是预测。它的顶不会提前告诉你顶到了,只会在事后被确认。',
        ].join('\n'),
      },
    ],
  },
  // BTC 链上:筹码分布(供应密度)+ 估值(AVIV),都来自 BRK,单独一个 tab。
  btcOnchain: {
    v: 1,
    panes: [
      BTC_SPOT_PANE,
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right', expandVisibleTo: [1, 19] }],
        layers: [
          {
            id: 'l2',
            series: 'btcSupplyDensity',
            scale: 'right',
            color: '#14b8a6',
            title: 'BTC 已实现供应密度 (收盘价 ±5%,7 日均线,%)',
            // 配色与范围照 Murphy 原图(粉 13% 警戒 / 紫 15% 高风险,纵轴 1%~19%)。
            refLines: [
              { price: 13, title: '警戒 13%', color: '#ec4899' },
              { price: 15, title: '高风险 15%', color: '#a855f7' },
            ],
          },
          // 原始日值只给悬停读数:比均线早过线几天,但单日能跳 10pp,上图就是一片毛刺。
          {
            id: 'l3',
            series: 'btcSupplyDensityRaw',
            scale: 'right',
            color: '#94a3b8',
            title: '原始日值 (%)',
            hidden: true,
          },
          weekendBg('wk4'),
        ],
        desc: [
          '定义:链上成本价落在当日收盘价 ±5% 内的 BTC 占总供应的比例,取 7 日均线',
          '(Glassnode「Realized Supply Density」的免费复刻,@Murphychen888 叫它「供应集中度」)。',
          '高 = 大量筹码成本挤在现价附近,价格一旦脱离这个区间,同时翻转一大批人的盈亏 → 波动率扩张的前兆。',
          '**只说「要动」,不说往哪动**:2025-02 / 2025-11 / 2026-01 三次冲过 15% 后都是大跌,',
          '但同样的结构也能向上突破。',
          '',
          '13% 警戒 / 15% 高风险两条线取自 Murphy 的图(2024-10 起两年,三次样本),不是统计出来的分位。',
          '',
          '⚠️ 源是 BRK(开源、自建全节点)算好的 supply_density 序列,不是 Glassnode。对账:与 Murphy 图形状逐段吻合,',
          '读数偏高 ~0.2–0.3pp(2026-08-01 13.2 vs 12.9,10-02 12.2 vs 12)。压线附近别当已触发。',
          '⚠️ 为什么是 7 日均线:原始日值单日能跳 10pp(价格一动,±5% 窗口就换一批筹码);',
          '用 7 日均线和 Murphy 三个公开读数最吻合。代价是比原始值慢几天。',
          '悬停读数里的「原始日值」就是没平滑的那条:2024-10 起均线 9 次上穿 15%,原始值都不晚于它过线',
          '(中位早 3 天),但同期原始值上穿了 30 次 —— 多出的 21 次是单日毛刺。只当「可能要来了」的预告看。',
          '⚠️ 当天(UTC)那个点是盘中快照,次日重拉才定;含周末(crypto 7 天)。',
        ].join('\n'),
      },
      // 估值:密度说「要动」,这格说「贵还是便宜」—— 大底只在这格压到成本线附近时出现。
      // 只留 AVIV 不留 MVRV:两条日变化相关 0.999、AVIV ≈ MVRV × 0.69,MVRV < 1 的日子 AVIV 全都 < 0.8,
      // 信息完全重复(2026-11-16 用户定);MVRV 仍入库、/api/regime 仍发 btcMvrv,要用随时加回
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l5',
            series: 'btcAviv',
            scale: 'right',
            color: '#a855f7',
            title: 'BTC AVIV (现价 ÷ 活跃投资者成本)',
            render: { kind: 'line', baseline: 1 },
            refLines: [
              { price: 0.8, title: '低估 0.8', color: '#22c55e' },
              { price: 1.9, title: '近两轮顶 1.9', color: '#ef4444' },
            ],
          },
          weekendBg('wk5'),
        ],
        desc: [
          '定义:AVIV = 现价 ÷ True Market Mean(活跃投资者的平均买入成本,Glassnode × ARK 的 Cointime 口径):',
          '扣掉矿工成本、给长期不动的币降权 —— 早年零成本、可能已丢失的币不再把成本线拉低,更接近「现在还在场的人」的盈亏平衡点。',
          'ETF、MSTR 托管的币都在链上,自动算在里面,不用再另加 ETF 成本。',
          '',
          '⭐ < 0.8 是低估区(约 2012 起 17% 的日子、20 分位附近):2018-12 0.49、2020-03 0.65、2022-11 0.51、2026-06 0.76。',
          '   实测 2015 起 < 0.8 之后 180 天中位 +50%(同期任意一天 +29%)。',
          '⭐ 和常见的 MVRV(现价 ÷ 全市场平均持仓成本)是同一件事:日变化相关 0.999,AVIV ≈ MVRV × 0.69。',
          '   MVRV 跌破 1(整体浮亏)的日子 AVIV 全都 < 0.8;AVIV 还多抓到 2026-06 那次(MVRV 只到 1.10)。',
          '⭐ 顶部同样递减:2013 3.25 → 2017 3.0 → 2021-02 2.7 → 2021-10 2.0 → 2024-03 1.9 → 2024-11 1.86。',
          '',
          '⚠️ 只抓周期大底、不抓短底:一段能持续几个月(2018-11 ~ 2019-04、2022-06 ~ 2023-01);底部也在抬高,样本只有四轮,别当铁律。',
          '   参照站把它当「链上 + ETF 综合成本」的首选线。',
          '⚠️ 源是 BRK 的 aviv 序列(True Market Mean 那条也有,未接)。当天(UTC)那个点是盘中值。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
