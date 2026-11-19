// 全屏编辑页的草稿:编辑器每改一步回调到这里;和 tab 里现有的不同(dirty)就存 localStorage(刷新 / 误关后再打开问要不要恢复),
// 点完成 / 选保存才写回 tab。
import { useEffect, useRef, useState } from 'react';
import type { Ask } from '../../components/useChoice';
import { EMPTY_DOC, type ChartDoc, parseChartDoc } from '../../views/chartDoc/chartDoc';

function draftKey(id: string): string {
  return `mtv:chartDraft:${id}`;
}

function loadDraft(id: string): ChartDoc | null {
  try {
    const raw = localStorage.getItem(draftKey(id));

    return raw ? parseChartDoc(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** null = 删掉草稿 */
function storeDraft(id: string, doc: ChartDoc | null) {
  try {
    if (doc) localStorage.setItem(draftKey(id), JSON.stringify(doc));
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* 隐私模式 / 配额满:草稿存不上,只是刷新后恢复不了 */
  }
}

/** 图从 tab 里删掉时一起清(不然留着没人再问) */
export function clearDraft(id: string) {
  storeDraft(id, null);
}

function same(a: ChartDoc, b: ChartDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type AskFn = <T>(a: Ask<T>) => Promise<T>;

/**
 * saved = tab 里现有的这张(新建的还没有)。返回:
 * initial —— 编辑器起手的图(null = 还在问要不要恢复,问完才挂编辑器:它只读一次起手图);
 * commit —— 完成:有改动就写回;settle —— 要离开时有改动就问保存 / 不保存 / 继续编辑,返回能不能走
 */
export function useChartDraft(
  blockId: string,
  saved: ChartDoc | undefined,
  onCommit: (d: ChartDoc) => void,
  ask: AskFn,
) {
  const base = saved ?? EMPTY_DOC;
  const [initial, setInitial] = useState<ChartDoc | null>(() => {
    const d = loadDraft(blockId);

    return d && !same(d, base) ? null : base;
  });
  const [draft, setDraft] = useState(base);
  const dirty = !same(draft, base);

  // 回调里读最新的
  const latest = useRef({ draft, dirty, onCommit });
  const askedRef = useRef(false);

  useEffect(() => {
    latest.current = { draft, dirty, onCommit };
  });

  // 上次没保存的草稿:问一次(StrictMode 下 effect 跑两遍也只问一次)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时问
  useEffect(() => {
    if (initial || askedRef.current) return;
    askedRef.current = true;

    void ask({
      title: '这张图有上次没保存的修改',
      description: '可能是刷新或关掉页面前没点完成',
      choices: [
        { label: '丢弃', value: false },
        { label: '恢复', value: true, variant: 'default' },
      ],
      cancel: true,
    }).then((restore) => {
      const d = restore ? (loadDraft(blockId) ?? base) : base;

      if (!restore) storeDraft(blockId, null);
      setDraft(d);
      setInitial(d);
    });
  }, []);

  // 落盘(还在问恢复时别动:那时 draft 还是原图,会把要问的草稿删掉)
  useEffect(() => {
    if (initial) storeDraft(blockId, dirty ? draft : null);
  }, [initial, blockId, draft, dirty]);

  const commit = () => {
    const { draft: d, dirty: changed } = latest.current;

    if (changed) latest.current.onCommit(d);
    storeDraft(blockId, null);
  };

  const settle = async (): Promise<boolean> => {
    if (!latest.current.dirty) return true;

    const choice = await ask({
      title: '这张图有未保存的修改',
      choices: [
        { label: '继续编辑', value: 'stay' as const, variant: 'ghost' },
        { label: '不保存', value: 'discard' as const },
        { label: '保存', value: 'save' as const, variant: 'default' },
      ],
      cancel: 'stay' as const,
    });

    if (choice === 'stay') return false;
    if (choice === 'save') commit();
    else storeDraft(blockId, null);

    return true;
  };

  return { initial, dirty, setDraft, commit, settle };
}
