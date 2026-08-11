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

/**
 * 期限结构价差(近端 − 远端,正 = backwardation),已摊平成面板要的 {date,value}。
 *
 * **为什么是具名入参而不是两个位置参数**:减号方向是这条线上唯一「写反了不会报错、
 * 只会让人把图读反一格」的地方 —— 而位置参数的调换,单测抓不住(测函数本身永远是绿的,
 * 错发生在调用点)。改成 `{ near, far }` 之后,写反必须写成 `{ near: 三个月, far: 三十天 }`,
 * 这在阅读时是自明的荒谬,不再依赖谁记得住顺序。
 *
 * 同一 tab 里的两格(VX1−V3 与 VIX−VIX3M)都走这里,方向因此不可能不一致。
 */
export const nearMinusFar = (legs: {
  near: Array<{ date: string; value: number }>;
  far: Array<{ date: string; value: number }>;
}): Array<{ date: string; value: number }> =>
  computeSpread(legs.near, legs.far).map((r) => ({ date: r.date, value: r.spread }));
