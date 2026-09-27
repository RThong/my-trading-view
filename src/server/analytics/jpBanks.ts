// 日本银行业的利率传导:存款贝塔、利差及其分解。输入全是日银统计(见 fetchers/bojStat)与 MOF JGB 曲线。
// 月频序列一律记在**当月 1 日**(数据所属月份),与 FRED 月频同轴。
import { subtractAt, type Point } from './regime';

/** 贝塔的基准月:2024-01,首次加息(2024-03)之前最后一个整月。 */
const BETA_BASE_MONTH = '2024-01-01';
/** 政策利率相对基准月的累计变动低于它就不出点:分母贴近 0 时除出来的是噪声,不是传导率。 */
const BETA_MIN_POLICY_MOVE = 0.25;

/**
 * 日银加息的**决定日**(金融政策决定会合当日),值 = 新的无担保隔夜拆借诱导目标(%)。
 * 手抄静态表:日银没有「政策决定日」的机读序列。逐条对过公表文(mpr_YYYY/kYYMMDDa.pdf)的方针句与生效注脚。
 * ⚠️ **生效日是翌营业日,不是这一天**:拆借日值要到生效日才跳(如 2026-09-18 决定、09-24 生效,中间隔周末 + 两个假日)。
 * 2Y 在决定日当天重定价,所以竖线画决定日。新加一次加息 = 这里加一行。
 */
export const BOJ_HIKES: readonly Point[] = [
  { date: '2024-03-19', value: 0.05 }, // 0〜0.1% 程度(结束负利率),记区间中值;03-21 生效
  { date: '2024-07-31', value: 0.25 }, // 08-01 生效
  { date: '2025-01-24', value: 0.5 }, // 01-27 生效
  { date: '2025-12-19', value: 0.75 }, // 12-22 生效
  { date: '2026-06-16', value: 1.0 }, // 06-17 生效
  { date: '2026-09-18', value: 1.25 }, // 09-24 生效
];

const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

const groupByMonth = (daily: Point[]) =>
  daily.reduce((m, p) => {
    const k = monthOf(p.date);
    (m.get(k) ?? m.set(k, []).get(k)!).push(p.value);
    return m;
  }, new Map<string, number[]>());

/** 日频 → 月均(记当月 1 日)。输入须升序。 */
export function monthlyMean(daily: Point[]): Point[] {
  return [...groupByMonth(daily)].map(([date, vs]) => ({ date, value: vs.reduce((a, b) => a + b, 0) / vs.length }));
}

/**
 * 按日期前向填充的取值器:返回「日期 ≤ d 的最后一个值」。**查询日期必须单调递增**(内部是单指针,
 * 不回退)。月频序列记在当月 1 日,所以它对月频腿就是「当月值,当月未发布则沿用上月」。
 */
const ffill = (rows: Point[]) => {
  let i = -1;

  return (d: string) => {
    while (i + 1 < rows.length && rows[i + 1].date <= d) i++;
    return i < 0 ? undefined : rows[i].value;
  };
};

/**
 * 存款贝塔 = (当月存款利率 − 基准月存款利率) / (当月政策利率 − 基准月政策利率)。
 * 两腿都是月频、同一日期轴;缺任一腿的月份跳过。基准月缺任一腿 → 整条为空(调用方归 unavailable)。
 */
export function depositBeta(deposit: Point[], policy: Point[]): Point[] {
  const pol = new Map(policy.map((p) => [p.date, p.value]));
  const dep0 = deposit.find((p) => p.date === BETA_BASE_MONTH)?.value;
  const pol0 = pol.get(BETA_BASE_MONTH);
  if (dep0 === undefined || pol0 === undefined) return [];

  return deposit.flatMap((p) => {
    const v = pol.get(p.date);
    if (p.date <= BETA_BASE_MONTH || v === undefined || v - pol0 < BETA_MIN_POLICY_MOVE) return [];

    return [{ date: p.date, value: (p.value - dep0) / (v - pol0) }];
  });
}

/**
 * 利差格与其分解。日频三条都锚在 2Y 的日期上,存款(挂牌利率是阶梯量)与拆借按日期前向填充:
 *   2Y − 存款 = (拆借 − 存款) + (2Y − 拆借)   ← 同一天同一组取值,恒等式逐点成立
 * 存款或拆借还没起点的日子不出点(存款 2022-04 才开始)。
 * 存贷利差两腿都是月频,按月 inner join —— 贷款滞后约 2 个月,末端比日频那几条短是正常的。
 */
export function jpBankSpreads(legs: { deposit: Point[]; loanStock: Point[]; jgb2y: Point[]; callDaily: Point[] }) {
  const depAt = ffill(legs.deposit);
  const callAt = ffill(legs.callDaily);
  const days = legs.jgb2y.flatMap((p) => {
    const dep = depAt(p.date);
    const call = callAt(p.date);
    return dep === undefined || call === undefined ? [] : [{ date: p.date, y2: p.value, dep, call }];
  });

  return {
    loanDeposit: subtractAt(legs.loanStock, legs.deposit),
    jgb2yDeposit: days.map((d) => ({ date: d.date, value: d.y2 - d.dep })),
    callDeposit: days.map((d) => ({ date: d.date, value: d.call - d.dep })),
    jgb2yCall: days.map((d) => ({ date: d.date, value: d.y2 - d.call })),
  };
}

/** 贝塔 60% 门槛对应的系数:存款累计变动线上穿 0.6 × 拆借累计变动线 ⇔ 贝塔 > 60%。 */
const BETA_WATCH = 0.6;

/**
 * 贝塔格的两条阶梯线(基准月起累计变动,基准月本身 = 0):Δ存款 与 0.6 × Δ拆借。
 * 不画比值是因为比值在分母小时乱跳;两条变动线同尺并排,「谁在上面」就是贝塔过没过 60%,分母小也不失真。
 * 两腿都是月频,按月 inner join;基准月缺任一腿 → 两条都空。
 */
export function betaLegs(deposit: Point[], callMonthly: Point[]) {
  const call = new Map(callMonthly.map((p) => [p.date, p.value]));
  const dep0 = deposit.find((p) => p.date === BETA_BASE_MONTH)?.value;
  const call0 = call.get(BETA_BASE_MONTH);
  if (dep0 === undefined || call0 === undefined) return { depositDelta: [], callDelta60: [] };

  const months = deposit.flatMap((p) => {
    const c = call.get(p.date);
    return p.date < BETA_BASE_MONTH || c === undefined ? [] : [{ date: p.date, dep: p.value - dep0, call: c - call0 }];
  });

  return {
    depositDelta: months.map((m) => ({ date: m.date, value: m.dep })),
    callDelta60: months.map((m) => ({ date: m.date, value: BETA_WATCH * m.call })),
  };
}
