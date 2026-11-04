// 编辑器的分析计算(纯函数):时间平移、两条线按日期配对、相关性(领先滞后扫描)、叠加选段与换算。
// 输入输出都是 { time: 'YYYY-MM-DD', value }[](升序),与渲染层同一种形状。
import type { LinePoint } from './core';

const DAY_MS = 86_400_000;
// 1970-01-05 是周一:以它为原点数「第几个工作日」
const MONDAY_EPOCH = Date.UTC(1970, 0, 5);

function toDayNum(date: string) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - MONDAY_EPOCH) / DAY_MS);
}
function fromDayNum(n: number) {
  return new Date(MONDAY_EPOCH + n * DAY_MS).toISOString().slice(0, 10);
}

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
export function shiftBusinessDays(date: string, n: number): string {
  return fromDayNum(shiftDay(toDayNum(date), n));
}

/** 整条序列平移 n 个交易日。周末顺延可能让两点撞到同一天,保留后一个(lw-charts 不许时间重复)。 */
export function shiftPoints(points: LinePoint[], n: number): LinePoint[] {
  if (n === 0) return points;

  const byDay = new Map(points.map((p) => [shiftDay(toDayNum(p.time), n), p.value]));
  return [...byDay].map(([day, value]) => ({ time: fromDayNum(day), value }));
}

export type Pair = { time: string; a: number; b: number };

// 内部批量计算用日序号,避免扫描时每步重复解析日期字符串
type DayPoint = { day: number; value: number };
function toDays(points: LinePoint[]): DayPoint[] {
  return points.map((p) => ({ day: toDayNum(p.time), value: p.value }));
}

function medianGapDays(points: DayPoint[]): number {
  const gaps = points
    .slice(1)
    .map((p, i) => p.day - points[i].day)
    .sort((x, y) => x - y);
  return gaps.length ? gaps[gaps.length >> 1] : 1;
}

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
 * 最近值太旧就跳过这一天,免得拿几个月前的值硬配。容忍度取「7 天」与「它自身中位间隔的 1.6 倍」中**较大**的:
 * 日频按 7 天算(跨周末、两地假日错开都配得上),月频按约 7 周算(季末配上一个月初的值)。
 * 取较小的话,季频 ÷ 月频会因为季末离月初 30 天而一个点都配不上。
 */
export function alignPairs(a: LinePoint[], b: LinePoint[]): Pair[] {
  return alignDays(toDays(a), toDays(b)).map((p) => ({ time: fromDayNum(p.day), a: p.a, b: p.b }));
}

/**
 * 配对点换成各自 horizon 期的变化(按变化算相关:直接拿数值算,两条都有长期趋势时会虚高)。
 * 全为正的序列取对数收益(≈ 涨跌幅),可能为负的(利率、利差)取差值。
 */
export function transformPairs(pairs: Pair[], horizon: number): Pair[] {
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

export type LagPoint = { lag: number; r: number; n: number };

/**
 * 领先滞后扫描:把 b 逐个平移 lags 里的交易日数,每一步算一次 a 与平移后 b 的相关性。
 * lag > 0 = b 往后挪 = 「b 领先 a lag 天」。range 给了就只用 a 的这段日期(看图上当前可视区间)。
 */
export function lagScan(
  a: LinePoint[],
  b: LinePoint[],
  opts: { lags: number[]; horizon: number; range?: { from: string; to: string } },
): LagPoint[] {
  const { lags, horizon, range } = opts;
  const [lo, hi] = range ? [toDayNum(range.from), toDayNum(range.to)] : [-Infinity, Infinity];
  // a、b 先截到区间附近:每一步都要整段重配,截短后每步只走区间内的点。
  // b 两头各多留「最大平移的自然日 + 60 天」:平移后要落进区间,配对还会往前取最近值(月频最多隔一个多月)
  const reach = Math.ceil((Math.max(0, ...lags.map(Math.abs)) * 7) / 5) + 60;
  const aDays = toDays(a).filter((p) => p.day >= lo && p.day <= hi);
  const bDays = toDays(b).filter((p) => p.day >= lo - reach && p.day <= hi + reach);

  return lags.map((lag) => {
    const shifted = bDays.map((p) => ({ day: shiftDay(p.day, lag), value: p.value }));
    const aligned = alignDays(aDays, shifted)
      .filter((p) => p.day >= lo && p.day <= hi)
      .map((p) => ({ time: '', a: p.a, b: p.b }));
    const pairs = transformPairs(aligned, horizon);
    return { lag, r: pearson(pairs), n: pairs.length };
  });
}

/** 扫描结果里相关性绝对值最大的那一步(正负都算「像」)。全是 NaN → undefined。 */
export function strongestLag(scan: LagPoint[]): LagPoint | undefined {
  return scan
    .filter((p) => Number.isFinite(p.r))
    .reduce<LagPoint | undefined>((best, p) => (!best || Math.abs(p.r) > Math.abs(best.r) ? p : best), undefined);
}

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

/**
 * 「叠加对比」认定一段「两者有稳定关系」的门槛。数值是拿公认有关 / 无关的组合加随机走势对照回测定的
 * (calibrateOverlay.ts:随机 200 对只测选段,全时段误报 0、视口 1 年 1.5%、2 年 5.5%),改之前先跑那个脚本。
 * 按钮还会先找偏移(上百次比较里挑最像的),整个流程的误报更高:随机 100 对,视口 1 年约 16%、2 年约 32%。
 * 负责人的取舍(2026-11):不为短视口收紧门槛 —— 只看一两年就该自己掂量结果,不是工具替人把关。
 */
export const OVERLAY_RULES = {
  /** 基准段至少占视口的比例:太短的一段代表不了正在看的这段时间 */
  minFrac: 1 / 3,
  /** 涨跌相关门槛 = max(floor, k / √月数):段越短要求越强(约 95% 显著,月度涨跌近似独立样本) */
  k: 2,
  floor: 0.3,
  /** 一直成立:段切 4 份,至少 partsMin 份与整段同号且 |r| ≥ partR,挡「平均下来像、其实只有几个月像」 */
  partsMin: 3,
  partR: 0.2,
  /** 整体走势也对得上:按水平的相关至少这么强,且与涨跌相关同号(反号 = 段里关系漂移过,叠出来比例是错的) */
  levelMin: 0.5,
  /** 选段:先看吻合度(按水平 |r|)最高能到多少,再在不比它差 tol 的段里挑最长的。直接挑最长会一路伸进失效段、压线才停 */
  tol: 0.05,
} as const;

const DAYS_PER_MONTH = 21;
// 变化率口径取约一个月(20 个交易日)的变化:日间涨跌噪声太大,偏移会被噪声淹没
const CHANGE_SPAN = 20;
// 候选段的起止按这么多个格子走(与数据长短无关):格子越细越准、越慢,240 格约 2 万个候选段,点一下即算完
const GRID = 240;

export type SegmentFail = 'weak' | 'unstable' | 'level';

export type Segment = {
  from: string;
  to: string;
  months: number;
  /** 这段长度对应的涨跌相关门槛 */
  need: number;
  /** 涨跌相关(约一个月的变化) */
  rc: number;
  /** 4 份里过了几份 */
  parts: number;
  /** 按水平的相关 */
  rl: number;
  fails: SegmentFail[];
};

/** lo 到 hi(含)每隔 st 一个整数。 */
function seq(lo: number, hi: number, st: number) {
  return Array.from({ length: Math.max(0, Math.floor((hi - lo) / st) + 1) }, (_, k) => lo + k * st);
}

/** 「约一个月的变化」换成配对点数:按配对点的中位间隔折算,周 / 月频序列照样能算。 */
function changeHorizon(pairs: Pair[]) {
  // 间隔按交易日量(CHANGE_SPAN 是交易日):日频 1、周频 5、月频约 21
  const gaps = pairs
    .slice(1)
    .map((p, i) => bizDaysBetween(pairs[i].time, p.time))
    .sort((x, y) => x - y);
  const gap = Math.max(1, gaps[gaps.length >> 1] ?? 1);
  return Math.max(1, Math.round(CHANGE_SPAN / gap));
}

/** 两个日期之间隔了几个交易日(周末算到下周一,同 shiftDay)。 */
function bizDaysBetween(from: string, to: string) {
  const idx = (date: string) => {
    const day = toDayNum(date);
    const week = Math.floor(day / 7);
    return week * 5 + Math.min(day - week * 7, 5);
  };
  return idx(to) - idx(from);
}

/** 前缀和:之后任意 [i, j) 段的皮尔逊相关 O(1)(候选段上万个,逐段重算太慢)。 */
function corrPrefix(pairs: Pair[]): (i: number, j: number) => number {
  const sums = [
    (p: Pair) => p.a,
    (p: Pair) => p.b,
    (p: Pair) => p.a * p.a,
    (p: Pair) => p.b * p.b,
    (p: Pair) => p.a * p.b,
  ];
  // 累加依赖上一格,命令式更直白
  const acc = sums.map((f) => {
    const c = new Float64Array(pairs.length + 1);
    pairs.forEach((p, i) => {
      c[i + 1] = c[i] + f(p);
    });
    return c;
  });

  return (i, j) => {
    const n = j - i;
    const [sa, sb, saa, sbb, sab] = acc.map((c) => c[j] - c[i]);
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    return n < 3 || va <= 0 || vb <= 0 ? Number.NaN : (sab - (sa * sb) / n) / Math.sqrt(va * vb);
  };
}

/**
 * 在视口 range(a 的日期)里找基准段:满足 OVERLAY_RULES 全部条件的段里,吻合度接近最高的最长那段。
 * whole = 整个视口本身的判定(都不达标时用它说明是哪条没过)。配对点太少 → whole 也为 null。
 */
export function findBaseSegment(
  a: LinePoint[],
  b: LinePoint[],
  range: { from: string; to: string },
): { best: Segment | null; whole: Segment | null } {
  const R = OVERLAY_RULES;
  // 配对后再按视口截一次:b 比 a 稀疏时配对以 b 的日期为准,视口右端之后几天的 b 点会配上 a 的最后一个值
  const lev = alignPairs(
    a.filter((p) => p.time >= range.from && p.time <= range.to),
    b,
  ).filter((p) => p.time >= range.from && p.time <= range.to);
  const horizon = changeHorizon(lev);
  const chg = transformPairs(lev, horizon);
  if (chg.length < 12) return { best: null, whole: null };

  const corrL = corrPrefix(lev);
  const corrC = corrPrefix(chg);
  // chg[k] 对应 lev[k + horizon]:段 [i, j) 在 chg 里是 [i − horizon, j − horizon)
  const judge = (i: number, j: number): Segment => {
    const [ci, cj] = [i - horizon, j - horizon];
    const months = Math.max(1, bizDaysBetween(lev[i].time, lev[j - 1].time) / DAYS_PER_MONTH);
    const need = Math.max(R.floor, R.k / Math.sqrt(months));
    const rc = corrC(ci, cj);
    const rl = corrL(i, j);
    const q = (cj - ci) / 4;
    const parts = [0, 1, 2, 3]
      .map((k) => corrC(Math.round(ci + k * q), Math.round(ci + (k + 1) * q)))
      .filter((r) => Math.sign(r) === Math.sign(rc) && Math.abs(r) >= R.partR).length;
    const fails = [
      !(Math.abs(rc) >= need) && ('weak' as const),
      parts < R.partsMin && ('unstable' as const),
      !(Math.abs(rl) >= R.levelMin && Math.sign(rl) === Math.sign(rc)) && ('level' as const),
    ].filter((f) => f !== false);
    return { from: lev[i].time, to: lev[j - 1].time, months, need, rc, parts, rl, fails };
  };

  const whole = judge(horizon, lev.length);
  // 段长按日期跨度比(不按点数:数据有缺口时点数会高估跨度);分母是视口里有数据的那段日期
  const minSpan = bizDaysBetween(lev[0].time, lev[lev.length - 1].time) * R.minFrac;
  const longEnough = ([i, j]: [number, number]) =>
    j - i >= 12 && bizDaysBetween(lev[i].time, lev[j - 1].time) >= minSpan;
  type Cand = { i: number; j: number; sg: Segment };
  const passing = (spans: [number, number][]): Cand[] =>
    spans
      .filter(longEnough)
      .map(([i, j]) => ({ i, j, sg: judge(i, j) }))
      .filter((c) => c.sg.fails.length === 0);
  // 先看吻合度最高能到多少,再在不比它差 tol 的段里挑最长的
  const pick = (cands: Cand[]): Cand | undefined => {
    const top = cands.reduce((m, c) => Math.max(m, Math.abs(c.sg.rl)), 0);
    return cands
      .filter((c) => Math.abs(c.sg.rl) >= top - R.tol)
      .map((c) => ({ c, len: bizDaysBetween(c.sg.from, c.sg.to) }))
      .sort((x, y) => y.len - x.len || Math.abs(y.c.sg.rl) - Math.abs(x.c.sg.rl))[0]?.c;
  };
  // ponytail: 起止点先按格子粗找,再在选中段两头各一格内逐点细调;格子之间的其它段不保证遍历到(逐点全找是 O(n²) 上千万次)
  const step = Math.max(1, Math.round(lev.length / GRID));
  const ends = [...new Set([...seq(horizon, lev.length, step), lev.length])];
  const coarse = passing(ends.flatMap((i) => ends.filter((j) => j > i).map((j): [number, number] => [i, j])));
  const first = pick(coarse);
  if (!first) return { best: null, whole };

  const near = (x: number, lo: number, hi: number) => seq(Math.max(lo, x - step), Math.min(hi, x + step), 1);
  const fine = passing(
    near(first.i, horizon, lev.length - 1).flatMap((i) =>
      near(first.j, i + 1, lev.length).map((j): [number, number] => [i, j]),
    ),
  );
  const best = pick([...coarse, ...fine])?.sg ?? null;

  return { best, whole };
}

// 找偏移的范围上限(交易日,约 3 年):每一步都要整段重新配对,范围太大点一下会卡住页面
const MAX_LAG = 750;
// 偏移带来的相关性提升不到这个数就不挪:多数组合是同时动的,硬挪几天只是在追噪声
const MIN_LAG_GAIN = 0.05;

export type Overlay = {
  /** 基准段(a 的日期) */
  seg: Segment;
  /** b 要平移的交易日(相对 a),> 0 = b 领先 a */
  lag: number;
  fit: FitParams;
};

export type OverlayResult =
  | { kind: 'ok'; overlay: Overlay }
  /** 视口里没有达标的段;whole 是整个视口(B 按找到的偏移平移后)的判定,null = 配对点太少 */
  | { kind: 'none'; whole: Segment | null };

/**
 * 叠加对比(把 b 叠到 a 上),三步:① 在视口里找 b 的最佳偏移 ② 按平移后的 b 找基准段(见 findBaseSegment)③ 在基准段里求比例。
 * 先找偏移:有领先关系的一对不平移时涨跌相关很弱,先选段会在这一步就被刷掉。
 * 偏移按变化率找(按水平,两条有趋势的线怎么挪都像),范围限在视口长度的 1/4 内;比例按水平求(要叠的是线本身)。
 */
export function bestOverlay(a: LinePoint[], b: LinePoint[], view: { from: string; to: string }): OverlayResult {
  const maxLag = Math.min(MAX_LAG, Math.floor(bizDaysBetween(view.from, view.to) / 4));
  // 变化期按配对后的点间隔算(和选段同一口径):B 是周 / 月频时配对点跟着 B 变稀,按 A 的日频算会变成 20 周 / 20 个月
  const aInView = a.filter((p) => p.time >= view.from && p.time <= view.to);
  const horizon = changeHorizon(alignPairs(aInView, b));
  // 先隔几天粗扫、再在最强点前后逐天细扫:相关性随平移天数变化是平滑的(一个月的涨跌重叠很多),
  // 逐天扫上千步点一下要卡一两秒
  const step = Math.max(1, Math.round(maxLag / 60));
  const coarse = lagScan(a, b, { lags: [...new Set([0, ...seq(-maxLag, maxLag, step)])], horizon, range: view });
  const peak = strongestLag(coarse)?.lag ?? 0;
  const fineLags = seq(Math.max(-maxLag, peak - step), Math.min(maxLag, peak + step), 1);
  const scan = [...coarse, ...lagScan(a, b, { lags: fineLags, horizon, range: view })];
  const r0 = scan.find((p) => p.lag === 0)?.r ?? Number.NaN;
  const top = strongestLag(scan);
  const lag = !top || !Number.isFinite(r0) || Math.abs(top.r) - Math.abs(r0) < MIN_LAG_GAIN ? 0 : top.lag;

  const shifted = shiftPoints(b, lag);
  const { best: seg, whole } = findBaseSegment(a, shifted, view);
  // 比例用和选段同一套配对点(视口内的 a 配 b):换成全历史的 a,b 是周 / 月频时配对频率会变,点数对不上
  const fit = seg && fitParams(aInView, shifted, seg.from, seg.to);

  return seg && fit ? { kind: 'ok', overlay: { seg, lag, fit } } : { kind: 'none', whole };
}
