import { useState } from 'react';

export type Curve = { date: string; label: string; color: string; values: (number | null)[] };

// viewBox 坐标系(等比缩放填充 pane)。左留 y 轴刻度、下留期限标签。
const W = 1000,
  H = 420,
  PAD_L = 46,
  PAD_R = 18,
  PAD_T = 16,
  PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const xOf = (i: number, n: number) => PAD_L + (n <= 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));

/** 收益曲线折线图:x = 期限(序数均匀排开),多条曲线 = 多个日期。hover 竖线 + 左上读值。 */
export function YieldCurveChart({ tenors, curves }: { tenors: string[]; curves: Curve[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const all = curves.flatMap((c) => c.values.filter((v): v is number => v != null));
  if (!all.length) return <div className="flex h-full items-center justify-center text-neutral-500">无数据</div>;

  const lo = Math.min(...all),
    hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 0.1; // 上下留白;全平时给个默认幅度
  const min = lo - pad,
    max = hi + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * PLOT_H;

  const n = tenors.length;
  const gridVals = Array.from({ length: 5 }, (_, k) => min + ((max - min) * k) / 4);
  const focus = hover ?? n - 1; // 默认聚焦最右(长端)

  // 一条曲线拆成连续段(遇 null 断开),各段一条 polyline。
  const segments = (values: (number | null)[]): string[] =>
    values
      .reduce<{ i: number; v: number }[][]>((segs, v, i) => {
        if (v == null) {
          if (segs.length && segs[segs.length - 1].length) segs.push([]);
        } else {
          if (!segs.length) segs.push([]);
          segs[segs.length - 1].push({ i, v });
        }
        return segs;
      }, [])
      .filter((s) => s.length)
      .map((s) => s.map((p) => `${xOf(p.i, n)},${yOf(p.v)}`).join(' '));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const f = (px - PAD_L) / PLOT_W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
  };

  return (
    <div className="relative h-full w-full">
      {/* 左上读值框:显示聚焦期限下各曲线的收益率 */}
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-neutral-900/85 px-2 py-1.5 text-xs">
        {curves.map((c, ci) => (
          <div key={ci} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />
            <span className="text-neutral-400">{c.label}</span>
            <span className="tabular-nums font-medium" style={{ color: c.color }}>
              {c.values[focus] != null ? `${c.values[focus]!.toFixed(3)}%` : '—'}
            </span>
          </div>
        ))}
        <div className="mt-0.5 text-[10px] text-neutral-500">{tenors[focus]} · 期限</div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* y 网格 + 刻度 */}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yOf(v)} y2={yOf(v)} stroke="#262626" strokeWidth={1} />
            <text x={PAD_L - 6} y={yOf(v) + 3} textAnchor="end" fontSize={11} fill="#737373">
              {v.toFixed(2)}%
            </text>
          </g>
        ))}
        {/* x 期限标签 */}
        {tenors.map((t, i) => (
          <text key={t} x={xOf(i, n)} y={H - 10} textAnchor="middle" fontSize={11} fill="#737373">
            {t}
          </text>
        ))}
        {/* hover 竖线 */}
        {hover != null && (
          <line
            x1={xOf(hover, n)}
            x2={xOf(hover, n)}
            y1={PAD_T}
            y2={PAD_T + PLOT_H}
            stroke="#525252"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {/* 曲线 + 点 */}
        {curves.map((c, ci) => (
          <g key={ci}>
            {segments(c.values).map((pts, k) => (
              <polyline key={k} points={pts} fill="none" stroke={c.color} strokeWidth={1.8} />
            ))}
            {c.values.map(
              (v, i) =>
                v != null && <circle key={i} cx={xOf(i, n)} cy={yOf(v)} r={i === focus ? 3.5 : 2.4} fill={c.color} />,
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
