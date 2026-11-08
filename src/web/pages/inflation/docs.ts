// 「通胀」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';
import { curveHistoryDoc } from '../curveHistory';

export const INFLATION_DOCS = {
  // 通胀来源(供给侧):薪资增速 + 服务黏性 + 汽油同比,外加核心 CPI / PCE 发布值。与 BEI(市场前瞻预期)并读。高=通胀压力=风险。
  // RBOB YoY:CPI 汽油分项的高频前瞻(汽油是 headline CPI 波动最大的分项),领先约 0-1 月。
  inflSource: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'wages',
            scale: 'right',
            color: '#f59e0b',
            title: '薪资增速 (Atlanta Fed)',
            percentile: { riskTail: 'high' }, // 高=通胀压力=风险(红);低=缓解=绿
          },
        ],
        desc: [
          '定义:亚特兰大联储薪资增速 tracker(时薪同比中位数,3 个月移动平均)。月频。',
          '高 = 工资涨得快、通胀更黏(风险端,红);低 = 压力缓解(绿)。',
          '⭐ 核心服务通胀最终受薪资驱动 —— 薪资不回落 = 短端锚抬高 = 降息空间受限。',
          '',
          '⚠️ 判「可持续通胀」不看水平,看物价—薪资正反馈有没有被激活 ——',
          '一旦激活靠经济自身切不断(对照 2010-11:油价推的通胀属暂时性,会自行回落)。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'stickyCpi',
            scale: 'right',
            color: '#8b5cf6',
            title: 'Sticky CPI (服务黏性)',
            percentile: { riskTail: 'high' },
          },
        ],
        desc: [
          '定义:亚特兰大联储 Core Sticky-Price CPI **同比**(剔除食品能源、调价频率低的篮子,服务为主)。月频。',
          '高 = 核心通胀顽固(风险端,红);低 = 黏性在松。',
          '与薪资是同一条链的两端(薪资 → 核心服务 → 黏性)。',
          '',
          '⚠️ 高且不降 = 短端被通胀锚住 →「降息 = 宽松」不成立,央行黏性不破不轻易转向,',
          '也不被衰退呼声吓倒。后果是深度倒挂可长期持续。',
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'rbobYoy',
            scale: 'right',
            color: '#fb923c',
            title: 'RBOB 汽油 YoY%',
            render: { kind: 'line', baseline: 0 }, // YoY 会穿零
            percentile: { riskTail: 'high' },
          },
        ],
        desc: [
          '定义:RBOB 汽油近月期货的同比(YoY%)。CPI 汽油分项的高频前瞻,领先约 0-1 月。',
          '高 = 能源在给通胀加压(风险端,红);低于 0 = 拖累(绿)。只管 headline / 能源,不碰核心 CPI。',
          '',
          '⚠️ 真正要盯的不只是水平,是油价波动率 —— 油是 FICC 低波三角之一,',
          '波动率急放大 = 通胀预期重定价 → 曲线剧动 → 杀成长股贴现。',
          '⚠️ 地缘冲击到油价有约 60–90 天缓冲(航运调节 + SPR + 炼厂库存),缓冲长度按事件重估。',
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          { id: 'l4', series: 'coreCpiYoy', scale: 'right', color: '#e879f9', title: '核心 CPI 同比%' },
          { id: 'l5', series: 'coreCpi3m', scale: 'right', color: '#a3e635', title: '核心 CPI 3 个月年化%' },
        ],
        desc: [
          '定义:BLS 核心 CPI(CPILFESL,剔除食品能源,季调)的同比与 3 个月年化。月频 %。',
          '3 个月年化比同比早转向 —— 两条交叉、或 3 个月那条单月跳开,就是「这次数据推没推动重定价」要查的那种月份。',
          '',
          '⚠️ **横轴是数据所属月份,不是发布日**(8 月的数 9 月中才发)。别拿它对日线的断点;',
          '对断点请看「利率 → 定价走势」那格的发布日竖线。',
          '⚠️ 值是**当前修订后**的,不是当时首发的那个数;2025-10 因停摆从未发布,那一月及依赖它的 3 个月年化空着。',
        ].join('\n'),
      },
      {
        id: 'p5',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          { id: 'l6', series: 'corePceYoy', scale: 'right', color: '#60a5fa', title: '核心 PCE 同比%' },
          { id: 'l7', series: 'corePce3m', scale: 'right', color: '#a3e635', title: '核心 PCE 3 个月年化%' },
        ],
        desc: [
          '定义:BEA 核心 PCE 价格指数(PCEPILFE)的同比与 3 个月年化。月频 %。**联储 2% 目标盯的是这条,不是 CPI**。',
          '比 CPI 晚两周左右出(同月的 CPI / PPI 已经把大部分信息放出来了),市场对它的反应通常小于 CPI。',
          '',
          '⚠️ 横轴是所属月份不是发布日;值是当前修订后的(PCE 修订幅度大于 CPI)。发布日竖线见「定价走势」。',
        ].join('\n'),
      },
    ],
  },
  // 实际收益率与 BEI 同档位、刻意同一组默认显示 —— 与「实际走势」并排就是「名义 − BEI = 实际」的两边
  beiHistory: curveHistoryDoc({
    family: 'bei',
    shown: ['5Y', '10Y', '30Y'],
    desc: [
      '定义:盈亏平衡通胀率(BEI)各期限的时间走势。',
      'BEI = 名义 − TIPS 实际收益率 = 市场通胀补偿(含通胀风险溢价),可作预期代理但非纯预期。',
      '差值读法见下方那格的 ⓘ。',
    ].join('\n'),
    spreads: [
      {
        long: '10Y',
        short: '5Y',
        title: '10Y − 5Y',
        desc: '定义:10Y − 5Y BEI(虚线 = 0)。远端通胀补偿相对近端的差:正 = 市场把通胀风险定价在更远端。',
      },
    ],
  }),
} satisfies RegimeDocs;
