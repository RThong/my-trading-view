// 报警规则的逐日状态(扫描 / 存档用,ROADMAP L3-1 / L4-1):某天落在规则的哪个区间。
// 和固定面板的背景带用同一条规则(shared/alertRules),但口径不同:
// - 背景带按整段历史算 P5 / P95(看图看大概);这里**只用截到当天的数据**算分位,不看未来 —— 存档、回测都要这样
// - 带滞后带(exitPad)和确认天数(confirmDays),贴着线来回抖不会天天切换
import { type AlertRule, PCTL_HI, PCTL_LO } from '../alertRules';
import { percentileRank } from './stats';

/**
 * 某天的状态:zone = 区间下标(从低到高 0..切点数),value = 当天值,rank = 分位规则的当天分位(0~100)。
 * judged = false:分位窗口还不够长、没判(zone 按常态填);扫描 / 报警要跳过,别当成「确实在常态」
 */
export type RuleDay = { time: string; value: number; zone: number; judged: boolean; rank?: number };

// 分位规则的切点(分位点数,与画图的 P5 / P95 同一份)和默认滞后
const PCTL_CUTS = [PCTL_LO, PCTL_HI];
const PCTL_EXIT_PAD = 5;
// 分位窗口够长才算分位:只有几个、十几个点时排名几乎都在两端,会冒出一串假的越线。
// 按时间跨度 + 点数一起卡(只按点数的话,月频要攒 250 个月才判、等于被悄悄关掉):
// 日线约一年(跨度先到),周线一年,月频 3 年(点数先到)
export const MIN_PCTL_SPAN_DAYS = 365;
export const MIN_PCTL_POINTS = 36;

function longEnough(hist: { time: string }[]): boolean {
  const first = hist[0]?.time;
  const last = hist.at(-1)?.time;
  if (!first || !last || hist.length < MIN_PCTL_POINTS) return false;

  return (Date.parse(last) - Date.parse(first)) / 86_400_000 >= MIN_PCTL_SPAN_DAYS;
}

/** x 落在第几个区间:cuts 升序;恰好压线算上面那段 */
function zoneOf(x: number, cuts: number[]): number {
  return cuts.filter((c) => x >= c).length;
}

/** 规则的切点、滞后、常态区间(分位规则在分位点数空间里切,levels 规则按原值) */
export function ruleGeometry(rule: AlertRule): { cuts: number[]; pad: number; neutral: number } {
  const cuts = rule.percentile ? PCTL_CUTS : (rule.levels ?? []).map((l) => l.price).sort((a, b) => a - b);
  const pad = rule.exitPad ?? (rule.percentile ? PCTL_EXIT_PAD : 0);

  return { cuts, pad, neutral: rule.neutral ?? (cuts.length === 2 ? 1 : 0) };
}

/**
 * 一串位置(分位点数或原值)→ 逐日区间,带滞后与确认:
 * - 离常态更远(进入 / 升级 / 跨到另一端)= 当天就到;
 * - 往常态回 = 要越过切点 pad 才算(在越线那一侧多走 pad);
 * - confirmDays > 1:新区间要连续这么多天才切。
 * 第一天直接按切点定区间(没有更早的状态可依)
 */
export function hysteresisZones(xs: number[], cuts: number[], pad: number, neutral: number, confirmDays = 1): number[] {
  const out: number[] = [];
  let state = 0;
  let pending = { zone: -1, days: 0 };
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const raw = zoneOf(x, cuts);
    let next = raw;
    if (i > 0) {
      const closer = Math.abs(raw - neutral) < Math.abs(state - neutral) && (raw - neutral) * (state - neutral) >= 0;
      // 往常态回:按「多走 pad」后的位置算,最多回到 raw、不会越过当前区间
      if (closer)
        next = state > neutral ? Math.min(state, zoneOf(x + pad, cuts)) : Math.max(state, zoneOf(x - pad, cuts));
    }
    if (i === 0) {
      state = next;
    } else if (next === state) {
      pending = { zone: -1, days: 0 };
    } else {
      pending = pending.zone === next ? { zone: next, days: pending.days + 1 } : { zone: next, days: 1 };
      if (pending.days >= confirmDays) {
        state = next;
        pending = { zone: -1, days: 0 };
      }
    }
    out.push(state);
  }

  return out;
}

/**
 * 规则在最近 days 个点上的逐日状态(points 按日期升序,已是规则输入那条线的值)。
 * 分位规则:每天用「since 起、截到当天」的值算当天分位(扩张窗口,不看未来);
 * 为了让滞后带有前文,多往前算 warmup 个点再截掉
 */
export function ruleDays(
  rule: AlertRule,
  points: { time: string; value: number }[],
  days: number,
  warmup = 60,
): RuleDay[] {
  const since = rule.percentile?.since;
  // 非有限值(NaN)不进窗口:percentileRank 会把它排成最低、误判成低端越线
  const pts = points.filter((p) => Number.isFinite(p.value) && (!since || p.time >= since));
  const start = Math.max(0, pts.length - days - warmup);
  const tail = pts.slice(start);
  const ranks = rule.percentile
    ? tail.map((_, i) => {
        const upToToday = pts.slice(0, start + i + 1);
        return !longEnough(upToToday)
          ? undefined
          : percentileRank(
              upToToday.map((p) => p.value),
              tail[i].value,
            );
      })
    : undefined;
  // 窗口不够长的日子按分位中间(常态)算
  const xs = ranks ? ranks.map((r) => r ?? 50) : tail.map((p) => p.value);
  const { cuts, pad, neutral } = ruleGeometry(rule);
  const zones = hysteresisZones(xs, cuts, pad, neutral, rule.confirmDays);

  return tail
    .map((p, i) => ({
      time: p.time,
      value: p.value,
      zone: zones[i],
      judged: !ranks || ranks[i] !== undefined,
      ...(ranks?.[i] !== undefined && { rank: ranks[i] }),
    }))
    .slice(-days);
}
