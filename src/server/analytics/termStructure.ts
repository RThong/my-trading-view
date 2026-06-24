// VIX 期限结构:VX1 − VX3 点差。正=倒挂(backwardation,恐慌结构化),负=contango。
// 按交易日 inner join 两条序列;只保留两边都有值的日期。读时算,不落库。
export type SpreadRow = { date: string; vx1: number; vx3: number; spread: number };

export function computeSpread(
  vx1: Array<{ date: string; value: number }>,
  vx3: Array<{ date: string; value: number }>,
): SpreadRow[] {
  const m3 = new Map(vx3.map((r) => [r.date, r.value]));
  return vx1.flatMap((r) => {
    const v3 = m3.get(r.date);
    return v3 === undefined ? [] : [{ date: r.date, vx1: r.value, vx3: v3, spread: r.value - v3 }];
  });
}
