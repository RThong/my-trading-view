// 攻防指标(纯函数,服务端 /api/regime 用它出序列,「特色指标 › 攻防」那张 ChartDoc 画):
// XLP / QQQ 比值 + 慢线(ZigZag 摆动 regime,事后确认)+ 快线(比值相对均线的滞回,当日可知)。
import { type Regime, zigzagRegimes } from './zigzag';

type Point = { date: string; value: number };

// 参数按 XLP / QQQ 实测选定(2026-11-25,收盘价):以 QQQ ≥10% 回撤(QQQ 自身 10% ZigZag 的下行腿,1999 起 56 次、2018 起 17 次)为靶,
// 量「接住几次 / 滞后 / 假警报(翻防守时不在任何一次回撤里)」。
// 慢线 10%:2018 起接住 13/17、实时翻防守 12/12 都在回撤期内(全段 39/45);8% 多接 2 次,但实时翻防守有 5 次落在回撤外;12% 以上接得更少。
export const SWING_PCT = 0.1; // ZigZag 反转阈值:比值反向摆动 ≥10% 才确认一次攻防切换
// 快线:20 日均线 ±3% 滞回。全段接住 52/56、滞后中位 6 日、假警报 1.0 次/年(占翻防守的 33%);2018 起 16/17、8 日、0.7 次/年(24%)。
// 原 NOBL 用的 35 日 ±2% 套到 XLP 上:全段 49/56、8 日、1.3 次/年(40%),两段都不如。XLP / QQQ 摆幅比 NOBL / QQQ 大,带要放宽。
// 波动率带(均线 ±kσ)是在 NOBL 上试的 18 组,同等假警报下都慢 4 天左右,不如固定百分比(没在 XLP 上重测)。
export const FAST_MA = 20;
export const FAST_BAND = 0.03;

/** XLP/QQQ 按日期内联相除。qqq 缺该日或为 0 → 跳过;任一序列空 → [] */
export function ratioSeries(def: Point[], qqq: Point[]): Point[] {
  const q = new Map(qqq.map((p) => [p.date, p.value]));

  return def.flatMap((p) => {
    const qc = q.get(p.date);
    return qc ? [{ date: p.date, value: p.value / qc }] : [];
  });
}

/**
 * 快线:比值相对 N 日均线的滞回判断,只用当日及以前的数据(不像 ZigZag 会回改历史)。
 * 比值 > 均线×(1+band) → defense;< 均线×(1−band) → offense;带内沿用前一状态。
 * 前 N−1 日没有均线 → ma=null、neutral。
 */
export function fastRegime(
  ratio: Point[],
  n = FAST_MA,
  band = FAST_BAND,
): { date: string; ma: number | null; regime: Regime }[] {
  let sum = 0;
  let cur: Regime = 'neutral';
  return ratio.map((p, i) => {
    sum += p.value - (i >= n ? ratio[i - n].value : 0);
    const ma = i >= n - 1 ? sum / n : null;
    if (ma !== null && p.value > ma * (1 + band)) cur = 'defense';
    else if (ma !== null && p.value < ma * (1 - band)) cur = 'offense';
    return { date: p.date, ma, regime: cur };
  });
}

/**
 * 攻防的全部对外序列。背景色带按「这一天是不是这一类」出 0 / 1 标记(ChartDoc 的 background 一层一种颜色):
 * 慢线分防守 / 进攻 × 已确认 / 末段待定四条,快线分防守 / 进攻两条
 */
export function attackDefenseSeries(def: Point[], qqq: Point[]) {
  const ratio = ratioSeries(def, qqq);
  const zones = zigzagRegimes(ratio, SWING_PCT);
  const fast = fastRegime(ratio);
  const zone = (regime: Regime, pending: boolean) =>
    zones.map((z) => ({ date: z.date, value: z.regime === regime && z.pending === pending ? 1 : 0 }));
  const fastFlag = (regime: Regime) => fast.map((f) => ({ date: f.date, value: f.regime === regime ? 1 : 0 }));

  return {
    ratio,
    ma: fast.flatMap((f) => (f.ma === null ? [] : [{ date: f.date, value: f.ma }])),
    zigDefense: zone('defense', false),
    zigOffense: zone('offense', false),
    zigDefensePending: zone('defense', true),
    zigOffensePending: zone('offense', true),
    fastDefense: fastFlag('defense'),
    fastOffense: fastFlag('offense'),
  };
}
