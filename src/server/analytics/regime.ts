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
