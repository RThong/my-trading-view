// 全屏编辑页的历史:进来压一条「编辑中」的,浏览器后退 = 退出编辑(不是离开看板);有改动时先问(settle)。
// 关标签页 / 刷新时有改动:浏览器自带的确认(文字改不了)。
import { useEffect, useRef } from 'react';
import { armGuard } from '../../hooks/useBackGuard';

const EDIT = 'mtvChartEdit';

function onEditEntry(): boolean {
  return !!(history.state as Record<string, unknown> | null)?.[EDIT];
}

function pushEditEntry() {
  history.pushState({ [EDIT]: true }, '');
}

type Opts = {
  dirty: boolean;
  /** 有改动时问保存与否,返回能不能走 */
  settle: () => Promise<boolean>;
  onExit: () => void;
};

export function useEditHistory({ dirty, settle, onExit }: Opts) {
  // 回调里读最新的
  const latest = useRef({ dirty, settle, onExit });
  // 正在退出(已发出后退,等 popstate 收尾):再点完成 / 返回都忽略,不然会多退一步
  const exitingRef = useRef(false);
  // 正在问保存与否
  const askingRef = useRef(false);

  useEffect(() => {
    latest.current = { dirty, settle, onExit };
  });

  /** 退出编辑(不问)。before = 退出前要做的(完成时写回),退出途中重复点不再做 */
  const leave = (before?: () => void) => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    before?.();

    // 在「编辑中」那条上就后退,交给 popstate 收尾;不在(问的时候又后退过)直接退
    if (onEditEntry()) history.back();
    else latest.current.onExit();
  };

  /** 有改动先问:继续编辑就留下(不在「编辑中」那条上了就压回去),保存 / 不保存就退出 */
  const askThenLeave = () => {
    if (askingRef.current || exitingRef.current) return;
    askingRef.current = true;

    void latest.current.settle().then((ok) => {
      askingRef.current = false;
      if (ok) leave();
      else if (!onEditEntry()) pushEditEntry();
    });
  };

  // 进来先压「编辑中」那条(刷新时已经在这条上就不压)。先让守卫垫一条:否则从最底下那条直接进来时,
  // 后退落到最底下会被当成「要离开看板」
  useEffect(() => {
    if (onEditEntry()) return;

    armGuard();
    pushEditEntry();
  }, []);

  // 离开「编辑中」那条:自己发起的(leave)、没改动的直接收尾;有改动的先压回去再问 —— 问的时候停在编辑那条上,
  // 框开着又按后退只会落回 tab 那条(这里忽略),不会落到最底下、和「要离开看板」的框一起弹
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只挂一次,回调里读 ref
  useEffect(() => {
    const onPop = () => {
      if (onEditEntry()) return;
      if (exitingRef.current || !latest.current.dirty) return latest.current.onExit();
      if (askingRef.current) return;

      pushEditEntry();
      askThenLeave();
    };

    window.addEventListener('popstate', onPop);

    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!dirty) return;

    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);

    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  return { leave, back: askThenLeave };
}
