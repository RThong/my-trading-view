// 手绘趋势线(旧版多格图 PaneChart 的画线,特色指标 › 攻防)的纯核心:几何命中检测 + localStorage 序列化。
// 画在图上的图元见 primitives/trendlines,交互见 trendlines.hooks。

// 锚点用「逻辑坐标(logical index)」而非时间:logicalToCoordinate 在最右空白区也有效,
// 故线能画进无数据区、预览/端点始终跟手;时间坐标在空白区为 null,做不到。
export type Anchor = { logical: number; price: number };
export type TrendLine = { a: Anchor; b: Anchor };

// 点 (px,py) 到线段 (x1,y1)-(x2,y2) 的最短距离。垂足落在段外时取到最近端点的距离。
// 用于点击命中检测(≤阈值即选中该线)。
export function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  // 退化成一个点:直接返回到该点的距离,避免除零。
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

export function serializeLines(lines: TrendLine[]): string {
  return JSON.stringify(lines);
}

function isAnchor(v: unknown): v is Anchor {
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite((v as Anchor).logical) &&
    Number.isFinite((v as Anchor).price)
  );
}

function isLine(v: unknown): v is TrendLine {
  return typeof v === 'object' && v !== null && isAnchor((v as TrendLine).a) && isAnchor((v as TrendLine).b);
}

// 容错解析:null / 坏 JSON / 非数组一律得空数组,绝不抛(localStorage 内容不可信)。
// 逐元素校验形状——[null]、[{}] 等合法 JSON 也要滤掉,否则渲染取 ln.a 会崩。
export function parseLines(raw: string | null): TrendLine[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isLine) : [];
  } catch {
    return [];
  }
}
