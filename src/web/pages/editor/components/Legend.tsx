import { Eye, EyeOff } from 'lucide-react';
import type { Interval } from '../../../hooks/interval';
import { shiftBusinessDays } from '../../../chart/analysis';
import type { ChartDoc } from '../../../views/chartDoc/chartDoc';
import { layerLabel, layerUnit } from '../layerLabel';
import type { LayerData } from '../hooks/layerPoints';
import { asOfPoint, type LegendLayout } from '../hooks/useCrosshairLegend';

/** 数值按量级定小数位:BTC 这种五位数不带小数,利率 / 波动率 / 相关性留两位。 */
export function fmtValue(v: number | undefined): string {
  if (v === undefined) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;

  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

type Props = {
  doc: ChartDoc;
  /** 页头周期:只有日线才标原始日期(周 / 月线聚合后只剩周期键,反推出来的不是真实来源日) */
  interval: Interval;
  data: Record<string, LayerData>;
  hoverTime: string | null;
  layout: LegendLayout;
  onHidden: (layerId: string, hidden: boolean) => void;
};

// 每格左上角一块:该格各图层的名称 + 十字线当日(无十字线时为最新)的值。不挡鼠标。
// 换算过的线读原始值(换算值只是为了叠图);平移过的线附上这个点的原始日期,免得把挪过的日子当真。
// 显隐按钮同 TradingView:悬停这一行才出现;隐藏了就常亮,线没了也找得到地方点回来。
// 只有行本身接鼠标(要靠 hover 显出按钮),块的其余部分照旧不挡十字线。
export function Legend({ doc, interval, data, hoverTime, layout, onHidden }: Props) {
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
            const pt = asOfPoint(data[l.id]?.display, hoverTime);
            const shift = l.shift ?? 0;
            const unit = layerUnit(l);
            return (
              <span
                key={l.id}
                className={`group pointer-events-auto flex items-center gap-1.5 whitespace-nowrap ${l.hidden ? 'opacity-50' : ''}`}
              >
                <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
                <span className="text-neutral-400">{layerLabel(doc, l)}</span>
                <span className="tabular-nums text-neutral-100">{fmtValue(pt?.value)}</span>
                {unit && <span className="text-neutral-600">{unit}</span>}
                {shift !== 0 && pt && interval === '1D' && (
                  <span className="text-neutral-600">原 {shiftBusinessDays(pt.time, -shift)}</span>
                )}
                <button
                  type="button"
                  onClick={() => onHidden(l.id, !l.hidden)}
                  title={l.hidden ? '显示' : '隐藏'}
                  // 用透明度藏而不是 invisible:invisible 的按钮 Tab 不到
                  className={`text-neutral-400 hover:text-neutral-100 ${l.hidden ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                >
                  {l.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
}
