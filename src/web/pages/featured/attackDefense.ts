// 「特色指标 · 攻防」tab:上 QQQ 蜡烛,下 NOBL / QQQ 比值 + 慢线背景(ZigZag 攻防 regime)+ 快线底部细带。
// 序列都由服务端算好(shared/calc/attackDefense),这里只是一份 ChartDoc,与图表编辑器同一格式。
import { FAST_BAND, FAST_MA, SWING_PCT } from '../../../shared/calc/attackDefense';
import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import type { ChartDoc, Layer } from '../../views/chartDoc/chartDoc';

// 防守绿、进攻红:同全站涨绿跌红
const DEFENSE = SIGNED_UP;
const OFFENSE = SIGNED_DOWN;
// 慢线背景:已确认的深一些,末段待定(拐点还没确认,随时可能被改写)浅一些;快线细带用近实色,和背景分得开
const CONFIRMED = 0.35;
const PENDING = 0.15;
const STRIP = 0.9;

function band(id: string, series: string, title: string, color: string, opacity: number, strip?: true): Layer {
  return { id, series, scale: 'right', color, title, render: { kind: 'background', opacity, ...(strip && { strip }) } };
}

export const ATTACK_DEFENSE: ChartDoc = {
  v: 1,
  panes: [
    {
      id: 'p1',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ id: 'l1', series: 'qqq', scale: 'right', color: '#38bdf8', title: 'QQQ', render: { kind: 'candle' } }],
      desc: '定义:QQQ(纳指 100 ETF)蜡烛。\n进攻资产的价格参照。',
    },
    {
      id: 'p2',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      // 同格里排在前面的画在上层(同 TradingView):快线细带要压在慢线背景上面,否则半透明的背景盖上去混成橄榄色
      layers: [
        // 中性灰:压在红绿背景上、明暗两种底色下都看得清
        { id: 'l3', series: 'noblQqq', scale: 'right', color: '#78716c', title: 'NOBL/QQQ' },
        { id: 'l2', series: 'noblQqqMa35', scale: 'right', color: '#f59e0b', title: `MA${FAST_MA}` },
        band('st1', 'adFastDefense', '快线防守', DEFENSE, STRIP, true),
        band('st2', 'adFastOffense', '快线进攻', OFFENSE, STRIP, true),
        band('bg1', 'adZigDefense', '防守', DEFENSE, CONFIRMED),
        band('bg2', 'adZigOffense', '进攻', OFFENSE, CONFIRMED),
        band('bg3', 'adZigDefensePending', '防守(待定)', DEFENSE, PENDING),
        band('bg4', 'adZigOffensePending', '进攻(待定)', OFFENSE, PENDING),
      ],
      desc: [
        '定义:NOBL / QQQ 比值。',
        'NOBL = 标普红利贵族(防守),QQQ = 成长(进攻)。上行(绿)= 防守跑赢 = 避险;下行(红)= 进攻跑赢 = risk-on。',
        `背景(慢,事后确认):ZigZag ${SWING_PCT * 100}% 反转阈值识别的上行 / 下行 regime;拐点回贴到极值日,是事后才知道的;末段未确认用淡色。`,
        `底部细色带(快,当日可知):比值高于 ${FAST_MA} 日均线 ${FAST_BAND * 100}% 以上翻绿、低于 ${FAST_BAND * 100}% 以上翻红,带内保持。`,
        '色带与背景同色 = 一致;色带先翻反色 = 预警(实测约 4 成是假警报)。',
        '盲区:全市场齐跌(如 2020-03)比值不动,本指标看不出。',
        '⚠️ 背景与细带只在日线画;周 / 月线只剩比值和均线。',
      ].join('\n'),
    },
  ],
};
