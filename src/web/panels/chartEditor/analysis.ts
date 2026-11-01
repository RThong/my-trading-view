// 编辑器的分析计算(纯函数):时间平移、两条线按日期配对、相关性(滚动 / 领先滞后扫描)、参照期换算。
// 输入输出都是 { time: 'YYYY-MM-DD', value }[](升序),与渲染层同一种形状。
import type { LinePoint } from '../../lib/chart';

const DAY_MS = 86_400_000;
// 1970-01-05 是周一:以它为原点数「第几个工作日」
const MONDAY_EPOCH = Date.UTC(1970, 0, 5);

const toDayNum = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - MONDAY_EPOCH) / DAY_MS);
const fromDayNum = (n: number) => new Date(MONDAY_EPOCH + n * DAY_MS).toISOString().slice(0, 10);

/** 按交易日平移(日序号版,内部批量用)。周六 / 周日先当下周一,再挪 n 个工作日。 */
function shiftDay(day: number, n: number): number {
  const week = Math.floor(day / 7);
  const wd = Math.min(day - week * 7, 5); // 周六 5、周日 6 → 都当 5 = 下周一
  const idx = week * 5 + wd + n;
  const newWeek = Math.floor(idx / 5);

  return newWeek * 7 + (idx - newWeek * 5);
}

/**
 * 按交易日(周一~周五,不管节假日)平移 n 天,n > 0 往后。周末日期先顺延到周一再平移 ——
 * 按自然日平移会落到周末,时间轴上凭空多出周末空位(见 tenorHistory 的 weekdayOnly 说明)。
 */
export const shiftBusinessDays = (date: string, n: number): string => fromDayNum(shiftDay(toDayNum(date), n));

/** 整条序列平移 n 个交易日。周末顺延可能让两点撞到同一天,保留后一个(lw-charts 不许时间重复)。 */
export function shiftPoints(points: LinePoint[], n: number): LinePoint[] {
  if (n === 0) return points;

  const byDay = new Map(points.map((p) => [shiftDay(toDayNum(p.time), n), p.value]));
  return [...byDay].map(([day, value]) => ({ time: fromDayNum(day), value }));
}

export type Pair = { time: string; a: number; b: number };

// 内部批量计算用日序号,避免扫描时每步重复解析日期字符串
type DayPoint = { day: number; value: number };
const toDays = (points: LinePoint[]): DayPoint[] => points.map((p) => ({ day: toDayNum(p.time), value: p.value }));

const medianGapDays = (points: DayPoint[]): number => {
  const gaps = points
    .slice(1)
    .map((p, i) => p.day - points[i].day)
    .sort((x, y) => x - y);
  return gaps.length ? gaps[gaps.length >> 1] : 1;
};

type DayPair = { day: number; a: number; b: number };

function alignDays(a: DayPoint[], b: DayPoint[]): DayPair[] {
  if (a.length === 0 || b.length === 0) return [];

  const baseIsA = a.length <= b.length;
  const [base, other] = baseIsA ? [a, b] : [b, a];
  const maxStale = Math.max(7, medianGapDays(other) * 1.6);

  // 两条都升序,用一个游标往前走;每步依赖上一步的位置,命令式更直白
  const pairs: DayPair[] = [];
  let j = -1;
  for (const p of base) {
    while (j + 1 < other.length && other[j + 1].day <= p.day) j++;
    if (j < 0 || p.day - other[j].day > maxStale) continue;
    const o = other[j].value;
    pairs.push(baseIsA ? { day: p.day, a: p.value, b: o } : { day: p.day, a: o, b: p.value });
  }

  return pairs;
}

/**
 * 两条线按日期配对。以点少(频率低)的那条为基准日期,另一条取「当天或之前最近的值」;
 * 最近值太旧(超过 7 天,或超过它自身中位间隔的 1.6 倍)就跳过这一天,免得拿几个月前的值硬配。
 */
export const alignPairs = (a: LinePoint[], b: LinePoint[]): Pair[] =>
  alignDays(toDays(a), toDays(b)).map((p) => ({ time: fromDayNum(p.day), a: p.a, b: p.b }));

export type CorrMode = 'level' | 'change';

/**
 * 相关性的口径。level = 直接拿数值算(两条都有长期趋势时会虚高);
 * change = 各自 horizon 期的变化:全为正的序列取对数收益(≈ 涨跌幅),可能为负的(利率、利差)取差值。
 */
export function transformPairs(pairs: Pair[], mode: CorrMode, horizon: number): Pair[] {
  if (mode === 'level') return pairs;

  const allPos = (k: 'a' | 'b') => pairs.every((p) => p[k] > 0);
  const posA = allPos('a');
  const posB = allPos('b');
  const delta = (pos: boolean, cur: number, prev: number) => (pos ? Math.log(cur / prev) : cur - prev);

  return pairs.slice(horizon).map((p, i) => ({
    time: p.time,
    a: delta(posA, p.a, pairs[i].a),
    b: delta(posB, p.b, pairs[i].b),
  }));
}

/** 皮尔逊相关系数。样本不足 3 个或某一边没有波动 → NaN。 */
export function pearson(pairs: Pair[]): number {
  const n = pairs.length;
  if (n < 3) return Number.NaN;

  const ma = pairs.reduce((s, p) => s + p.a, 0) / n;
  const mb = pairs.reduce((s, p) => s + p.b, 0) / n;
  const { sab, saa, sbb } = pairs.reduce(
    (acc, p) => ({
      sab: acc.sab + (p.a - ma) * (p.b - mb),
      saa: acc.saa + (p.a - ma) ** 2,
      sbb: acc.sbb + (p.b - mb) ** 2,
    }),
    { sab: 0, saa: 0, sbb: 0 },
  );

  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : Number.NaN;
}

/** 滚动相关性:每个日期上取最近 window 个配对点算一次。点数 = 配对点数 − window + 1。 */
export function rollingCorr(
  a: LinePoint[],
  b: LinePoint[],
  window: number,
  mode: CorrMode,
  horizon: number,
): LinePoint[] {
  const pairs = transformPairs(alignPairs(a, b), mode, horizon);

  return pairs
    .slice(window - 1)
    .map((p, i) => ({ time: p.time, value: pearson(pairs.slice(i, i + window)) }))
    .filter((p) => Number.isFinite(p.value));
}

export type LagPoint = { lag: number; r: number; n: number };

/**
 * 领先滞后扫描:把 b 从 minLag 平移到 maxLag 个交易日,每一步算一次 a 与平移后 b 的相关性。
 * lag > 0 = b 往后挪 = 「b 领先 a lag 天」。range 给了就只用 a 的这段日期(看图上当前可视区间)。
 */
export function lagScan(
  a: LinePoint[],
  b: LinePoint[],
  opts: { minLag: number; maxLag: number; mode: CorrMode; horizon: number; range?: { from: string; to: string } },
): LagPoint[] {
  const { minLag, maxLag, mode, horizon, range } = opts;
  const aDays = toDays(a);
  const bDays = toDays(b);
  const [lo, hi] = range ? [toDayNum(range.from), toDayNum(range.to)] : [-Infinity, Infinity];

  return Array.from({ length: Math.max(0, maxLag - minLag + 1) }, (_, i) => minLag + i).map((lag) => {
    const shifted = bDays.map((p) => ({ day: shiftDay(p.day, lag), value: p.value }));
    const aligned = alignDays(aDays, shifted)
      .filter((p) => p.day >= lo && p.day <= hi)
      .map((p) => ({ time: '', a: p.a, b: p.b }));
    const pairs = transformPairs(aligned, mode, horizon);
    return { lag, r: pearson(pairs), n: pairs.length };
  });
}

/** 扫描结果里相关性绝对值最大的那一步(正负都算「像」)。全是 NaN → undefined。 */
export const strongestLag = (scan: LagPoint[]): LagPoint | undefined =>
  scan
    .filter((p) => Number.isFinite(p.r))
    .reduce<LagPoint | undefined>((best, p) => (!best || Math.abs(p.r) > Math.abs(best.r) ? p : best), undefined);

export type FitParams = { alpha: number; beta: number; r: number; n: number };

/**
 * 参照期换算:在 [start, end] 里用最小二乘求 a ≈ alpha + beta × b,把 b 换算成 a 的单位。
 * beta < 0 = 两者反向,换算后自动「倒过来」。配对点少于 10 个 → null(样本太少,比例不可信)。
 */
export function fitParams(a: LinePoint[], b: LinePoint[], start: string, end: string): FitParams | null {
  const pairs = alignPairs(a, b).filter((p) => p.time >= start && p.time <= end);
  const n = pairs.length;
  if (n < 10) return null;

  const ma = pairs.reduce((s, p) => s + p.a, 0) / n;
  const mb = pairs.reduce((s, p) => s + p.b, 0) / n;
  const sab = pairs.reduce((s, p) => s + (p.a - ma) * (p.b - mb), 0);
  const sbb = pairs.reduce((s, p) => s + (p.b - mb) ** 2, 0);
  if (sbb === 0) return null;

  const beta = sab / sbb;
  return { alpha: ma - beta * mb, beta, r: pearson(pairs), n };
}

export const applyFit = (points: LinePoint[], { alpha, beta }: FitParams): LinePoint[] =>
  points.map((p) => ({ time: p.time, value: alpha + beta * p.value }));

/** 劈叉幅度:a − 换算后的 b(a 的单位)。参照期里应在 0 附近,离开 0 的那段就是劈叉。 */
export const gapPoints = (a: LinePoint[], fittedB: LinePoint[]): LinePoint[] =>
  alignPairs(a, fittedB).map((p) => ({ time: p.time, value: p.a - p.b }));
