import { useMemo, useState } from 'react';
import { aggregate, type LinePoint } from '../../lib/chart';
import type { Interval } from '../../hooks/interval';
import { useSoxFngData, bandOf, SOX_FNG_PANES, type Band, type SoxFngData } from './soxFng.hooks';

// 半导体风险情绪温度计面板:刻意区别于 dashboard 其它「图表为主」面板 —— CNN 式版式,
// 左小图(原生单位)+ 徽标、右文字介绍;顶部横向频谱 meter 当签名(信号表隐喻,贴半导体)。
// 迷你线图统一蓝(安静),情绪色只留给徽标与 meter 指针。动量例外:CNN 式画 SOXX 价 + 125日均线两条。
// 图表画 raw 原生值(比率/波动率显示 %,put/call 显示比率,动量显示价);徽标/复合用 0-100 归一分。
// Hero 旁显示「本日 X/6 项有效」:某腿(常见 put/call)当天缺数据时复合会少一项,避免误读成情绪变化。

const LINE = '#60a5fa'; // 迷你图统一线色(动量的价线也用它)
const MA_LINE = '#f59e0b'; // 动量 125 日均线(CNN 式橙色)
const WINDOW = 252; // 迷你图只画最近一年(CNN 观感),交易日计

const toLine = (rows: { date: string; value: number }[]): LinePoint[] =>
  rows.map((r) => ({ time: r.date, value: r.value }));

// 分数(比率/波动率等)按 % 显示;ratio(put/call)按原值;price(动量价/均线)按原值。
type Unit = 'pct' | 'ratio' | 'price';
const fmt = (v: number, unit?: Unit) =>
  unit === 'ratio' || unit === 'price' ? v.toFixed(unit === 'price' ? 1 : 2) : `${(v * 100).toFixed(1)}%`;

/** 数据值域 + 10% 留白;平坦序列给 ±1 兜底。 */
function domainOf(points: LinePoint[]): { lo: number; hi: number } {
  if (!points.length) return { lo: 0, hi: 1 };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    lo = Math.min(lo, p.value);
    hi = Math.max(hi, p.value);
  }
  if (lo === hi) {
    const d = Math.abs(lo) || 1;
    return { lo: lo - d, hi: hi + d };
  }
  const pad = (hi - lo) * 0.1;
  return { lo: lo - pad, hi: hi + pad };
}

type ChartLine = { points: LinePoint[]; color: string; label: string };

/** 原生单位 SVG 迷你折线(可多条)+ hover 十字线/圆点/读数框(CNN 式)。
 *  用 HTML 覆盖层定位十字线与圆点,避开 preserveAspectRatio=none 的 SVG 拉伸变形。 */
function MiniChart({ lines, lo, hi, unit }: { lines: ChartLine[]; lo: number; hi: number; unit?: Unit }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState(0); // 光标 y(%),画水平线用
  const span = hi - lo || 1;
  const n = lines[0]?.points.length ?? 0;
  const xPct = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const yPct = (v: number) => ((hi - v) / span) * 100;
  const zeroIn = lo < 0 && hi > 0;
  const pathOf = (points: LinePoint[]) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${xPct(i).toFixed(2)},${yPct(p.value).toFixed(2)}`).join(' ');

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / rect.width) * (n - 1)))));
    setHoverY(Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100)));
  };

  const date = hover != null ? lines[0]?.points[hover]?.time : undefined;

  return (
    <div className="relative h-[104px] w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <title>迷你走势</title>
        {zeroIn && (
          <line
            x1="0"
            x2="100"
            y1={yPct(0)}
            y2={yPct(0)}
            stroke="#3f3f46"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {lines.map(
          (l) =>
            l.points.length > 1 && (
              <path
                key={l.color}
                d={pathOf(l.points)}
                fill="none"
                stroke={l.color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ),
        )}
      </svg>

      {/* hover:十字线(竖+横)+ 各线圆点 + 左上读数框 */}
      {hover != null && n > 1 && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-neutral-500/60"
            style={{ left: `${xPct(hover)}%` }}
          />
          <div
            className="pointer-events-none absolute right-0 left-0 h-px bg-neutral-500/60"
            style={{ top: `${hoverY}%` }}
          />
          {lines.map((l) => {
            const pt = l.points[hover];
            return pt ? (
              <div
                key={l.color}
                className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-neutral-900"
                style={{ left: `${xPct(hover)}%`, top: `${yPct(pt.value)}%`, background: l.color }}
              />
            ) : null;
          })}
          <div className="pointer-events-none absolute top-1 left-1 rounded bg-neutral-900/85 px-1.5 py-1 text-[10px] leading-tight">
            <div className="text-neutral-400">{date}</div>
            {lines.map((l) => {
              const pt = l.points[hover];
              return pt ? (
                <div key={l.color} className="flex items-center gap-1.5 tabular-nums">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
                  <span className="text-neutral-400">{l.label}</span>
                  <span className="ml-auto text-neutral-200">{fmt(pt.value, unit)}</span>
                </div>
              ) : null;
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** 恐贪徽标:描边 + 文字取当前档颜色(对齐 CNN 右上角 FEAR/GREED 药丸)。 */
function Badge({ band }: { band: Band }) {
  return (
    <span
      className="shrink-0 rounded border px-2 py-0.5 text-xs font-medium"
      style={{ color: band.color, borderColor: band.color }}
    >
      {band.label}
    </span>
  );
}

/** 签名:横向频谱 meter(红→绿渐变 + 当前值指针)。 */
function Meter({ value }: { value: number }) {
  const band = bandOf(value);
  return (
    <div className="mt-5 max-w-xl">
      <div
        className="relative h-2.5 rounded-full"
        style={{ background: 'linear-gradient(90deg,#dc2626,#f97316,#eab308,#84cc16,#22c55e)' }}
      >
        {/* 指针:白色竖线 + 顶部圆点(填当前档色) */}
        <div className="-top-1 -translate-x-1/2 absolute h-[18px] w-0.5 bg-neutral-100" style={{ left: `${value}%` }} />
        <div
          className="-top-[7px] -translate-x-1/2 absolute h-3 w-3 rounded-full border-2 border-neutral-100"
          style={{ left: `${value}%`, background: band.color }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-neutral-600">
        <span>0 极度恐惧</span>
        <span>50</span>
        <span>极度贪婪 100</span>
      </div>
    </div>
  );
}

function IndicatorRow({
  cfg,
  scorePts,
  rawPts,
  momLines,
}: {
  cfg: (typeof SOX_FNG_PANES)[number];
  scorePts: LinePoint[];
  rawPts: LinePoint[];
  momLines?: { price: LinePoint[]; ma: LinePoint[] };
}) {
  const latestScore = scorePts.at(-1)?.value; // 档位/徽标用归一分
  const latestRaw = rawPts.at(-1)?.value; // 展示用原生值(动量=偏离%)
  const band = latestScore != null ? bandOf(latestScore) : undefined;

  // 动量:CNN 式双线(价 + 125日均线),y 轴为价;其余单线,y 轴为各自原生单位。
  const isMom = cfg.key === 'mom' && !!momLines?.price.length;
  const lines: ChartLine[] = isMom
    ? [
        { points: momLines!.price, color: LINE, label: 'SOXX 价' },
        { points: momLines!.ma, color: MA_LINE, label: '125 日均线' },
      ]
    : [{ points: rawPts, color: LINE, label: cfg.label }];
  const yUnit = isMom ? 'price' : cfg.unit;
  const { lo, hi } = domainOf(lines.flatMap((l) => l.points));
  const hasChart = lines.some((l) => l.points.length);

  return (
    <section className="grid gap-x-6 gap-y-3 border-neutral-800 border-t py-6 md:grid-cols-[minmax(0,1fr)_300px]">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-neutral-200 text-sm">{cfg.label}</h3>
            <p className="mt-0.5 text-neutral-500 text-xs">{cfg.title}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {latestRaw != null && (
              <span className="text-neutral-300 text-xs tabular-nums">{fmt(latestRaw, cfg.unit)}</span>
            )}
            {band ? <Badge band={band} /> : <span className="text-neutral-600 text-xs">无数据</span>}
          </div>
        </div>

        {/* 动量双线图例 */}
        {isMom && (
          <div className="mt-2 flex gap-3 text-[10px] text-neutral-500">
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: LINE }} /> SOXX 价
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: MA_LINE }} /> 125 日均线
            </span>
          </div>
        )}

        {hasChart ? (
          <div className="mt-3 flex gap-2">
            <div className="flex h-[104px] flex-col justify-between py-1 text-[10px] text-neutral-600 tabular-nums">
              <span>{fmt(hi, yUnit)}</span>
              <span>{fmt(lo, yUnit)}</span>
            </div>
            <div className="min-w-0 flex-1">
              <MiniChart lines={lines} lo={lo} hi={hi} unit={yUnit} />
              <div className="mt-1 flex justify-between text-[10px] text-neutral-600">
                <span>{lines[0].points[0]?.time}</span>
                <span>{lines[0].points.at(-1)?.time}</span>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-neutral-600 text-xs">暂无数据</p>
        )}
      </div>

      <p className="whitespace-pre-line text-neutral-400 text-sm leading-relaxed">{cfg.desc}</p>
    </section>
  );
}

/** 各子指标最近一年的聚合序列(归一分 + 原生值 + 动量双线,按 interval)。 */
function useSeries(data: SoxFngData, interval: Interval) {
  return useMemo(() => {
    const agg = (rows?: { date: string; value: number }[]) =>
      rows?.length ? aggregate(toLine(rows.slice(-WINDOW)), interval) : [];
    const scores: Record<string, LinePoint[]> = {};
    const raws: Record<string, LinePoint[]> = {};
    for (const p of SOX_FNG_PANES) {
      scores[p.key] = agg(data.series[p.key]);
      raws[p.key] = agg(data.raw[p.key]);
    }
    const momLines = { price: agg(data.momLines?.price), ma: agg(data.momLines?.ma) };
    return { scores, raws, momLines };
  }, [data, interval]);
}

export function SoxFngPanel({ interval }: { interval: Interval }) {
  const { data, error, isLoading } = useSoxFngData();
  const { scores, raws, momLines } = useSeries(data, interval);

  // Hero(今日快照)用未聚合的日频数据 —— 聚合会把日期改成周期起点,失真"本日"判断。
  // 迷你图仍用聚合后的 scores/raws(尊重 interval)。
  const rawIdx = data.series.index;
  const latest = rawIdx?.at(-1)?.value;
  const band = latest != null ? bandOf(latest) : undefined;
  const compDate = rawIdx?.at(-1)?.date;

  // 本日复合用了几条腿:某腿最新日频日期 != 复合日期 = 当天缺数据未计入(常见 put/call)。
  const SUB_KEYS = ['mom', 'hl', 'breadth', 'vol', 'safe', 'putcall'];
  const missingLegs = compDate ? SUB_KEYS.filter((k) => data.series[k]?.at(-1)?.date !== compDate) : [];
  const labelOf = (k: string) => SOX_FNG_PANES.find((p) => p.key === k)?.label ?? k;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-1 pb-10">
        {/* Hero:签名频谱 meter + 大数字 */}
        <section className="border-neutral-800 border-b pb-6">
          <div className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">半导体风险情绪温度计 · SOXX</div>

          {latest != null && band ? (
            <>
              <div className="mt-3 flex items-end gap-4">
                <div className="font-bold text-6xl leading-none tabular-nums" style={{ color: band.color }}>
                  {Math.round(latest)}
                </div>
                <div className="pb-1">
                  <div className="font-semibold text-lg" style={{ color: band.color }}>
                    {band.label}
                  </div>
                  <div className="text-neutral-500 text-xs">更新 {compDate}</div>
                  <div className={missingLegs.length ? 'text-amber-500 text-xs' : 'text-neutral-600 text-xs'}>
                    本日 {6 - missingLegs.length}/6 项
                    {missingLegs.length ? ` · 缺 ${missingLegs.map(labelOf).join('/')}` : ''}
                  </div>
                </div>
              </div>
              <Meter value={latest} />
            </>
          ) : (
            <p className="mt-3 text-neutral-500 text-sm">
              {isLoading ? '加载中…' : error ? `加载失败:${error.message}` : '暂无数据'}
            </p>
          )}
        </section>

        {/* 6 子指标:CNN 式左图右文(图为原生单位;动量为价+均线双线) */}
        <div className="mt-2">
          {SOX_FNG_PANES.filter((p) => p.key !== 'index').map((cfg) => (
            <IndicatorRow
              key={cfg.key}
              cfg={cfg}
              scorePts={scores[cfg.key] ?? []}
              rawPts={raws[cfg.key] ?? []}
              momLines={momLines}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
