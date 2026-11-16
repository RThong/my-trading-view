// 序列新鲜度(ROADMAP L0-1,「数据健康」页用;以后 L4 变化扫描把「断更」当变化报也用它)。
// 主判据看日期:按序列的发布频率,最新一点离今天多久算偏晚 / 过期 —— 源停了日期就停了,这条确定、可靠。
// 辅助判据只给日频:末尾连续 N 个点数值完全相同 = 疑似「源停了、被前值填平」。
// 不用参考站「当前不变段 > 历史最长不变段 × 1.5」:政策利率这类几年不动的阶梯序列上不是漏报就是误报,
// 1.5 也没有误报率依据(负责人 2026-11-16 同意改用这套)。阶梯序列由调用方传 flatOk 跳过。
import type { SeriesFreq } from '../seriesMeta';

export type Health = 'ok' | 'late' | 'stale' | 'flat' | 'empty' | 'unknown';

/** 落后多少算偏晚 / 过期。日频按工作日数,其余按日历天数 */
export type LagRule = { late: number; stale: number };

/**
 * 各频率的默认门槛(先按发布惯例给宽一点,回家用全量库看误报再调):
 * - 日:最新点之后、今天之前隔了几个工作日(周五的点周一看 = 0;源 T+1 发 = 1)
 * - 周:周报一般次周发,滞后约一周
 * - 月:日期记在数据所属月的 1 日;下一期(下个月)最慢约「月末后 6 周」发(内閣府 CI 约两个月后上旬)
 *   → 最新点从 1 日起算约 100 天还没下一点才算偏晚(按「次月中旬发」给 75 天,CI 这类会天天误报)
 * - 季 / 半年 / 年:同理按期初起算,再加发布滞后(季频 GDP 季末后约 1 个月,HLW r* 等更慢)
 */
export const DEFAULT_LAG: Record<Exclude<SeriesFreq, '不定'>, LagRule> = {
  日: { late: 2, stale: 5 },
  周: { late: 14, stale: 24 },
  月: { late: 105, stale: 140 },
  季: { late: 220, stale: 280 },
  半年: { late: 300, stale: 380 },
  年: { late: 480, stale: 560 },
};

/** 日频末尾连续多少个点完全相同算疑似填平(真实行情的收益率 / 价格 / 波动率连 5 天一模一样几乎不可能) */
export const FLAT_POINTS = 5;

const DAY_MS = 86_400_000;

function utc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** from 与 to 之间(两端都不含)有几个工作日(周一~周五,不认节假日) */
export function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let t = utc(from) + DAY_MS; t < utc(to); t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

/** 末尾连续相同值的个数(空数组 0) */
export function trailingFlat(values: number[]): number {
  if (!values.length) return 0;
  const last = values[values.length - 1];
  let n = 0;
  for (let i = values.length - 1; i >= 0 && values[i] === last; i -= 1) n += 1;

  return n;
}

export type HealthResult = { status: Health; latest?: string; lag?: number };

/**
 * 一条序列的健康状态。points 按日期升序;today 是本地今天(YYYY-MM-DD)。
 * 先看日期(过期 > 偏晚),日期正常才看数值填平;「不定」频率只报最新日期、不判。
 */
export function seriesHealth(
  points: { time: string; value: number }[],
  freq: SeriesFreq,
  today: string,
  opts: { rule?: LagRule; flatOk?: boolean } = {},
): HealthResult {
  const latest = points.at(-1)?.time;
  if (!latest) return { status: 'empty' };
  // 日期在未来的(按预测年份记的点阵图、预定日期之类)落后是负数、会一直「正常」,停了也看不出来:不判
  if (freq === '不定' || latest > today) return { status: 'unknown', latest };

  const lag = freq === '日' ? weekdaysBetween(latest, today) : Math.round((utc(today) - utc(latest)) / DAY_MS);
  const rule = opts.rule ?? DEFAULT_LAG[freq];
  if (lag >= rule.stale) return { status: 'stale', latest, lag };
  if (lag >= rule.late) return { status: 'late', latest, lag };
  const flat = freq === '日' && !opts.flatOk && trailingFlat(points.map((p) => p.value)) >= FLAT_POINTS;

  return { status: flat ? 'flat' : 'ok', latest, lag };
}
