import { Eye, EyeOff } from 'lucide-react';
import { InfoTip } from '../../components/InfoTip';
import { drawnKind } from './registry';
import { CandleSwatch } from './CandleSwatch';
import type { Interval } from '../../hooks/interval';
import { shiftBusinessDays } from '../../chart/analysis';
import { isMarkLayer, type ChartDoc, type Layer } from './chartDoc';
import { changeStats, type Bar, type LinePoint } from '../../chart/core';
import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import { layerLabel, layerUnit } from './layerLabel';
import { layerMarks, type LayerData } from './layerPoints';
import { percentileRank } from '../../../shared/calc/stats';
import { asOfPoint, type LegendLayout } from './useCrosshairLegend';

/** 数值按量级定小数位:BTC 这种五位数不带小数,利率 / 波动率 / 相关性留两位。 */
export function fmtValue(v: number | undefined): string {
  if (v === undefined) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;

  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 配了分位的线:当前读数在分位窗口里的排名(0~100);没配分位、没数据为 undefined */
function pctlRank(l: Layer, pts: LinePoint[] | undefined, value: number | undefined): number | undefined {
  if (!l.percentile || !pts || value === undefined) return undefined;
  const window = layerMarks(l, pts).window;
  const rank = window ? percentileRank(window, value) : Number.NaN;

  return Number.isNaN(rank) ? undefined : rank;
}

/** 十字线当日(无十字线时为最新)的那根 K 线,规则同 asOfPoint */
function asOfBar(bars: Bar[] | undefined, time: string | null): Bar | undefined {
  if (!bars?.length) return undefined;
  return time === null ? bars.at(-1) : bars.findLast((b) => b.time <= time);
}

/** 相对前一个点的涨跌:「+0.12 (+0.53%)」;前值为 0 时只给差值(同旧固定面板) */
function fmtChange({ delta, pct }: { delta: number; pct: number | null }): string {
  const sign = (n: number) => (n >= 0 ? '+' : '');
  return `${sign(delta)}${fmtValue(delta)}${pct === null ? '' : ` (${sign(pct)}${pct.toFixed(2)}%)`}`;
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
          {/* 格子这一层:第 1 格放十字线日期;格子有读法说明就挂 ⓘ —— 说明属于格子(ChartDoc 的 pane.desc),不挂在某条序列名后面 */}
          {(i === 0 || pane.desc) && (
            <span className="flex items-center">
              {i === 0 && <span className="text-neutral-500">{hoverTime ?? '最新'}</span>}
              {/* 只让 ⓘ 接鼠标:日期文字照旧不挡十字线 / 拖拽 */}
              {pane.desc && (
                <span className="pointer-events-auto">
                  <InfoTip text={pane.desc} />
                </span>
              )}
            </span>
          )}
          {pane.layers.map((l) => {
            const pts = data[l.id]?.display;
            const pt = asOfPoint(pts, hoverTime);
            const shift = l.shift ?? 0;
            // 写了 title 的(固定面板的格子)名字里已带单位,不再追加
            const unit = l.title === undefined ? layerUnit(l) : undefined;
            const rank = pctlRank(l, pts, pt?.value);
            // 蜡烛给开高低收;涨跌比的是前一个点(周 / 月线就是上一期),涨绿跌红,同旧固定面板与 TradingView
            const bar = drawnKind(l) === 'candle' ? asOfBar(data[l.id]?.bars, hoverTime) : undefined;
            const change = pt && pts && !isMarkLayer(l) ? changeStats(pt.value, pts[pts.indexOf(pt) - 1]?.value) : null;
            const tone = change && change.delta !== 0 ? (change.delta > 0 ? SIGNED_UP : SIGNED_DOWN) : undefined;
            const num = (v: number) => <span style={{ color: tone }}>{fmtValue(v)}</span>;
            return (
              <span
                key={l.id}
                className={`group pointer-events-auto flex items-center gap-1.5 whitespace-nowrap ${l.hidden ? 'opacity-50' : ''}`}
              >
                {drawnKind(l) === 'candle' ? (
                  <CandleSwatch className="h-2.5 w-3" />
                ) : (
                  <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
                )}
                <span className="text-neutral-400">{layerLabel(doc, l)}</span>
                {/* 标记图层(竖线、背景色带)的值无意义,只给名字 */}
                {!isMarkLayer(l) &&
                  (bar ? (
                    <span className="tabular-nums text-neutral-400">
                      O {num(bar.open)} H {num(bar.high)} L {num(bar.low)} C {num(bar.close)}
                    </span>
                  ) : (
                    <span className="tabular-nums text-neutral-100">{fmtValue(pt?.value)}</span>
                  ))}
                {unit && !isMarkLayer(l) && <span className="text-neutral-600">{unit}</span>}
                {change && (
                  <span className="tabular-nums" style={{ color: tone }}>
                    {fmtChange(change)}
                  </span>
                )}
                {rank !== undefined && <span className="tabular-nums text-neutral-500">P{rank}</span>}
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
