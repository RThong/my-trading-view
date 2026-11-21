// 「踩踏监控」页内共用的配色与小组件。明暗只用 neutral-*(浅色主题靠翻 neutral 色阶);
// 强调色取 styles.css 里浅色主题会换深色号的那几档(red-400 / amber-400 / green-400 / sky-300),暖白底上不发虚。
import type { ReactNode } from 'react';
import type { Stage } from '../../../shared/calc/stampede';
import { cn } from '../../lib/utils';
import type { Level } from './dims';

export type Tone = 'red' | 'amber' | 'green' | 'blue';

export const TONE: Record<Tone, { text: string; dot: string; soft: string; border: string; fill: string }> = {
  red: {
    text: 'text-red-400',
    dot: 'bg-red-500',
    soft: 'bg-red-500/10',
    border: 'border-red-500/50',
    fill: 'bg-red-500/20',
  },
  amber: {
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    soft: 'bg-amber-400/10',
    border: 'border-amber-400/50',
    fill: 'bg-amber-400/20',
  },
  green: {
    text: 'text-green-400',
    dot: 'bg-green-500',
    soft: 'bg-green-500/10',
    border: 'border-green-500/50',
    fill: 'bg-green-500/20',
  },
  blue: {
    text: 'text-sky-300',
    dot: 'bg-sky-500',
    soft: 'bg-sky-500/10',
    border: 'border-sky-500/50',
    fill: 'bg-sky-500/20',
  },
};

export const STAGE_TONE: Record<Stage, Tone> = { 1: 'green', 2: 'amber', 3: 'red', 4: 'blue' };

/** 亮灯 → 配色与标签;undefined = 没数据 */
export function levelTone(l: Level | undefined): { tone: Tone; text: string } | null {
  if (l === undefined) return null;
  if (l === 'red') return { tone: 'red', text: '触发红线' };
  return l === 'yellow' ? { tone: 'amber', text: '警戒' } : { tone: 'green', text: '正常' };
}

export function scoreTone(score: number): Tone | null {
  if (!Number.isFinite(score)) return null;
  return score >= 67 ? 'red' : score >= 34 ? 'amber' : 'green';
}

// 做市商卡里付鹏原有、我们没有数据的两行,灰掉
export const GHOST_ROWS = [
  { name: 'SPX Dealer Agg Gamma', note: '付鹏:历史底线 −8.6 $B / 零轴翻转' },
  { name: 'Estimated Net Delta Flow', note: '付鹏:零轴平衡点(负值 = 机械卖出对冲)' },
];

export const CARD = 'rounded-lg border border-neutral-800 bg-neutral-900/40 p-4';

export function md(date?: string) {
  return date?.slice(5) ?? '';
}

export function fmt(v: number | undefined, digits: number) {
  return v !== undefined && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

/** 小徽标:卡头右上那种带边框的状态字 */
export function Pill({ tone, children, className }: { tone: Tone | null; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tone ? [TONE[tone].soft, TONE[tone].text, TONE[tone].border] : 'border-neutral-700 text-neutral-500',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 区块标题:左侧一道竖条 */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-bold text-neutral-100">
        <span className="h-4 w-1 rounded-full bg-sky-500" />
        {children}
      </h2>
      {right}
    </div>
  );
}
