// 自建 tab 里一张图的全屏编辑页(地址 #/c/<视角>/<tab>/<图 id>,竖横 tab 栏都收起,只留顶栏)。
// 草稿见 useChartDraft(点完成才写回 tab),历史 / 后退 / 离开确认见 useEditHistory;这里只组装顶栏和编辑器。
import type { ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useChoice } from '../../components/useChoice';
import type { Interval } from '../../hooks/interval';
import type { ChartDoc } from '../../views/chartDoc/chartDoc';
import { ChartEditor } from '../editor';
import { useChartDraft } from './useChartDraft';
import { useEditHistory } from './useEditHistory';

type Props = {
  blockId: string;
  /** tab 里现有的这张图;新建的还没有 */
  saved: ChartDoc | undefined;
  /** 返回按钮上的「视角 › 标签」 */
  crumb: string;
  interval: Interval;
  /** 顶栏(App 的 Header):编辑页往左边塞返回、右边塞完成 */
  header: (slots: { left: ReactNode; right: ReactNode }) => ReactNode;
  onCommit: (doc: ChartDoc) => void;
  onExit: () => void;
};

export function CustomChartEditor({ blockId, saved, crumb, interval, header, onCommit, onExit }: Props) {
  const [ask, dialog] = useChoice();
  const draft = useChartDraft(blockId, saved, onCommit, ask);
  const nav = useEditHistory({ dirty: draft.dirty, settle: draft.settle, onExit });

  const left = (
    <Button variant="ghost" size="sm" onClick={nav.back} title="返回(有未保存的修改会先问)">
      <ArrowLeft /> {crumb}
    </Button>
  );
  const right = (
    <div className="flex items-center gap-3">
      {draft.dirty && <span className="text-xs text-amber-400">有未保存的修改</span>}
      <Button size="sm" onClick={() => nav.leave(draft.commit)}>
        <Check /> 完成
      </Button>
    </div>
  );

  return (
    <>
      {header({ left, right })}
      <div className="min-h-0 flex-1 p-4">
        {draft.initial && (
          <ChartEditor key={blockId} interval={interval} store={{ initial: draft.initial, save: draft.setDraft }} />
        )}
      </div>
      {dialog}
    </>
  );
}
