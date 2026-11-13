import type { ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { InfoTip } from '../../components/InfoTip';
import { drawnKind } from './registry';
import { CandleSwatch } from './CandleSwatch';
import type { Interval } from '../../hooks/interval';
import { shiftBusinessDays } from '../../chart/analysis';
import { isMarkLayer, type ChartDoc, type Layer, type Pane } from './chartDoc';
import { changeStats, type Bar, type LinePoint } from '../../chart/core';
import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import { layerLabel, layerUnit, shiftText } from './layerLabel';
import { allSevenDay, canLogScale, layerMarks, plotId, plotsOf, type LayerData } from './layerPoints';
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

/**
 * 没有十字线时图例顶上写的日期:显示中的线(竖线 / 背景色带这类标记图层除外)最后一个点里最晚的那天。
 * 平移过的线图上的日期是挪过的,还原成原始日期再比(右移的线不还原会拿到一个还没到的日子);隐藏的线不参与。
 * 不写「最新」:存成图片后看图的人不知道最新是哪天(负责人 2026-11-13 定;TV 图例不写日期,我们的图要能单独拿出去看)
 */
function latestTime(doc: ChartDoc, data: Record<string, LayerData>): string | undefined {
  return doc.panes
    .flatMap((p) => p.layers)
    .filter((l) => !isMarkLayer(l) && !l.hidden)
    .map((l) => {
      const t = data[l.id]?.display?.at(-1)?.time;
      return t && l.shift ? shiftBusinessDays(t, -l.shift) : t;
    })
    .reduce<string | undefined>((max, t) => (t !== undefined && (max === undefined || t > max) ? t : max), undefined);
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

// 每格左上角一块:该格各图层的名称 + 十字线当日(无十字线时为最新)的值,顶上写这一天的日期。不挡鼠标。
// 换算过的线读原始值(换算值只是为了叠图);平移过的线附上这个点的原始日期,免得把挪过的日子当真。
// 显隐按钮同 TradingView:悬停这一行才出现。隐藏的线收进下面一块紧凑小字(名字 + 读数,点一下显示):
// 曲线走势那类一格挂十几二十条期限的,一条一行会比图还高。只有行本身接鼠标,块的其余部分照旧不挡十字线。
export function Legend({ doc, interval, data, hoverTime, layout, onHidden }: Props) {
  const row = { doc, interval, data, hoverTime, onHidden };
  return (
    <>
      {doc.panes.map((pane, i) => {
        const shown = pane.layers.filter((l) => !l.hidden);
        const hidden = pane.layers.filter((l) => l.hidden);
        // 读法说明属于格子(ChartDoc 的 pane.desc),挂在第一条显示中的线名后面,不另占一行;全隐藏时挂在隐藏块前
        const info = pane.desc && <InfoTip text={pane.desc} className="-ml-0.5 h-3 w-3 text-[8px]" />;
        return (
          <div
            key={pane.id}
            className="pointer-events-none absolute z-10 flex max-w-xl flex-col gap-0.5 rounded bg-neutral-950/70 px-1.5 py-1 text-xs"
            style={{ top: (layout.tops[i] ?? 0) + 4, left: layout.left + 8 }}
          >
            {/* 第 1 格顶上放十字线日期,没有十字线时是数据最后一天 */}
            {i === 0 && <span className="text-neutral-500">{hoverTime ?? latestTime(doc, data) ?? '最新'}</span>}
            {shown.map((l, j) => (
              <LayerRow key={l.id} layer={l} pane={pane} info={j === 0 ? info : undefined} {...row} />
            ))}
            {hidden.length > 0 && (
              <span className="pointer-events-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                {shown.length === 0 && info}
                <EyeOff className="size-3 text-neutral-600" />
                {hidden.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => onHidden(l.id, false)}
                    title="显示"
                    className="whitespace-nowrap text-neutral-500 hover:text-neutral-200"
                  >
                    {layerLabel(doc, l)}
                    {!isMarkLayer(l) && !l.indicator && (
                      <span className="ml-1 tabular-nums">
                        {fmtValue(asOfPoint(data[l.id]?.display, hoverTime)?.value)}
                      </span>
                    )}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

type RowProps = Omit<Props, 'layout'> & { layer: Layer; pane: Pane; info: ReactNode };

function LayerRow(props: RowProps) {
  return props.layer.indicator ? <IndicatorRow {...props} /> : <SeriesRow {...props} />;
}

/** 指标:一个指标一行,各条子线的读数按自己的颜色排开(EMA 5 652 · 20 640 …) */
function IndicatorRow({ doc, data, hoverTime, onHidden, layer: l, pane, info }: RowProps) {
  const plots = plotsOf(l, allSevenDay(doc));
  return (
    <span className="group pointer-events-auto flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-0.5 w-3 rounded" style={{ background: plots[0]?.color }} />
      <span className="text-neutral-400">{layerLabel(doc, l, { withShift: false })}</span>
      <LayerTags pane={pane} layer={l} data={data} />
      {info}
      {plots.map((p) => {
        const v = asOfPoint(data[plotId(l, p)]?.display, hoverTime)?.value;
        // 没数(如周线下的 365 年线)不占位
        return v === undefined ? null : (
          <span key={p.key} className="tabular-nums" style={{ color: p.color }}>
            {p.title} {fmtValue(v)}
          </span>
        );
      })}
      <HideButton onClick={() => onHidden(l.id, true)} />
    </span>
  );
}

// 带边框的小标签:比 TradingView 角落里一个高亮的 log 按钮显眼,做成固定面板后一眼看得出这条线被改过刻度 / 时间
const TAG = 'rounded-sm border border-neutral-600 px-1 text-[10px] leading-4 text-neutral-300';

/**
 * 线名后的状态标签:对数(按实际生效算 —— 轴上有 ≤0 的值时开了也按普通坐标画,不标)、平移几个交易日
 * (平移原本写在线名括号里,图例改用标签、线名不再带它,别处照旧)。
 * 倒轴不标(负责人 2026-11-12 定:看轴刻度方向即可,同 TradingView)
 */
function LayerTags({ pane, layer: l, data }: Pick<RowProps, 'pane' | 'layer' | 'data'>) {
  const log = pane.scales.find((sc) => sc.id === l.scale)?.log && canLogScale(pane, l.scale, data);
  const shift = l.shift ?? 0;

  return (
    <>
      {log && (
        <span className={TAG} title="对数坐标:等比例的涨跌画成等高,纵向距离代表百分比而不是点数">
          对数
        </span>
      )}
      {shift !== 0 && (
        <span
          className={TAG}
          title={`整条线往${shift > 0 ? '右(后)' : '左(前)'}挪了 ${Math.abs(shift)} 个交易日(看领先关系用):图上的位置不是它真实的日期`}
        >
          {shiftText(shift)}
        </span>
      )}
    </>
  );
}

/** 用透明度藏而不是 invisible:invisible 的按钮 Tab 不到 */
function HideButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="隐藏"
      className="text-neutral-400 opacity-0 hover:text-neutral-100 group-hover:opacity-100 focus-visible:opacity-100"
    >
      <Eye className="size-3.5" />
    </button>
  );
}

/** 显示中的一条序列:名称、读数(蜡烛给开高低收)、涨跌、分位排名、平移原日期、显隐按钮 */
function SeriesRow({ doc, interval, data, hoverTime, onHidden, layer: l, pane, info }: RowProps) {
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
    <span className="group pointer-events-auto flex items-center gap-1.5 whitespace-nowrap">
      {drawnKind(l) === 'candle' ? (
        <CandleSwatch className="h-2.5 w-3" />
      ) : (
        <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
      )}
      <span className="text-neutral-400">{layerLabel(doc, l, { withShift: false })}</span>
      <LayerTags pane={pane} layer={l} data={data} />
      {info}
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
      <HideButton onClick={() => onHidden(l.id, true)} />
    </span>
  );
}
