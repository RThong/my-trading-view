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
