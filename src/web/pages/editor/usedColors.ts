// 取色器顶上「本图在用」那一行:这张图各条线、各条画线此刻画出来的颜色(去重、按出现顺序)。
// 想让气泡和某条线同色,点这一行对应的格子就行,不用记色值
import { DRAWING_COLOR } from '../../chart/drawings';
import type { ChartDoc, Layer } from '../../views/chartDoc/chartDoc';
import { drawnKind } from '../../views/chartDoc/registry';

// 图层颜色不起作用的:蜡烛涨绿跌红、正负柱红绿、指标各条线配色固定(同图层卡片不给取色器的那几种)
function ownColor(l: Layer): string | null {
  return l.indicator || drawnKind(l) === 'candle' || drawnKind(l) === 'signed' ? null : l.color;
}

export function usedColors(doc: ChartDoc): string[] {
  const all = doc.panes.flatMap((p) =>
    p.layers.flatMap((l) => [ownColor(l), ...(l.drawings ?? []).map((d) => d.color ?? DRAWING_COLOR)]),
  );

  return [...new Set(all.filter((c) => c !== null).map((c) => c.toLowerCase()))];
}
