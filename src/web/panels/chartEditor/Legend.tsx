import type { LinePoint } from '../../lib/chart';
import type { ChartDoc } from './chartDoc';
import { seriesDef } from './registry';
import { asOfValue, type LegendLayout } from './useCrosshairLegend';

/** 数值按量级定小数位:BTC 这种五位数不带小数,利率 / 波动率留两位。 */
export function fmtValue(v: number | undefined): string {
  if (v === undefined) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;

  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

type Props = {
  doc: ChartDoc;
  points: Record<string, LinePoint[]>;
  hoverTime: string | null;
  layout: LegendLayout;
};

// 每格左上角一块:该格各图层的名称 + 十字线当日(无十字线时为最新)的值。不挡鼠标。
export function Legend({ doc, points, hoverTime, layout }: Props) {
  return (
    <>
      {doc.panes.map((pane, i) => (
        <div
          key={pane.id}
          className="pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded bg-neutral-950/70 px-1.5 py-1 text-xs"
          style={{ top: (layout.tops[i] ?? 0) + 4, left: layout.left + 8 }}
        >
          {i === 0 && <span className="text-neutral-500">{hoverTime ?? '最新'}</span>}
          {pane.layers.map((l) => {
            const def = seriesDef(l.series);
            return (
              <span key={l.id} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
                <span className="text-neutral-400">{def?.label ?? l.series}</span>
                <span className="tabular-nums text-neutral-100">
                  {fmtValue(asOfValue(points[l.series], hoverTime))}
                </span>
                {def?.unit && <span className="text-neutral-600">{def.unit}</span>}
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
}
