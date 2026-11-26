// 「特色指标 · 攻防」tab:上 QQQ 蜡烛 + XLP 收盘线,下 XLP / QQQ 比值 + 慢线背景(ZigZag 攻防 regime)+ 快线底部细带。
// 序列都由服务端算好(shared/calc/attackDefense),这里只是一份 ChartDoc,与图表编辑器同一格式。
import { FAST_BAND, FAST_MA, SWING_PCT } from '../../../shared/calc/attackDefense';
import { ROTATION_LABELS } from '../../../shared/calc/rotationPhase';
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

// 上格的轮动阶段标注(高切低 → 通杀 → 见底,见 shared/calc/rotationPhase):竖线倒推画在极值日,灰虚线 = 算法当天确认的日子
// 竖线一律 1px 细线(满宽柱放大后会盖住同一根 K 线上的箭头),确认日 / 待定用虚线
function vline(id: string, series: string, title: string, color: string, line: 'solid' | 'dash' = 'solid'): Layer {
  return { id, series, scale: 'right', color, title, render: { kind: 'events', line } };
}
function tri(
  id: string,
  series: string,
  title: string,
  color: string,
  shape: 'up' | 'down',
  text?: Record<string, string>,
): Layer {
  return { id, series, scale: 'right', color, title, render: { kind: 'markers', shape, ...(text && { text }) } };
}
const ROTATION: Layer[] = [
  tri('rp8', 'rpLabel', '分型', '#737373', 'down', ROTATION_LABELS),
  tri('rp6', 'rpLowA', '阶段低点 A', '#16a34a', 'up'),
  // 还会挪的 A(这一簇 VIX ≥ 30 没结束):淡绿 + 字,和定下来的分开,实时看图别把候选当底
  tri('rp11', 'rpLowACandidate', '阶段低点 A(候选)', '#86efac', 'up', { '1': 'A 候选' }),
  tri('rp7', 'rpLowB', '阶段低点 B', '#f97316', 'up'),
  vline('rp1', 'rpPeakQ', '① QQQ 高点', '#2563eb'),
  vline('rp2', 'rpPeakX', '② XLP 高点', '#7c3aed'),
  vline('rp3', 'rpPeakXPending', '② 待定', '#7c3aed', 'dash'),
  vline('rp4', 'rpBottom', '③ 底', '#16a34a'),
  vline('rp5', 'rpConfirm', '确认日', '#737373', 'dash'),
  // 当时出现过、事后挪走 / 撤销的(回看时还原当时看到的样子):淡色、不写字(2022 年挪走的 A 有十几个,写字会糊成一片)
  tri('rp12', 'rpLowAGhost', 'A(已挪走)', '#86efac', 'up'),
  tri('rp13', 'rpLowBGhost', 'B(已撤销)', '#fdba74', 'up'),
  vline('rp14', 'rpBottomGhost', '③(已撤销)', '#86efac', 'dash'),
  band('rp15', 'rpKillGhost', '通杀(已撤销)', '#ef4444', 0.06),
  band('rp9', 'rpRotate', '高切低', '#f59e0b', 0.15),
  band('rp10', 'rpKill', '通杀', '#ef4444', 0.15),
];

export const ATTACK_DEFENSE: ChartDoc = {
  v: 1,
  panes: [
    {
      id: 'p1',
      stretch: 1,
      scales: [
        { id: 'right', side: 'right' },
        { id: 'left', side: 'left' },
      ],
      layers: [
        { id: 'l1', series: 'qqq', scale: 'right', color: '#38bdf8', title: 'QQQ', render: { kind: 'candle' } },
        { id: 'l4', series: 'XLP', scale: 'left', color: '#a78bfa', title: 'XLP' },
        ...ROTATION,
      ],
      desc: [
        '定义:QQQ(纳指 100 ETF,进攻)蜡烛,右轴;XLP(必需消费 ETF,防守)收盘价,紫线,左轴。',
        '读法:高切低 = QQQ 往下、XLP 往上(资金从进攻挪到防守,下格比值上行);',
        '通杀 = 两条一起往下(防守也被卖,下格比值可能不动,要看这一格)。',
        '',
        '阶段标注(算法自动,1999 起):竖线倒推画在极值日 —— 蓝 ① QQQ 高点、紫 ② XLP 高点、绿 ③ 底;',
        '灰虚线 = 算法当天确认的日子(① 确认 = 进入高切低,② = 进入通杀,③ = 进入见底);紫虚线 = 进行中这轮的 ②,XLP 再创新高会后移。',
        '底色:黄 = 高切低(① → ②),红 = 通杀(② → ③)。',
        '↑ 绿 A = 通杀期 VIX ≥ 30 且接近通杀以来最高的那一簇里 QQQ 最低那天;↑ 橙 B = 日线 RSI 或 MACD 底背离、当周 VIX ≥ 30(约晚一周确认)。A、B 同日更可靠。',
        '↑ 淡绿「A 候选」= 这一簇 VIX ≥ 30 还没结束(VIX 连续超过 7 个自然日没再 ≥ 30 才算完),QQQ 再创新低它就挪过去;定下来才变深绿。',
        '深色箭头和 ③ 是事后定下的位置;当时出现过、后来挪走或撤销的画成淡色:淡绿 ↑ = 挪走的 A、淡橙 ↑ = 撤销的 B、',
        '淡绿虚线 = 撤销的 ③(QQQ 跌破且 VIX ≥ 30 退回通杀)、浅红底 = 撤销的通杀(XLP 再创新高退回高切低)。深浅一起看才是当时看到的样子。',
        '③ 晚 8~20 个交易日才出现;B 晚 5 个交易日才出现,但箭头画在低点那天。',
        '① 顶上 ↓ 旁的字是分型,通杀确认那天就定了:第一阶段 VIX 曾 ≥ 30 = 磨底型,否则 V 形。',
        '磨底型里 A 只在出现过周线底背离的那一波恐慌里才画:周线 RSI6 跌破 30 后拐头,和上一个超卖拐点比价格更低、RSI6 高 ≥ 2 或 MACD 更高;',
        '要等下一周拐头才确认;磨底型的 B 也要和周线背离同周或相邻周。2022 年 06-24、10-07 各确认一次(第一次那个底 09-30 被跌破撤销),2000 那轮 2002-10-11 确认、落在真正的大底。',
        '不加这条时,2022 年 2 月起 A 先后冒出约 20 个,第一个之后还跌 23%;2001-04 的「底」之后又跌了一半多(到 2002-10)。',
        '按历史:V 形里第一个 A 离底 0~1 天、买入后最多再跌 1~3%。',
        '规则:高切低 = QQQ 距 250 日高点 ≤ −5%、XLP 距 60 日高点 ≥ −2%、XLP 60 日涨 ≥ 2%、XLP/QQQ 60 日涨 ≥ 10%;',
        '② 只在 ① 之后 QQQ 第一次 EMA20 下穿 EMA50 之后找、不含死叉当天(进攻腿还没转弱时 XLP 先见顶,只是防守在涨);通杀 = XLP 从本轮高点回撤 ≥ 5% 且 VIX ≥ 25;见底 = 底之后 QQQ 反弹 ≥ 10% 且 VIX < 25。',
        '不画的轮:确认时 HY 利差 ≥ 6%(信用危机型,如 2008)、第一阶段不足 20 个交易日(如 2025-04)、没走到通杀的。',
        '⚠️ 只作参考:完整样本只有 4 轮(磨底型只有 2000–02、2022),阈值按历史定,可能过拟合。底色只在日线画。',
      ].join('\n'),
    },
    {
      id: 'p2',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      // 同格里排在前面的画在上层(同 TradingView):快线细带要压在慢线背景上面,否则半透明的背景盖上去混成橄榄色
      layers: [
        // 中性灰:压在红绿背景上、明暗两种底色下都看得清
        { id: 'l3', series: 'xlpQqq', scale: 'right', color: '#78716c', title: 'XLP/QQQ' },
        { id: 'l2', series: 'xlpQqqMa20', scale: 'right', color: '#f59e0b', title: `MA${FAST_MA}` },
        band('st1', 'adFastDefense', '快线防守', DEFENSE, STRIP, true),
        band('st2', 'adFastOffense', '快线进攻', OFFENSE, STRIP, true),
        band('bg1', 'adZigDefense', '防守', DEFENSE, CONFIRMED),
        band('bg2', 'adZigOffense', '进攻', OFFENSE, CONFIRMED),
        band('bg3', 'adZigDefensePending', '防守(待定)', DEFENSE, PENDING),
        band('bg4', 'adZigOffensePending', '进攻(待定)', OFFENSE, PENDING),
      ],
      desc: [
        '定义:XLP / QQQ 比值(收盘价,不计分红),1999 起。',
        'XLP = 必需消费(防守),QQQ = 成长(进攻)。上行(绿)= 防守跑赢 = 避险;下行(红)= 进攻跑赢 = risk-on。',
        `背景(慢,事后确认):ZigZag ${SWING_PCT * 100}% 反转阈值识别的上行 / 下行 regime;拐点回贴到极值日,是事后才知道的;末段未确认用淡色。`,
        `底部细色带(快,当日可知):比值高于 ${FAST_MA} 日均线 ${FAST_BAND * 100}% 以上翻绿、低于 ${FAST_BAND * 100}% 以上翻红,带内保持。`,
        '色带与背景同色 = 一致;色带先翻反色 = 预警(实测约 3 成是假警报:翻绿时 QQQ 不在 ≥10% 回撤里)。',
        '盲区:全市场齐跌时比值不动,齐跌看上格两条线。',
        '⚠️ 背景与细带只在日线画;周 / 月线只剩比值和均线。',
      ].join('\n'),
    },
  ],
};
