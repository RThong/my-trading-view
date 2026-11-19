// 自建横 tab 的内容:一列只读图(以后还有文字块),末尾一块整宽的「新建图表」。
// 编辑 / 新建都跳到全屏编辑页(CustomChartEditor,由 App 接管整页);回来时滚到刚编辑的那张。
import { useEffect } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { Interval } from '../../hooks/interval';
import { DocChart } from '../../views/chartDoc/DocChart';
import { type CustomTab, shortId } from './customTabs';
import { clearDraft } from './useChartDraft';

type Props = {
  tab: CustomTab;
  interval: Interval;
  onChange: (fn: (t: CustomTab) => CustomTab) => void;
  /** 打开全屏编辑(新建的给一个新 id,完成时才存进 tab) */
  onEdit: (blockId: string) => void;
  /** 刚编辑完的那张 */
  focus: { id: string } | null;
};

function anchor(id: string): string {
  return `chart-${id}`;
}

export function CustomTabPage({ tab, interval, onChange, onEdit, focus }: Props) {
  const remove = (id: string) => {
    onChange((t) => ({ ...t, blocks: t.blocks.filter((b) => b.id !== id) }));
    clearDraft(id);
  };

  useEffect(() => {
    if (focus) document.getElementById(anchor(focus.id))?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {tab.blocks.map((b, i) => (
        <section
          key={b.id}
          id={anchor(b.id)}
          className="flex h-[480px] flex-none flex-col rounded border border-neutral-800 p-2"
        >
          <div className="flex items-center gap-1 pb-1">
            <span className="flex-1 truncate text-sm text-neutral-300">{b.doc.title ?? `图 ${i + 1}`}</span>
            <Button variant="ghost" size="sm" onClick={() => onEdit(b.id)}>
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
            {/* 只读图拿的是初始那份的副本(眼睛按钮等只改副本):编辑完换了图要重挂,按内容做 key */}
            <DocChart key={JSON.stringify(b.doc)} doc={b.doc} interval={interval} openable={false} />
          </div>
        </section>
      ))}
      <button
        type="button"
        onClick={() => onEdit(shortId())}
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
