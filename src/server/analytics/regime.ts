/**
 * regime 派生序列:多条原始序列「前向填充对齐」后的线性组合。纯函数,输入按日期升序。
 *
 * 为什么要前向填充:FRED 里 WALCL 是周频(周三)、IORB 阶梯变动,直接和日频序列相减会大量缺口。
 * 对齐口径:在所有序列日期的并集上,各序列用「最近一次已知值」前向填充;输出仅从
 * 「每条序列都已至少有一个观测」的最早日起(否则线性组合缺分量)。
 *
 * 用法(首项减其余):净流动性 = subtractAligned([WALCL, WTREGEN, RRP]);回购利差 = subtractAligned([IORB, SOFR])。
 */
export type Point = { date: string; value: number };

/** 逐日相除 num/den(按日期 inner join,缺日或 den=0 跳过)。用于 RXM/SPX 这类同频比值。 */
export function divideAligned(num: Point[], den: Point[]): Point[] {
  const dMap = new Map(den.map((p) => [p.date, p.value]));
  return num.flatMap((p) => {
    const d = dMap.get(p.date);
    return d ? [{ date: p.date, value: p.value / d }] : [];
  });
}

/**
 * 逐日相减 a−b(按日期 inner join,任一腿缺日则该日跳过)。
 *
 * ⚠️ **同期恒等式型的相减用这个,不要用 subtractAligned。** 后者前向填充,会把「一腿有、
 * 另一腿缺」的日子配成「昨天的 a − 今天的 b」—— 对净流动性那种「各腿各自频率、要的是当下水位」
 * 的组合是对的,对「同一模型切出来的两块,相加必须等于第三块」这种就是错的。
 *
 * Kim-Wright 那两条(THREEFY10 / THREEFYTP10)**目前日历一致**(2018 起各 2170 个观测,
 * 94 个缺日完全相同),所以此处两种写法当前输出相同。仍用 inner join:正确性不该依赖
 * 「两条独立发布的序列碰巧同步」这个巧合。
 */
export function subtractAt(a: Point[], b: Point[]): Point[] {
  const bMap = new Map(b.map((p) => [p.date, p.value]));

  return a.flatMap((p) => {
    const v = bMap.get(p.date);
    return v === undefined ? [] : [{ date: p.date, value: p.value - v }];
  });
}

/** 逐点乘常数 k:单位/量纲对齐用(如 RRP 十亿→百万 ×1000、柴油 $/gal→$/bbl ×42)。 */
export function scale(rows: Point[], k: number): Point[] {
  return rows.map((p) => ({ date: p.date, value: p.value * k }));
}

/**
 * 月频指数的 N 个月年化变动 %:((今 / N 个月前)^(12/N) − 1)×100。N=12 即同比,N=3 即 3 个月年化。
 *
 * ⚠️ 对照月**必须精确命中**,缺了就跳过 —— 不像 yoyPct 那样往前贴。月频序列会有真缺月
 * (2025-10 的 CPI 因停摆从未发布),往前贴就会把 4 个月的涨幅当成 3 个月年化。
 */
export function monthlyAnnualizedPct(rows: Point[], months: number): Point[] {
  const byMonth = new Map(rows.map((p) => [p.date.slice(0, 7), p.value]));
  const monthsBack = (d: string) => {
    const t = new Date(`${d.slice(0, 7)}-01T00:00:00Z`);
    t.setUTCMonth(t.getUTCMonth() - months);
    return t.toISOString().slice(0, 7);
  };

  return rows.flatMap((p) => {
    const prev = byMonth.get(monthsBack(p.date));
    return prev ? [{ date: p.date, value: ((p.value / prev) ** (12 / months) - 1) * 100 }] : [];
  });
}

/**
 * 例行发布日 → 标记点:date = 发布日,value = 该次发布那个月在 `byMonth` 里的值(当前修订后,不是首发值)。
 * 同一天发两个月(停摆后补发,如 2026-01-22 的 PCE 一次出了 10、11 月)只留较新的那个月;
 * 那个月在 byMonth 里没值 → 跳过。releases 须按所属月份升序(FRED 默认如此),发布日随之单调,故输出已升序。
 */
export function releaseMarkers(releases: { obsDate: string; releaseDate: string }[], byMonth: Point[]): Point[] {
  const monthValue = new Map(byMonth.map((p) => [p.date, p.value]));
  const byDay = new Map(
    releases.flatMap((r) => {
      const v = monthValue.get(r.obsDate);
      return v === undefined ? [] : [[r.releaseDate, v] as const];
    }),
  );

  return [...byDay].map(([date, value]) => ({ date, value }));
}

/** 日频序列的同比 %:每点对齐到约一年前(≤ 当日−1年 的最近观测),(今/去年−1)×100。
 *  头一年无对照 → 跳过;去年值为 0 → 跳过。用于把 RBOB 等价格转成可与 CPI 并读的 YoY。 */
export function yoyPct(rows: Point[]): Point[] {
  const isoMinusYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  const out: Point[] = [];
  let j = 0; // 指向 ≤ target 的最近一行;target 随 i 单调增,j 只前进

  for (let i = 0; i < rows.length; i++) {
    const target = isoMinusYear(rows[i].date);
    while (j + 1 < rows.length && rows[j + 1].date <= target) j++;
    if (rows[j].date <= target && rows[j].value !== 0)
      out.push({ date: rows[i].date, value: (rows[i].value / rows[j].value - 1) * 100 });
  }
  return out;
}

/**
 * 把 daily 序列在 anchor 的每个日期上取点后相加(逐点前向填充:取 ≤ 该日的最近观测)。
 *
 * ⚠️ **刻意不把 anchor 拉成日频。** 用途是低频腿 + 高频腿拼一个复合量(季频 r* + 日频通胀远期):
 * 复合量的分辨率由低频那半决定,前向填充成日频会让它在图上看起来比实际精细。
 * 高频腿自身的日内变动不会因此丢失 —— 它在自己那一格里照常是日频线。
 *
 * anchor / daily 都要求按日期升序。daily 在某锚点日之前尚无观测 → 该点跳过。
 */
export function sumAtAnchorDates(anchor: Point[], daily: Point[]): Point[] {
  let j = -1; // 指向 ≤ 当前锚点日的最近一行;锚点日单调增,j 只前进

  return anchor.flatMap((a) => {
    while (j + 1 < daily.length && daily[j + 1].date <= a.date) j++;
    return j < 0 ? [] : [{ date: a.date, value: a.value + daily[j].value }];
  });
}

export function subtractAligned(series: Point[][]): Point[] {
  const maps = series.map((s) => new Map(s.map((p) => [p.date, p.value])));
  const dates = [...new Set(series.flatMap((s) => s.map((p) => p.date)))].sort();
  const last: Array<number | null> = series.map(() => null);

  const out: Point[] = [];
  for (const date of dates) {
    // 有新值就更新,否则沿用上次(前向填充)。
    maps.forEach((m, i) => {
      const v = m.get(date);
      if (v !== undefined) last[i] = v;
    });
    // 任一分量还没出现过 → 跳过该日,直到所有分量都有值。
    if (last.every((v) => v !== null)) {
      const [head, ...rest] = last as number[];
      out.push({ date, value: head - rest.reduce((a, b) => a + b, 0) });
    }
  }
  return out;
}

/** 逐点相加(前向填充对齐,口径同 subtractAligned)。首项 + 其余项。 */
export function sumAligned(series: Point[][]): Point[] {
  const [head, ...rest] = series;
  return subtractAligned([head, ...rest.map((s) => scale(s, -1))]);
}

/**
 * 季节性 z-score:每个点对照**往年同期**的分布,输出 (今值 − 同期均值) / 同期标准差。
 *
 * 为什么要有它:库存/开工率这类序列的绝对水位单看不携带信息 —— 柴油库存 1.05 亿桶是高是低,
 * 取决于现在是 3 月还是 9 月。「按季节性去看已经非常低」这句话,只有这条线画得出来。
 *
 * 口径(三个都是刻意的,别随手改):
 *  · **按 day-of-year ± 窗口取样,不按 week-of-year。** 周号跨年会错位(52/53 周),
 *    同一个季节位置在不同年会落到不同周号上。日序差取环形距离,跨年末年初正确。
 *  · **窗口 ±10 天 × 5 年 ≈ 15 个样本。** 严格「同一周号」每年只有 1 个点,5 年 = 5 个样本,
 *    σ 由 n=5 估出来噪声极大,z 会乱跳 —— 那不是信号。
 *  · **基准期排除当年**,只取 [y−years, y−1]。否则最新那个点参与了自己的均值,z 被系统性压小
 *    (EIA 官方的 5-year average 也是这个口径)。
 *
 * ⚠️ **这条线读的是「相对往年同期」,不是「相对历史常态」。** 5 年窗里含 2020-22 的柴油乱期,
 * 且美国炼能在那之后永久退出了一部分 —— 水位的**趋势性**下移会被算进基准,z 因此偏向 0。
 * 换句话说:z 不极端 ≠ 不紧张,可能只是「和前几年一样紧」。判紧张要配水位与裂解一起读。
 *
 * ⚠️ **σ 用样本口径 ÷(n−1),不是 ÷n。** 前者是无偏估计;÷n 会在「15 个样本估 σ 本就低估离散度」
 * 之上再叠一层可避免的低估(n=15 时 σ 偏小约 3.4%,|z| 相应偏大)。实测改过来后馏分油库存 z
 * 的 ±2 带外从 11.1% 降到 8.2% —— 剩下那截才是真胖尾与基准漂移,也就是面板文案真正要讲的东西。
 *
 * ⚠️ **基准期按日历年筛,不按「距当前点多久」—— 这是量过之后的选择,别改。**
 * 日历年判据有个理论缺口:1 月上旬的点,其 ±10 天窗会够到前一年 12 月底的观测,那是同一个冬天、
 * 仅 5 天前,库存自相关又极强 → 会把 |z| 压小。但实测(馏分油库存 2018+ 共 453 点)把「实际相距
 * 不足半年」的样本剔掉后:点数不变,|Δz| 均值 **0.002**、最大 0.26(12/1 月的点均值 0.010),
 * 每点平均只掉 0.02 个样本,末值一模一样。代价却是要在下面并存两个判据。**买不到精度,不改。**
 *
 * 样本不足(< minSamples,且至少 2 个)或 σ 非正的点直接跳过 —— 宁可线短一截,不出不可信的 z。
 */
export function seasonalZ(
  rows: Point[],
  // ⚠️ `years` **没有默认值**:基准期年数的真源是 config 的 SEASONAL_BASELINE_YEARS
  // (它同时决定 fetcher 要多拉多少周)。这里再写一个 5 就成了第二个真源,改一处漏一处而且无声。
  { years, windowDays = 10, minSamples = 8 }: { years: number; windowDays?: number; minSamples?: number },
): Point[] {
  const DAY = 86_400_000;
  const yearOf = (d: string) => Number(d.slice(0, 4));
  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  /**
   * 日序**归一到非闰年日历**:2/29 并入 2/28,其后各日减 1。
   *
   * 不归一的话,闰年 3/1 之后的日序整体比平年多 1,而下面的环长是固定的 365 ——
   * 跨闰年比较就会错开一天:2020-12-28 到 2021-01-02 实际隔 5 天,会被算成 4 天。
   * ±10 天的窗口下这只是让窗口一侧胖一天/瘦一天,但那是纯粹的实现瑕疵,没有任何好处。
   */
  const dayOfYear = (d: string) => {
    const raw = Math.round((Date.parse(d) - Date.parse(`${d.slice(0, 4)}-01-01`)) / DAY);
    return isLeapYear(yearOf(d)) && raw >= 59 ? raw - 1 : raw;
  };
  // 环形距离:12/28 与 01/03 相差 6 天,不是 359 天。
  const seasonalGap = (a: number, b: number) => {
    const raw = Math.abs(a - b);
    return Math.min(raw, 365 - raw);
  };

  const enriched = rows.map((p) => ({ ...p, year: yearOf(p.date), doy: dayOfYear(p.date) }));

  return enriched.flatMap((p) => {
    const base = enriched
      .filter((q) => q.year >= p.year - years && q.year <= p.year - 1 && seasonalGap(q.doy, p.doy) <= windowDays)
      .map((q) => q.value);
    // 下限 2:÷(n−1) 在 n=1 时是除以 0(sd 变 NaN,而 NaN 过不了下面的 sd > 0 判断但也不该走到那);
    // 且单个样本本来就估不出离散度。调用方把 minSamples 传成 1 也不放行。
    if (base.length < Math.max(minSamples, 2)) return [];

    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1));

    // 判 `sd > 0` 而不是 `sd !== 0`:一并挡掉 NaN(任何比较都为 false),不让 NaN/Infinity 漏进序列。
    return sd > 0 ? [{ date: p.date, value: (p.value - mean) / sd }] : [];
  });
}

/**
 * 能源派生层。**提成纯函数只为可测** —— 原本内联在 `/api/regime` 的 handler 里,
 * 而那层要跑起来得有真实网络。变异检验实测:把 crack321 的权重 1/3 改成 1/2、把收率的分子分母
 * 互换、把「先算 z 再裁」的顺序颠倒、把缺腿短路掉,全套测试**一条都不 fail**。
 * 这几个都是改错了也不报错、只让图默默变成另一个量的地方,不该靠「没人动它」来保证。
 *
 * 缺腿一律返回 undefined(由调用方 `put` 归入 unavailable),不出半对的数。
 */
/** 裂解只用到这三条腿 —— Brent 不进裂解(它和 WTI 的差价是另一格),别为了「凑齐油品」把它塞进来。 */
export type CrackLegs = { wti: Point[] | null; diesel: Point[] | null; rbob: Point[] | null };

/** ULSD / RBOB 报价是 $/gal,裂解要 $/bbl → ×42(1 桶 = 42 加仑)。 */
const GAL_PER_BBL = 42;

export function oilCracks({ wti, diesel, rbob }: CrackLegs): {
  dieselCrack?: Point[];
  rbobCrack?: Point[];
  crack321?: Point[];
} {
  const dieselCrack = diesel && wti ? subtractAligned([scale(diesel, GAL_PER_BBL), wti]) : null;
  const rbobCrack = rbob && wti ? subtractAligned([scale(rbob, GAL_PER_BBL), wti]) : null;
  // 3-2-1:3 桶原油 → 2 汽油 + 1 馏分。写成两条单品裂解的加权平均,省掉重复表达 ×42 与权重。
  const crack321 = rbobCrack && dieselCrack ? scale(sumAligned([scale(rbobCrack, 2), dieselCrack]), 1 / 3) : null;

  return { dieselCrack: dieselCrack ?? undefined, rbobCrack: rbobCrack ?? undefined, crack321: crack321 ?? undefined };
}

/**
 * 零售加价 = 零售泵价 − 同口径批发期货,$/gal(两腿同单位,**不 ×42** —— 裂解那几条才换桶)。
 *
 * ⚠️ **必须锚在零售那一侧的日期上。** 零售是 EIA 周一调查、批发是日频期货:反过来锚在日频腿上
 * (或前向填充成日频)会让这条线每天都动,而动的全是批发腿 —— 一个「零售加价日频变动」的假象,
 * 恰好把这条线唯一想测的东西(零售端调价比批发慢)洗掉。锚在周一 = 每周一个点,取当日或之前
 * 最近一个批发收盘(周一休市就取上周五,正是那天的批发参照)。
 *
 * 复用 `sumAtAnchorDates`(它做的就是「锚点日 + 高频腿前向填充」),减号靠 ×(−1) 表达。
 */
export function retailMargin(retail: Point[] | null, wholesale: Point[] | null): Point[] | undefined {
  if (!retail?.length || !wholesale?.length) return undefined;

  return sumAtAnchorDates(retail, scale(wholesale, -1));
}

/**
 * 馏分油收率 = 馏分油产量 / 炼厂加工量 × 100 (%)。分子分母别写反 —— 写反了值仍在合理量级
 * (约 3.3 而不是 30),图上只是"换了个单位",肉眼看不出。
 */
export function distillateYield(distProd: Point[] | null, crudeRuns: Point[] | null): Point[] | undefined {
  return distProd && crudeRuns ? scale(divideAligned(distProd, crudeRuns), 100) : undefined;
}

/**
 * 季节 z + 按展示起点裁剪。**顺序是要害**:多拉的那几年历史是给基准期用的,
 * 先裁再算 = 把基准期一起砍掉,四条 z 会悄悄从 (起点 + years) 才开始,而且不报错。
 */
export function seasonalZFrom(rows: Point[] | null, opts: { years: number; from: string }): Point[] | undefined {
  if (!rows) return undefined;

  return seasonalZ(rows, { years: opts.years }).filter((p) => p.date >= opts.from);
}
