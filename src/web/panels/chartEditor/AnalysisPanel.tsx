import { type ReactNode, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LinePoint } from '../../lib/chart';
import { fitParams, lagScan, shiftBusinessDays, strongestLag, type CorrMode, type LagPoint } from './analysis';
import { hasCorr, isFitTarget, isSeriesLayer, MAX_SHIFT, type ChartDoc, type SeriesLayer } from './chartDoc';
import { baseLabel } from './layerLabel';
import { layerRequest } from './layerPoints';
import { NumberField } from './NumberField';
import type { ChartDocActions } from './useChartDoc';
import { requestKey } from './useEditorSeriesData';
import type { DateRange } from './useVisibleRange';

type Props = {
  doc: ChartDoc;
  /** 取数结果(按请求键)。扫描要用 A / B 未平移的原序列,页面会替选中的两条额外请求一份 */
  points: Record<string, LinePoint[]>;
  visibleRange: DateRange | null;
  /** 选中的 A / B 图层 id(页面持有,因为它要据此多请求未平移的数据) */
  pair: { a?: string; b?: string };
  onPair: (pair: { a?: string; b?: string }) => void;
  actions: Pick<ChartDocActions, 'addStudy' | 'setShift' | 'applyFit'>;
};

const SELECT =
  'min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300 hover:border-neutral-600';
const BTN =
  'rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40';
const DATE =
  'min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300 [color-scheme:dark]';

// 扫描范围上限(交易日,约 3 年):每一步都要整段重新配对算一次,范围随手填大会卡死页面
const MAX_SCAN = 750;

/** 扫描范围:取整、夹进 ±MAX_SCAN、保证 min < max。 */
export function clampLagRange(min: number, max: number): { min: number; max: number } {
  const c = (n: number) => Math.max(-MAX_SCAN, Math.min(MAX_SCAN, Math.round(n)));
  const [lo, hi] = c(min) <= c(max) ? [c(min), c(max)] : [c(max), c(min)];
  if (lo < hi) return { min: lo, max: hi };
  return lo === MAX_SCAN ? { min: lo - 1, max: lo } : { min: lo, max: lo + 1 };
}

/** 选中的两条序列图层:选的不在图上了就退回默认(第一 / 第二条)。 */
export function resolvePair(doc: ChartDoc, pair: { a?: string; b?: string }): { a?: SeriesLayer; b?: SeriesLayer } {
  const series = doc.panes.flatMap((p) => p.layers.filter(isSeriesLayer));
  const a = series.find((l) => l.id === pair.a) ?? series[0];
  const b = series.find((l) => l.id === pair.b && l.id !== a?.id) ?? series.find((l) => l.id !== a?.id);

  return { a, b };
}

/** A / B 未平移、未聚合的日线原序列请求(扫描要逐交易日平移;页面据此多取一份数据)。 */
const rawRequest = (l: SeriesLayer) => ({ series: l.series, shift: 0, daily: true as const });
export const pairRequests = (pair: { a?: SeriesLayer; b?: SeriesLayer }) =>
  [pair.a, pair.b].filter((l) => l !== undefined).map(rawRequest);

// 右侧「分析」区:选两条线 A / B,三件工具 —— 加滚动相关性格、领先滞后扫描、参照期对齐。
export function AnalysisPanel({ doc, points, visibleRange, pair, onPair, actions }: Props) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<CorrMode>('level');
  const [horizon, setHorizon] = useState(20);
  const [corrWindow, setCorrWindow] = useState(60);
  const [lagRange, setLagRange] = useState({ min: -40, max: 180 });
  const [onlyVisible, setOnlyVisible] = useState(true);
  const [ref, setRef] = useState({ start: '', end: '' });

  const series = doc.panes.flatMap((p) => p.layers.filter(isSeriesLayer));
  const { a, b } = resolvePair(doc, pair);
  const corrExists = !!a && !!b && hasCorr(doc, a.id, b.id);
  const aPts = a && points[requestKey(rawRequest(a))];
  const bPts = b && points[requestKey(rawRequest(b))];
  // 可视区间是画面上的日期(A 平移后的);扫描用的是 A 未平移的原序列,按 A 的平移反推回去才对得上。
  // 依赖用起止日期字符串:十字线一动整页重渲染,换算出的新对象若进依赖,扫描每帧重算(上千步 × 上万点)
  const aShift = a?.shift ?? 0;
  const scanFrom = onlyVisible && visibleRange ? shiftBusinessDays(visibleRange.from, -aShift) : undefined;
  const scanTo = onlyVisible && visibleRange ? shiftBusinessDays(visibleRange.to, -aShift) : undefined;

  const scan = useMemo(
    () =>
      // 区收起时不算:默认只扫可视区间,每次平移 / 缩放都会重跑上千步
      open && aPts?.length && bPts?.length
        ? lagScan(aPts, bPts, {
            minLag: lagRange.min,
            maxLag: lagRange.max,
            mode,
            horizon,
            range: scanFrom && scanTo ? { from: scanFrom, to: scanTo } : undefined,
          })
        : [],
    [open, aPts, bPts, lagRange, mode, horizon, scanFrom, scanTo],
  );
  const best = strongestLag(scan);

  // 先按当前数据试算一次:参照期里配对点不够(<10)就不让点,免得换算失败、线白挪一趟。
  // B 已是别的线的换算目标时不能再换算它(会把那条线的换算静默冲掉)。试算也走 memo,理由同上
  const bIsTarget = !!b && isFitTarget(doc, b.id);
  const refOk = !!a && !!b && ref.start !== '' && ref.end !== '' && ref.start < ref.end && !a.fit && !bIsTarget;
  const aFitPts = a ? points[requestKey(layerRequest(a))] : undefined;
  const bFitPts = b ? points[requestKey(layerRequest(b))] : undefined;
  const fitPreview = useMemo(
    () => (refOk ? fitParams(aFitPts ?? [], bFitPts ?? [], ref.start, ref.end) : null),
    [refOk, aFitPts, bFitPts, ref.start, ref.end],
  );

  if (series.length < 2) {
    return (
      <Section open={open} onToggle={() => setOpen((v) => !v)}>
        <p className="text-xs text-neutral-500">图上至少要有两条序列,才能比较相关性、领先滞后和做参照期对齐</p>
      </Section>
    );
  }

  const name = (l?: SeriesLayer) => (l ? baseLabel(doc, l.id) : '?');

  return (
    <Section open={open} onToggle={() => setOpen((v) => !v)}>
      <div className="flex items-center gap-1.5 text-xs text-neutral-400">
        A
        <select value={a?.id} onChange={(e) => onPair({ ...pair, a: e.target.value })} className={SELECT}>
          {series.map((l) => (
            <option key={l.id} value={l.id}>
              {name(l)}
            </option>
          ))}
        </select>
        B
        <select value={b?.id} onChange={(e) => onPair({ ...pair, b: e.target.value })} className={SELECT}>
          {series
            .filter((l) => l.id !== a?.id)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {name(l)}
              </option>
            ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as CorrMode)}
          className="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300"
          title="水平:直接拿数值算(两条都有长期趋势时会虚高);变化率:先换成各自 N 期的涨跌再算"
        >
          <option value="level">按水平</option>
          <option value="change">按变化率</option>
        </select>
        {mode === 'change' && (
          <span className="flex items-center gap-1">
            变化期
            <NumberField value={horizon} onCommit={(n) => setHorizon(Math.max(1, Math.min(500, Math.round(n))))} />
          </span>
        )}
      </div>

      <Tool title="滚动相关性">
        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          窗口
          <NumberField value={corrWindow} onCommit={(n) => setCorrWindow(Math.max(5, Math.min(2000, Math.round(n))))} />
          期
          <button
            type="button"
            className={`${BTN} ml-auto`}
            disabled={!a || !b || corrExists}
            title={corrExists ? '这两条线已有一格相关性,窗口 / 口径在那张卡片上改' : undefined}
            onClick={() =>
              a && b && actions.addStudy({ kind: 'corr', a: a.id, b: b.id, window: corrWindow, mode, horizon })
            }
          >
            {corrExists ? '已在图上' : '加一格到图上'}
          </button>
        </div>
      </Tool>

      <Tool title="领先滞后扫描">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
          B 平移
          <NumberField value={lagRange.min} onCommit={(n) => setLagRange((r) => clampLagRange(n, r.max))} />~
          <NumberField value={lagRange.max} onCommit={(n) => setLagRange((r) => clampLagRange(r.min, n))} />天
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={onlyVisible} onChange={(e) => setOnlyVisible(e.target.checked)} />
            只算可视区间
          </label>
        </div>
        <LagChart scan={scan} best={best} />
        {best ? (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span className="flex-1">
              最强:
              {best.lag >= 0
                ? `${name(b)} 领先 ${name(a)} ${best.lag} 天`
                : `${name(a)} 领先 ${name(b)} ${-best.lag} 天`}
              ,相关 {best.r.toFixed(2)}(样本 {best.n})
            </span>
            <button
              type="button"
              className={BTN}
              disabled={Math.abs(best.lag + (a?.shift ?? 0)) > MAX_SHIFT}
              onClick={() => b && actions.setShift(b.id, best.lag + (a?.shift ?? 0))}
              title={
                Math.abs(best.lag + (a?.shift ?? 0)) > MAX_SHIFT
                  ? `叠上 A 当前的平移后超过 ±${MAX_SHIFT} 天的上限,设不了`
                  : '把 B 平移到这个位置(相对 A 当前的平移)'
              }
            >
              按此平移 B
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-600">数据不足,算不出来</p>
        )}
        {best && (best.lag === lagRange.min || best.lag === lagRange.max) && (
          <p className="text-[11px] leading-snug text-amber-500">
            最强点落在扫描范围的边上,真正的峰值可能还在范围外,放宽范围再看。
          </p>
        )}
        <p className="text-[11px] leading-snug text-neutral-600">
          看整条曲线比只看最高点可靠:一片平台说明「大约」这个天数,单个尖峰多半是巧合。两条都有长期趋势时用「按变化率」。
        </p>
      </Tool>

      <Tool title="参照期对齐">
        <div className="flex items-center gap-1 text-xs text-neutral-500">
          <input
            type="date"
            value={ref.start}
            onChange={(e) => setRef((r) => ({ ...r, start: e.target.value }))}
            className={DATE}
          />
          ~
          <input
            type="date"
            value={ref.end}
            onChange={(e) => setRef((r) => ({ ...r, end: e.target.value }))}
            className={DATE}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={BTN}
            disabled={!visibleRange}
            onClick={() => visibleRange && setRef({ start: visibleRange.from, end: visibleRange.to })}
            title="先把图缩放到两条线走势相似的那段,再点这里"
          >
            取当前可视区间
          </button>
          <button
            type="button"
            className={`${BTN} ml-auto`}
            disabled={!fitPreview}
            onClick={() => a && b && actions.applyFit(b.id, { target: a.id, start: ref.start, end: ref.end })}
          >
            把 B 换算到 A 的刻度
          </button>
        </div>
        <p className="text-[11px] leading-snug text-neutral-600">
          参照期选两条线本来走势相似、在劈叉之前的那段,尽量长、包含几轮涨跌。换算后 B 挪到 A
          的格和轴上,下面加一格劈叉幅度。
          {a?.fit && ' A 自己已在换算中,不能当基准。'}
          {bIsTarget &&
            ` ${name(b)} 是 ${series
              .filter((l) => l.fit?.target === b?.id)
              .map((l) => name(l))
              .join('、')} 的换算目标,先取消那条线的对齐。`}
          {refOk && !fitPreview && ' 这段参照期里两条线能配对的数据点不到 10 个,换一段更长的。'}
        </p>
      </Tool>
    </Section>
  );
}

function Section({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-neutral-800 pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 px-1 text-xs font-medium text-neutral-400 hover:text-neutral-200"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        分析
      </button>
      {open && <div className="flex flex-col gap-2 px-1">{children}</div>}
    </section>
  );
}

function Tool({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-neutral-800 p-1.5">
      <h3 className="text-xs text-neutral-400">{title}</h3>
      {children}
    </div>
  );
}

const W = 280;
const H = 96;
const PAD = { l: 26, r: 6, t: 6, b: 16 };

// 「平移天数 → 相关性」曲线。横轴平移天数,纵轴 −1~1;标出 0 天竖线与最强点。
function LagChart({ scan, best }: { scan: LagPoint[]; best: LagPoint | undefined }) {
  const valid = scan.filter((p) => Number.isFinite(p.r));
  if (valid.length < 2) return null;

  const lo = scan[0].lag;
  const hi = scan.at(-1)!.lag;
  const x = (lag: number) => PAD.l + ((lag - lo) / (hi - lo || 1)) * (W - PAD.l - PAD.r);
  const y = (r: number) => PAD.t + ((1 - r) / 2) * (H - PAD.t - PAD.b);
  const path = valid.map((p) => `${x(p.lag).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="平移天数与相关性">
      {[1, 0, -1].map((r) => (
        <g key={r}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(r)} y2={y(r)} stroke={r === 0 ? '#404040' : '#262626'} />
          <text x={PAD.l - 4} y={y(r) + 3} textAnchor="end" fontSize="9" fill="#737373">
            {r}
          </text>
        </g>
      ))}
      {lo < 0 && hi > 0 && (
        <line x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} stroke="#404040" strokeDasharray="2 2" />
      )}
      <polyline points={path} fill="none" stroke="#3987e5" strokeWidth="1.5" />
      {best && <circle cx={x(best.lag)} cy={y(best.r)} r="3" fill="#e66767" />}
      {[lo, 0, hi]
        .filter((v, i, arr) => arr.indexOf(v) === i && v >= lo && v <= hi)
        .map((v) => (
          <text key={v} x={x(v)} y={H - 4} textAnchor="middle" fontSize="9" fill="#737373">
            {v}
          </text>
        ))}
    </svg>
  );
}
