import { useYieldCurve, valueAt } from './yieldCurve.hooks';
import { useRegimeData } from '../regime/regimeChart.hooks';
import { InfoTip } from '../../components/InfoTip';
import { OIS_INPUT_TENORS, dotGaps, hikesPriced, oisForwards, type ForwardSegment } from '../../../shared/policyPath';

const DESC = [
  '定义:最新一天的 SOFR OIS(Eris)反推的分段远期,对照当前政策利率与最新一版 SEP 点阵图。',
  '「累计计入」= 该段远期 − SOFR 定盘值,÷ 25bp。基准不用区间中值(两者有几个 bp 的基差),',
  '也不用 Eris 的 SOFR1D(T+2 起息,会提前吃进下次会议)。',
  '点阵图对照在相邻两段中点之间插值取年底那一天的远期(直接取段平均会被段另一头的会议带偏)。',
  '点阵图对照把市场那边平移成中值口径(当前中值 + 远期 − SOFR)再比,正 = 市场比联储更鹰。',
  '',
  '⚠️ **近似值,精度约几 bp**:节点间隔约 3 个月,节点间按分段常数处理,相邻两次 FOMC 被抹平 ——',
  '只给累计次数,不拆单次会议(单会议概率看 CME FedWatch)。1Y 以上按年付息 bootstrap,更糙。',
  '⚠️ 点阵图只有最新一版(FRED 不留历史),不做回看。逐日的累计次数走势见「定价走势」tab。',
].join('\n');

// viewBox 坐标系,同 YieldCurveChart。
const W = 1000,
  H = 360,
  PAD_L = 46,
  PAD_R = 60,
  PAD_T = 16,
  PAD_B = 28;

const last = (rows: { date: string; value: number }[] | undefined) => rows?.at(-1);
const fmt = (v: number, d = 3) => v.toFixed(d);

function ForwardChart({
  segs,
  dots,
  lr,
  target,
}: {
  segs: ForwardSegment[];
  dots: { date: string; value: number }[];
  lr?: number;
  target?: [number, number];
}) {
  const t0 = Date.parse(segs[0].from);
  const t1 = Date.parse(segs.at(-1)!.to);
  const xOf = (d: string) => PAD_L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);

  const vals = [...segs.map((s) => s.rate), ...dots.map((d) => d.value), ...(lr ? [lr] : []), ...(target ?? [])];
  const pad = (Math.max(...vals) - Math.min(...vals)) * 0.08 || 0.1;
  const lo = Math.min(...vals) - pad,
    hi = Math.max(...vals) + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

  const step = segs.map((s, i) => `${i ? 'V' : `M${xOf(s.from)},`}${yOf(s.rate)}H${xOf(s.to)}`).join('');
  const grid = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * k) / 4);
  const firstYear = Number(segs[0].from.slice(0, 4)) + 1;
  const years = Array.from({ length: Number(segs.at(-1)!.to.slice(0, 4)) - firstYear + 1 }, (_, k) => firstYear + k);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
      {grid.map((v) => (
        <g key={v}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(v)} y2={yOf(v)} stroke="#262626" />
          <text x={PAD_L - 6} y={yOf(v) + 3} textAnchor="end" fontSize={11} fill="#737373">
            {v.toFixed(2)}%
          </text>
        </g>
      ))}
      {years.map((y) => (
        <text key={y} x={xOf(`${y}-01-01`)} y={H - 8} textAnchor="middle" fontSize={11} fill="#737373">
          {y}
        </text>
      ))}
      {target && (
        <rect
          x={PAD_L}
          width={W - PAD_L - PAD_R}
          y={yOf(target[1])}
          height={yOf(target[0]) - yOf(target[1])}
          fill="rgba(148,163,184,0.15)"
        />
      )}
      {lr !== undefined && (
        <g>
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(lr)} y2={yOf(lr)} stroke="#a78bfa" strokeDasharray="5 4" />
          <text x={W - PAD_R + 4} y={yOf(lr) + 4} fontSize={11} fill="#a78bfa">
            长期 {lr}
          </text>
        </g>
      )}
      <path d={step} fill="none" stroke="#38bdf8" strokeWidth={2} />
      {dots.map((d) => (
        <g key={d.date}>
          <circle cx={xOf(d.date)} cy={yOf(d.value)} r={5} fill="#f59e0b" />
          <text x={xOf(d.date)} y={yOf(d.value) - 9} textAnchor="middle" fontSize={11} fill="#f59e0b">
            {d.value}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function PolicyPathPanel() {
  const ois = useYieldCurve('sofr_ois');
  const regime = useRegimeData();

  if (ois.error || regime.error)
    return <div className="flex h-full items-center justify-center text-red-400">加载失败</div>;
  if (ois.isLoading || regime.isLoading)
    return <div className="flex h-full items-center justify-center text-neutral-500">加载中…</div>;

  const asOf = ois.maxDate;
  const par = Object.fromEntries(
    OIS_INPUT_TENORS.flatMap((t) => {
      const v = asOf ? valueAt(ois.data.series[t], asOf) : null;
      return v === null ? [] : [[t, v]];
    }),
  );
  const base = asOf ? regime.data.series.sofr?.findLast((p) => p.date <= asOf)?.value : undefined;
  const segs = asOf ? oisForwards(par, asOf) : [];
  if (!asOf || base === undefined || !segs.length)
    return <div className="flex h-full items-center justify-center text-amber-500">暂无 SOFR OIS / SOFR 定盘数据</div>;

  const s = regime.data.series;
  const upper = last(s.fedTargetUpper)?.value;
  const lower = last(s.fedTargetLower)?.value;
  const target: [number, number] | undefined = upper !== undefined && lower !== undefined ? [lower, upper] : undefined;
  const lr = last(s.sepMedianLr);
  const dots = (s.sepMedian ?? []).filter((d) => d.date >= asOf);
  const gaps = target ? dotGaps(segs, dots, { base, mid: (target[0] + target[1]) / 2 }) : [];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
        <span className="flex items-center gap-0.5 rounded border border-neutral-700 px-1 py-0.5 text-neutral-300">
          加息定价
          <InfoTip text={DESC} />
        </span>
        <span>OIS {asOf}</span>
        <span>目标区间 {target ? `${fmt(target[0], 2)}–${fmt(target[1], 2)}` : '—'}</span>
        <span>SOFR 定盘 {fmt(base, 2)}(基准)</span>
        <span>点阵图 {lr ? `${lr.date} 版` : '—'}</span>
        <span className="text-amber-500/80">近似值,精度约几 bp</span>
      </div>

      <div className="h-80 shrink-0">
        <ForwardChart segs={segs} dots={dots} lr={lr?.value} target={target} />
      </div>

      <div className="grid gap-4 text-xs tabular-nums md:grid-cols-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-neutral-500">
              <th className="px-2 py-1 text-left font-normal">区间</th>
              <th className="px-2 py-1 text-right font-normal">远期</th>
              <th className="px-2 py-1 text-right font-normal">累计计入(次)</th>
            </tr>
          </thead>
          <tbody>
            {segs.map((g) => (
              <tr key={g.toTenor} className="border-t border-neutral-800 text-neutral-300">
                <td className="px-2 py-1">
                  {g.fromTenor}–{g.toTenor}
                </td>
                <td className="px-2 py-1 text-right">{fmt(g.rate)}%</td>
                <td className="px-2 py-1 text-right">{fmt(hikesPriced(g.rate, base), 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="w-full self-start border-collapse">
          <thead>
            <tr className="text-neutral-500">
              <th className="px-2 py-1 text-left font-normal">年底</th>
              <th className="px-2 py-1 text-right font-normal">点阵图中值</th>
              <th className="px-2 py-1 text-right font-normal">市场隐含(中值口径)</th>
              <th className="px-2 py-1 text-right font-normal">差(bp)</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((g) => (
              <tr key={g.date} className="border-t border-neutral-800 text-neutral-300">
                <td className="px-2 py-1">{g.date.slice(0, 4)}</td>
                <td className="px-2 py-1 text-right">{fmt(g.dot, 2)}%</td>
                <td className="px-2 py-1 text-right">{fmt(g.market)}%</td>
                <td className={`px-2 py-1 text-right ${g.gapBp > 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {g.gapBp > 0 ? '+' : ''}
                  {fmt(g.gapBp, 0)} {g.gapBp > 0 ? '市场更鹰' : '市场更鸽'}
                </td>
              </tr>
            ))}
            {lr && (
              <tr className="border-t border-neutral-800 text-neutral-500">
                <td className="px-2 py-1">长期</td>
                <td className="px-2 py-1 text-right">{fmt(lr.value, 2)}%</td>
                <td className="px-2 py-1 text-right" colSpan={2}>
                  不对照(OIS 远端含期限溢价)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
