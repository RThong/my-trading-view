// 「踩踏监控」三张图卡(照付鹏原页):期限结构折线、P/C 对红线柱状、做市商敞口。小图用内联 SVG / div 画,不引图表库。
import type { ReactNode } from 'react';
import { InfoTip } from '../../components/InfoTip';
import { cn } from '../../lib/utils';
import { GEX_PCTL, RED_LINES } from '../../../shared/calc/stampede';
import { DIMS, type Level } from './dims';
import { CARD, fmt, GHOST_ROWS, levelTone, md, Pill, TONE } from './ui';
import type { Reading, View } from './view';

// 期限结构图的几何(viewBox 坐标)
const W = 320;
const H = 170;
const PAD = { l: 30, r: 14, t: 10, b: 26 };
const VANNA = RED_LINES.vix;

function CardHead({ title, sub, badge }: { title: string; sub: string; badge: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div>
        <h3 className="text-sm font-bold text-neutral-100">{title}</h3>
        <p className="mt-0.5 text-[11px] text-neutral-500">{sub}</p>
      </div>
      {badge}
    </div>
  );
}

export function TermCard({ v }: { v: View }) {
  const est = v.template ? '(推算)' : '';
  const pts = [
    { label: 'VIX9D(9 天)', foot: `VIX9D${est}`, value: v.read.vix9d?.value ?? NaN },
    { label: 'VIX(30 天)', foot: 'VIX(30 天基准)', value: v.read.vix?.value ?? NaN },
    { label: 'VIX3M(3 个月)', foot: `VIX3M${est}`, value: v.read.vix3m?.value ?? NaN },
  ];
  const known = pts.filter((p) => Number.isFinite(p.value)).map((p) => p.value);
  // 两个比值都有才判升 / 倒挂;缺一个就不出徽标,别把缺数当成正常升水
  const ratios = [v.read.vixVix3m?.value ?? NaN, v.read.vix9dVix?.value ?? NaN];
  const complete = ratios.every(Number.isFinite);
  const back = ratios.some((r) => r > 1);
  const tone = back ? 'red' : 'green';

  // 纵轴至少 10–40(同原页),值出界就按 5 的倍数放宽
  const lo = Math.min(10, Math.floor((Math.min(...known) - 2) / 5) * 5);
  const hi = Math.max(40, Math.ceil((Math.max(...known) + 2) / 5) * 5);
  const ticks = Array.from({ length: Math.floor((hi - lo) / 5) + 1 }, (_, i) => lo + i * 5);
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * (i + 0.5)) / pts.length;
  const y = (val: number) => PAD.t + ((hi - val) / (hi - lo)) * (H - PAD.t - PAD.b);
  const xy = pts.flatMap((p, i) => (Number.isFinite(p.value) ? [{ x: x(i), y: y(p.value) }] : []));
  const line = xy.map((p) => `${p.x},${p.y}`).join(' ');
  const area = xy.length > 1 ? `${xy[0].x},${y(lo)} ${line} ${xy.at(-1)!.x},${y(lo)}` : '';

  return (
    <div className={cn(CARD, 'flex flex-col')}>
      <CardHead
        title="波动率期限结构曲线"
        sub={`VIX9D / VIX / VIX3M${v.template ? '(由模板比值反推)' : ''},虚线为 ${VANNA}.0 Vanna 阈值`}
        badge={complete ? <Pill tone={tone}>{back ? 'Backwardation 倒挂' : 'Contango 升水'}</Pill> : null}
      />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" role="img" aria-label="波动率期限结构">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-neutral-800" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-neutral-500 text-[9px]">
              {t}
            </text>
          </g>
        ))}
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={y(VANNA)}
          y2={y(VANNA)}
          className="stroke-neutral-500"
          strokeWidth={1.2}
          strokeDasharray="5 4"
        />
        <g className={TONE[tone].text}>
          {area && <polygon points={area} fill="currentColor" fillOpacity={0.08} />}
          <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2.2} />
          {xy.map((p) => (
            <circle
              key={p.x}
              cx={p.x}
              cy={p.y}
              r={4}
              className="fill-neutral-950"
              stroke="currentColor"
              strokeWidth={2}
            />
          ))}
        </g>
        {pts.map((p, i) => (
          <text key={p.label} x={x(i)} y={H - 8} textAnchor="middle" className="fill-neutral-400 text-[9px]">
            {p.label}
          </text>
        ))}
      </svg>
      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-neutral-800 pt-2 text-center">
        {pts.map((p) => (
          <div key={p.foot}>
            <div className="text-[11px] text-neutral-500">{p.foot}</div>
            <div className="text-xs font-bold tabular-nums text-neutral-200">{fmt(p.value, 1)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 柱子配色照原页:个股灰、全市场橙、指数蓝
const FLOW_BARS = [
  { key: 'pcEquity', label: '个股 P/C', red: RED_LINES.pcEquity, color: 'bg-neutral-500' },
  { key: 'pcTotal', label: '全市场 P/C', red: RED_LINES.pcTotal, color: 'bg-orange-500' },
  { key: 'pcIndex', label: '指数 P/C', red: RED_LINES.pcIndex, color: 'bg-blue-500' },
];
const FLOW_DIM = DIMS.findIndex((d) => d.title === '期权流量');

export function FlowCard({ v, levels }: { v: View; levels: (Level | undefined)[][] }) {
  const [eqLevel, totalLevel] = levels[FLOW_DIM];
  const vals = FLOW_BARS.map((b) => v.read[b.key]?.value ?? NaN);
  const top = Math.max(1.6, ...vals.filter(Number.isFinite));
  // 徽标与结构特征:升级灯 → 全面防御;个股或全市场过黄线 → 个股先行;否则平稳(都用页面同一套判定)
  const state = !vals.some(Number.isFinite)
    ? null
    : v.escalate.on
      ? { tone: 'red' as const, badge: '宏观全面防御', text: '个股与指数共振,全面防御模式落地' }
      : eqLevel || totalLevel
        ? { tone: 'amber' as const, badge: '个股率先发力', text: '接近 2022 年初个股率先抬头特征' }
        : { tone: 'green' as const, badge: '结构平稳', text: '个股 Call 拥挤,指数常规对冲' };
  const pcDate = v.read.pcIndex?.date;

  return (
    <div className={cn(CARD, 'flex flex-col')}>
      <CardHead
        title="期权流量扩散对比(CBOE Put/Call)"
        sub={`当前量能比 vs 风险扩散红线(${[RED_LINES.pcEquity, RED_LINES.pcTotal, RED_LINES.pcIndex].map((x) => x.toFixed(2)).join(' / ')})`}
        badge={state && <Pill tone={state.tone}>{state.badge}</Pill>}
      />
      <div className="flex h-44 flex-1 items-end justify-around gap-3 border-b border-neutral-800 px-2">
        {FLOW_BARS.map((b, i) => (
          <div key={b.key} className="flex h-full flex-1 items-end justify-center gap-1.5">
            <div className="flex h-full w-7 flex-col justify-end">
              <span className="mb-0.5 text-center text-[10px] tabular-nums text-neutral-300">{fmt(vals[i], 2)}</span>
              <div
                className={cn('rounded-t', b.color)}
                style={{ height: `${Number.isFinite(vals[i]) ? (vals[i] / top) * 85 : 0}%` }}
              />
            </div>
            <div className="flex h-full w-7 flex-col justify-end">
              <span className="mb-0.5 text-center text-[10px] tabular-nums text-red-400">{b.red.toFixed(2)}</span>
              <div
                className="rounded-t border border-dashed border-red-500 bg-red-500/15"
                style={{ height: `${(b.red / top) * 85}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-around text-[11px] text-neutral-400">
        {FLOW_BARS.map((b) => (
          <span key={b.key}>{b.label}</span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-800 pt-2 text-[11px] text-neutral-500">
        <span>
          结构特征:<strong className="text-neutral-300">{state?.text ?? '暂无数据'}</strong>
        </span>
        <span className="shrink-0 tabular-nums">
          {pcDate ? `P/C 截至 ${md(pcDate)}(晚一天发)` : `基准红线 ${RED_LINES.pcIndex.toFixed(2)}`}
        </span>
      </div>
    </div>
  );
}

/** 0–100 分位条:左端红区、黄区(见 GEX_PCTL),圆点 = 当前分位 */
function PctlGauge({ pctl, tone }: { pctl: number | null; tone: string | null }) {
  return (
    <div className="relative h-5 overflow-hidden rounded border border-neutral-800 bg-neutral-900">
      <div className="absolute inset-y-0 left-0 bg-red-500/25" style={{ width: `${GEX_PCTL.red}%` }} />
      <div
        className="absolute inset-y-0 bg-amber-400/15"
        style={{ left: `${GEX_PCTL.red}%`, width: `${GEX_PCTL.yellow - GEX_PCTL.red}%` }}
      />
      <div className="absolute inset-y-0 left-1/2 border-l border-neutral-600" />
      {pctl !== null && (
        <div
          className={cn('absolute inset-y-0.5 rounded-sm opacity-80', tone ?? 'bg-neutral-500')}
          style={{ left: 0, width: `${Math.max(pctl, 1)}%` }}
        />
      )}
    </div>
  );
}

export function DealerCard({ v, gexLevel }: { v: View; gexLevel: Level | undefined }) {
  const r: Reading | undefined = v.read.gex;
  const pctl = r && Number.isFinite(r.pctl) ? r.pctl : null;
  const lt = levelTone(gexLevel);
  const badge = lt
    ? { red: `GEX 低位(≤ P${GEX_PCTL.red})`, amber: `GEX 偏低(≤ P${GEX_PCTL.yellow})`, green: 'GEX 正常' }[
        lt.tone as 'red' | 'amber' | 'green'
      ]
    : '无数据';
  const valText =
    r && Number.isFinite(r.value) ? `${fmt(r.value, 1)} 亿美元 / 点` : pctl !== null ? `模板 P${pctl}` : '—';

  return (
    <div className={cn(CARD, 'flex flex-col')}>
      <CardHead
        title="做市商敞口水位"
        sub="Squeezemetrics GEX,按自身滚动 5 年分位读"
        badge={<Pill tone={lt?.tone ?? null}>{badge}</Pill>}
      />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center font-semibold text-neutral-300">
              SPX Gamma Exposure(GEX)
              <InfoTip
                text={`付鹏原卡的 GEX 是 $B 朴素口径(−50B 红线、±130B 刻度),和 Squeezemetrics 不同,不适用。\n这里只看它在自身滚动 5 年里的分位:≤ P${GEX_PCTL.red} 记红、≤ P${GEX_PCTL.yellow} 记黄。`}
              />
            </span>
            <span className={cn('font-bold tabular-nums', lt ? TONE[lt.tone].text : 'text-neutral-500')}>
              {valText}
            </span>
          </div>
          <PctlGauge pctl={pctl} tone={lt ? TONE[lt.tone].dot : null} />
          <div className="flex justify-between text-[10px] tabular-nums text-neutral-500">
            <span className="text-red-400">P{GEX_PCTL.red} 红线</span>
            <span>P50</span>
            <span>P100 高位</span>
          </div>
        </div>
        {GHOST_ROWS.map((g) => (
          <div key={g.name} className="space-y-1.5 opacity-50">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-neutral-400">{g.name}</span>
              <span className="text-neutral-500">无数据</span>
            </div>
            <div className="h-5 rounded border border-dashed border-neutral-700" />
            <div className="text-[10px] text-neutral-500">{g.note}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-2 text-[11px] text-neutral-500">
        <span>当前分位</span>
        <strong className="tabular-nums text-neutral-300">{pctl === null ? '—' : `P${Math.round(pctl)}`}</strong>
      </div>
    </div>
  );
}
