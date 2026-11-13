// 编辑器的撤销 / 重做:存整份文档的快照,不做命令模式 —— ChartDoc 只有几 KB 且不可变更新,没改的部分新旧版本共用引用,
// 存 100 份也便宜;撤销 = 换回上一份,不用给每种编辑写反操作。设计见 docs/chart-editor-design.md「撤销 / 重做」。
import type { ChartDoc, Drawing } from '../../views/chartDoc/chartDoc';

/** 一步:那一刻的文档 + 这一步做了什么(撤销 / 重做按钮的提示,同 TradingView 的「Undo remove trendline」) */
export type Step = { doc: ChartDoc; label: string };

/**
 * past 栈顶 = 撤销后回到的文档 + 被撤掉的那一步;future 栈顶 = 重做后到的文档 + 要重做的那一步。
 * mergeKey / at:上一步的合并键与时间,连续改同一处(拖取色器)在 MERGE_MS 内并成一步
 */
export type History = { past: Step[]; doc: ChartDoc; future: Step[]; mergeKey?: string; at?: number };

const LIMIT = 100;
const MERGE_MS = 500;

export function initHistory(doc: ChartDoc): History {
  return { past: [], doc, future: [] };
}

/**
 * 记一步。编辑没改动文档(纯函数对非法输入返回原文档)就不记;同一合并键、离上一步不到 MERGE_MS 就并进上一步
 * (撤销直接回到这串连续改动之前)。任何新的一步都清空 future,同 TradingView
 */
export function commit(h: History, next: ChartDoc, label: string, now: number, mergeKey?: string): History {
  if (next === h.doc) return h;
  if (mergeKey && h.mergeKey === mergeKey && h.at !== undefined && now - h.at < MERGE_MS) {
    return { ...h, doc: next, future: [], at: now };
  }

  return { past: [...h.past, { doc: h.doc, label }].slice(-LIMIT), doc: next, future: [], mergeKey, at: now };
}

export function undo(h: History): History {
  const last = h.past.at(-1);
  if (!last) return h;

  return { past: h.past.slice(0, -1), doc: last.doc, future: [{ doc: h.doc, label: last.label }, ...h.future] };
}

export function redo(h: History): History {
  const [next, ...rest] = h.future;
  if (!next) return h;

  return { past: [...h.past, { doc: h.doc, label: next.label }], doc: next.doc, future: rest };
}

// 改一条画线时这一步叫什么:按字段查表,第一个变了的字段定名;都没命中(加框、延伸、对数之类)就叫「修改画线」
const DRAWING_EDITS: { keys: string[]; label: (d: Drawing) => string; merge?: true }[] = [
  { keys: ['locked'], label: (d) => (d.locked ? '锁定画线' : '解锁画线') },
  // 取色器拖动时连续触发:并成一步
  { keys: ['color'], label: () => '改画线颜色', merge: true },
  { keys: ['dash'], label: () => '改线型' },
  { keys: ['text'], label: () => '改文字' },
  { keys: ['a', 'b', 'c', 'time', 'value'], label: () => '移动画线' },
];

export function drawingEditLabel(prev: Drawing | undefined, next: Drawing): { label: string; mergeKey?: string } {
  const p: Record<string, unknown> = prev ?? {};
  const n: Record<string, unknown> = next;
  const hit = DRAWING_EDITS.find((e) => e.keys.some((k) => JSON.stringify(p[k]) !== JSON.stringify(n[k])));
  if (!hit) return { label: '修改画线' };

  return { label: hit.label(next), ...(hit.merge && { mergeKey: `drawing-${hit.keys[0]}:${next.id}` }) };
}
