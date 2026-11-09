// 磁吸的纯计算:把画线锚点吸到光标所在那一根的某个值上(同 TradingView 的 Magnet)。
// 弱 = 光标离最近的值够近才吸;强 = 总是吸。线只有一个值(收盘),蜡烛有开高低收四个。
// 编辑器里怎么接(插件形式)见 pages/editor/drawingPlugins。

type Point = { time: string; value: number };

/** 光标所在那一根:日期 + 可吸的值 */
export type BarValues = { time: string; values: number[] };

/** 弱磁吸的半径(像素)。TradingView 没公开具体值,取「靠近才吸、不靠近不打扰」的手感距离 */
export const WEAK_PX = 12;

/**
 * 吸附:在这一根的各个值里找离光标(纵向像素)最近的,弱磁吸要求在 WEAK_PX 以内;吸上了日期也对齐到这一根。
 * 那里没数据 / 值换算不出像素 → 原样返回
 */
export function snapToBar(
  p: Point,
  cursorY: number,
  bar: BarValues | null,
  toY: (v: number) => number | null,
  strong: boolean,
): Point {
  const nearest = (bar?.values ?? [])
    .map((v) => ({ v, d: Math.abs((toY(v) ?? Number.NaN) - cursorY) }))
    .filter((c) => Number.isFinite(c.d))
    .sort((a, b) => a.d - b.d)[0];
  if (!bar || !nearest || (!strong && nearest.d > WEAK_PX)) return p;

  return { time: bar.time, value: nearest.v };
}

/** 只用日期的线(竖线):日期对齐到光标所在那一根,不管强弱、不看高度;那里没数据 → 原样 */
export function snapTime(p: Point, bar: BarValues | null): Point {
  return bar ? { ...p, time: bar.time } : p;
}
