// 「宏观」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';
import { FICC_TRIANGLE } from '../../views/regime/descSnippets';

export const MACRO_DOCS = {
  macro: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'usd',
            scale: 'right',
            color: '#38bdf8',
            title: '美元指数 DXY',
            render: { kind: 'candle' }, // DXY 画蜡烛(用 data.ohlc.usd)
          },
        ],
        desc: [
          '定义:美元指数 DXY(对一篮子货币),蜡烛图。',
          '走强 = 压新兴市场 / 商品 / 风险资产;走弱 = 宽松。',
          '',
          '⭐ 关键不是水平,是**波动率**:低波横盘 = carry 不受扰动、资金安心留在美股核心;',
          '波动率一起来 = 全球流动性再分配,反身性加速。',
          FICC_TRIANGLE,
        ].join('\n'),
      },
    ],
  },
  // ISM 景气:头条(制造 vs 服务)+ 价格分项(制造 vs 服务)。两格各自同轴叠画 —— 同单位(扩散指数),
  // 而且「谁在上面」本身就是信息(服务业景气 / 通胀是否脱离制造业单独走)。
  // **分界线是 50 不是分位**:扩散指数的 50 是定义上的「与上月持平」,锚不会漂;分位带在这里反而是自指。
  ism: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'ismMfg',
            scale: 'right',
            color: '#38bdf8',
            title: 'ISM 制造业 PMI',
            render: { kind: 'line', baseline: 50 },
          },
          { id: 'l2', series: 'ismSvc', scale: 'right', color: '#f97316', title: 'ISM 服务业 PMI' },
        ],
        desc: [
          '定义:ISM 采购经理人调查的扩散指数(制造业 / 服务业),月频。**50 = 与上月持平**,',
          '上方 = 扩张、下方 = 收缩。每月第 1 个工作日发制造业、第 3 个工作日发服务业(10:00 ET)。',
          '',
          '读法:看**方向与离 50 的距离**,不看绝对水平的小数点。两条背离时(如制造业 < 50、服务业 > 55),',
          '经济的重心在服务业 —— 利率对它的敏感度与对制造业不同,别用制造业单条判整体。',
          '',
          '⚠️ **交货时间是反向计入头条的**:供应商交货变慢 → PMI 被**抬高**。供应冲击期(战争 / 港口 / 能源)',
          '头条里有一块是瓶颈不是需求,方向对利率仍偏鹰(瓶颈即通胀),但性质是滞胀不是过热。',
          '⚠️ 回填自 PR Newswire 历年发布件:每个月留的是**最后一次被发布的读数**(次月那篇会带回上月值),',
          'ISM 每年 1 月重估季节因子只能带回上一个月,更早月份仍是当时的初值 —— 读水平与方向够用,精确回测不够。',
          '⚠️ 与 S&P Global PMI 是两套调查(样本、权重、服务业头条定义都不同),同月数字不同甚至方向相反都正常。',
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'ismMfgPrices',
            scale: 'right',
            color: '#38bdf8',
            title: 'ISM 制造业 Prices',
            render: { kind: 'line', baseline: 50 },
          },
          { id: 'l4', series: 'ismSvcPrices', scale: 'right', color: '#f97316', title: 'ISM 服务业 Prices' },
        ],
        desc: [
          '定义:ISM 调查的**价格分项**(采购端付出的价格,不是企业售价),扩散指数,50 = 价格与上月持平。',
          '**这是 PMI 里对利率最敏感的一格** —— 它是 CPI / PCE 的上游,领先商品通胀约 1~3 个月。',
          '',
          '读法:高于 50 越远 = 涨价面越广。制造业那条对油价、原材料极敏感(波动大);',
          '服务业那条含人工成本,更粘 —— **服务业 Prices 居高不下比制造业冲高更难对付**。',
          '',
          '⚠️ 扩散指数只数「涨的企业比跌的多多少」,**不含涨幅**:70 可能是很多家小涨,也可能是少数家暴涨。',
          '⚠️ 回填口径同上一格(每月最后一次被发布的读数,非官方修订后全序列)。',
        ].join('\n'),
      },
    ],
  },
} satisfies RegimeDocs;
