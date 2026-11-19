// 自建横 tab 的内容:一列图(以后还有文字块),末尾一块整宽的「新建图表」。
// 新建 / 编辑都在本 tab 里打开编辑器(编的是这张图自己,每改一步存回 tab),点「完成」回到列表;完成时还是空图就不留。
import { useState } from 'react';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { Interval } from '../../hooks/interval';
import { DocChart } from '../../views/chartDoc/DocChart';
import { EMPTY_DOC, type ChartDoc } from '../../views/chartDoc/chartDoc';
import { ChartEditor } from '../editor';
import { type Block, type CustomTab, shortId } from './customTabs';

type Props = { tab: CustomTab; interval: Interval; onChange: (fn: (t: CustomTab) => CustomTab) => void };

export function CustomTabPage({ tab, interval, onChange }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const block = tab.blocks.find((b) => b.id === editing);

  const setBlocks = (fn: (bs: Block[]) => Block[]) => onChange((t) => ({ ...t, blocks: fn(t.blocks) }));
  const saveDoc = (id: string, doc: ChartDoc) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, doc } : b)));
  const remove = (id: string) => setBlocks((bs) => bs.filter((b) => b.id !== id));

  const create = () => {
    const id = shortId();
    setBlocks((bs) => [...bs, { id, kind: 'chart', doc: EMPTY_DOC }]);
    setEditing(id);
  };

  const done = () => {
    if (block && block.doc.panes.length === 0) remove(block.id);
    setEditing(null);
  };

  if (block) {
    return (
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <Button variant="outline" size="sm" onClick={done}>
            <ArrowLeft /> 完成
          </Button>
          <span>编辑「{tab.label}」里的图,改动自动保存</span>
        </div>
        <div className="min-h-0 flex-1">
          <ChartEditor
            key={block.id}
            interval={interval}
            store={{ initial: block.doc, save: (doc) => saveDoc(block.id, doc) }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {tab.blocks.map((b, i) => (
        <section key={b.id} className="flex h-[480px] flex-none flex-col rounded border border-neutral-800 p-2">
          <div className="flex items-center gap-1 pb-1">
            <span className="flex-1 truncate text-sm text-neutral-300">{b.doc.title ?? `图 ${i + 1}`}</span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(b.id)}>
              <Pencil /> 编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.confirm('删除这张图?') && remove(b.id)}
              className="hover:text-red-400"
            >
              <Trash2 /> 删除
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <DocChart doc={b.doc} interval={interval} />
          </div>
        </section>
      ))}
      <button
        type="button"
        onClick={create}
        className={cn(
          'flex flex-none flex-col items-center justify-center gap-2 rounded border border-dashed border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:bg-neutral-900 hover:text-neutral-50',
          tab.blocks.length ? 'h-24' : 'h-full',
        )}
      >
        <Plus className="size-6" />
        <span className="text-sm">新建图表</span>
      </button>
    </div>
  );
}
