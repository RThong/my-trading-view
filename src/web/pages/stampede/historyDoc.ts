// 「踩踏监控」历史图(页底,默认展开):上格标普 500 + 阶段三红底,下格综合压力分(方案 A,见 shared/calc/stampede)。
// 阶段一 / 二 / 四底色、断崖、升级都不画 —— 叠在一起看着像六七个阶段(用户验收意见)。序列由服务端算好。
import type { ChartDoc } from '../../views/chartDoc/chartDoc';

export const STAMPEDE_HISTORY: ChartDoc = {
  v: 1,
  panes: [
    {
      id: 'p1',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      // 同格里排在前面的画在上层:线压在背景上
      layers: [
        { id: 'l1', series: 'spx', scale: 'right', color: '#a3a3a3', title: '标普 500' },
        {
          id: 'bg3',
          series: 'stStage3',
          scale: 'right',
          color: '#ef4444',
          title: '阶段三 风暴',
          render: { kind: 'background', opacity: 0.22 },
        },
      ],
      desc: [
        '红底 = 当天判为阶段三 风暴(VIX ≥ 26 且(VIX/VIX3M ≥ 1 或 VVIX ≥ 110))。阶段需要五条输入同日都有,VIXEQ 2014-06 起。',
        '⚠️ 红底只在日线画;周 / 月线只剩标普。',
      ].join('\n'),
    },
    {
      id: 'p2',
      stretch: 0.6,
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ id: 'l2', series: 'stStress', scale: 'right', color: '#f59e0b', title: '综合压力分' }],
      desc: [
        '综合压力分(0–100):照付鹏原页的分段线性给分;GEX 按自身分位给 12 分,Dealer Gamma / Net Delta 没数据的 18 分按比例匀给其余各项。',
        '要三个 P/C 才算,所以 2019-10 起才有。',
        '读法(2019-10 起回测):20 分以下之后 21 日回撤 ≥5% 约 9%,过 20 翻倍到约 20%,60 以上约 28%;分数越高之后反弹也越大 —— 高分 = 已在风暴里,不是卖出信号。',
      ].join('\n'),
    },
  ],
};
