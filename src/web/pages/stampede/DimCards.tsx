// 「踩踏监控」五维度卡片(照付鹏原页版式):每行 色点 · 名称 + 红线小字 · 数值框 · 状态标签 · 分位横条。
// 横条只显示(不做拖动推演):滚动 5 年分位 0–100,圆点 = 当前分位,细竖线 = 付鹏红线在 2018 起历史上的分位。
import { cn } from '../../lib/utils';
import { DIMS, type Level, type Metric } from './dims';
import { CARD, fmt, GHOST_ROWS, levelTone, scoreTone, TONE } from './ui';
import type { Reading } from './view';

const DEALER_DIM = DIMS.findIndex((d) => d.title === '做市商');

function signed(v: number | undefined, digits: number) {
  return v !== undefined && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}` : '—';
}

function hoverText(m: Metric, r: Reading | undefined, template: boolean) {
  if (!r) return '暂无数据';
  const pctl = Number.isFinite(r.pctl) ? Math.round(r.pctl) : '—';
  if (template) return `模板值 ${fmt(r.value, m.digits)}\n分位 ${pctl}(按当前实盘序列最近 5 年分布)`;
  return `原值 ${fmt(r.value, m.digits)}(${r.date})\n分位 ${pctl}\n20 日变化 ${signed(r.chg20, m.digits)}`;
}

function MetricRow({ m, r, level, template }: { m: Metric; r?: Reading; level?: Level; template: boolean }) {
  const lt = levelTone(level);
  const pctl = r && Number.isFinite(r.pctl) ? r.pctl : null;
  // 模板的 GEX 只给分位,没有原值
  const box = r && Number.isFinite(r.value) ? fmt(r.value, m.digits) : pctl !== null ? `P${pctl}` : '—';

  return (
    <div className="border-t border-neutral-800 py-2.5 first:border-t-0 first:pt-0" title={hoverText(m, r, template)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', lt ? TONE[lt.tone].dot : 'bg-neutral-600')} />
            <span className="truncate text-xs font-semibold text-neutral-200">{m.label}</span>
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-neutral-500">{m.red}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="w-20 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-right text-xs font-bold tabular-nums text-neutral-100">
            {box}
          </span>
          <span
            className={cn(
              'w-14 rounded border px-1.5 py-0.5 text-center text-[10px] font-semibold whitespace-nowrap',
              lt
                ? [TONE[lt.tone].soft, TONE[lt.tone].text, TONE[lt.tone].border]
                : 'border-neutral-700 text-neutral-500',
            )}
          >
            {lt ? lt.text : '无数据'}
          </span>
        </div>
      </div>
      <div className="relative h-1 rounded-full bg-neutral-800">
        {m.redPctl !== undefined && (
          <span className="absolute -top-1 h-3 w-px bg-red-500/80" style={{ left: `${m.redPctl}%` }} />
        )}
        {pctl !== null && (
          <span
            className={cn(
              'absolute -top-[5px] h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-neutral-950',
              lt ? TONE[lt.tone].dot : 'bg-neutral-400',
            )}
            style={{ left: `${pctl}%` }}
          />
        )}
      </div>
    </div>
  );
}

function GhostRow({ name, note }: { name: string; note: string }) {
  return (
    <div className="border-t border-neutral-800 py-2.5 opacity-50">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-600" />
            <span className="truncate text-xs font-semibold text-neutral-400">{name}</span>
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-neutral-500">{note}</div>
        </div>
        <span className="w-14 rounded border border-neutral-700 px-1.5 py-0.5 text-center text-[10px] text-neutral-500">
          无数据
        </span>
      </div>
      <div className="h-1 rounded-full bg-neutral-800" />
    </div>
  );
}

/** 维度分 + 缺数提示(只按有数据的指标平均) */
export function Score({ score, missing, size = 'lg' }: { score: number; missing: number; size?: 'lg' | 'xl' }) {
  const tone = scoreTone(score);
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <span
        className={cn(
          'font-bold tabular-nums leading-none',
          size === 'xl' ? 'text-2xl' : 'text-lg',
          tone ? TONE[tone].text : 'text-neutral-500',
        )}
      >
        {Number.isFinite(score) ? score : '—'}
      </span>
      {missing > 0 && <span className="text-[10px] text-neutral-500">缺 {missing} 项</span>}
    </span>
  );
}

export function DimCards({
  read,
  levels,
  scores,
  template,
}: {
  read: Partial<Record<string, Reading>>;
  levels: (Level | undefined)[][];
  scores: number[];
  template: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {DIMS.map((d, i) => (
        <section key={d.title} className={CARD}>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-bold tracking-wide text-neutral-100">
                {'一二三四五'[i]}、{d.full}
              </h3>
              <p className="mt-0.5 text-[11px] text-neutral-500">{d.desc}</p>
            </div>
            <Score score={scores[i]} missing={levels[i].filter((l) => l === undefined).length} />
          </div>
          {d.metrics.map((m, j) => (
            <MetricRow key={m.key} m={m} r={read[m.key]} level={levels[i][j]} template={template} />
          ))}
          {i === DEALER_DIM && GHOST_ROWS.map((g) => <GhostRow key={g.name} {...g} />)}
        </section>
      ))}
    </div>
  );
}
