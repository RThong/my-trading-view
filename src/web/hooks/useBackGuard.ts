import { useEffect } from 'react';

// 后退时先弹窗确认,不直接离开看板(触摸板左滑容易误触浏览器后退;Chrome 那边 styles.css 已关掉滑动导航,这里给 Safari、
// 键盘 / 鼠标侧键后退兜底)。做法:在当前这条历史项之后再压一条同址、带标记的,并停在它上面;后退先退回原来那条
// (还在看板里,触发 popstate)→ 问一句 → 确认就再退一步真正离开,取消就重新压上。
// 不用 beforeunload:它连刷新、关标签页、开发时的热重载都会弹,而且提示文字定不了。
const MARK = 'mtvBackGuard';

function marked(state: unknown): boolean {
  return !!(state as Record<string, unknown> | null)?.[MARK];
}

export function useBackGuard() {
  useEffect(() => {
    // 这个标签页里本来就没有上一页(新标签页直接打开;刷新前压过的那条不算):后退本来也离不开,
    // 拦了只会让 Safari 左滑白弹一次窗,点确定还走不了 —— 不拦(用户定)
    const hasPrevPage = history.length > (marked(history.state) ? 2 : 1);
    if (!hasPrevPage) return;

    // 确认离开后不再拦(再退一步若仍落在本页,别重复弹);重新压上、或又回到带标记那条时清掉
    let leaving = false;

    const arm = () => {
      if (marked(history.state)) return;
      history.pushState({ [MARK]: true }, '');
      leaving = false;
    };

    // popstate 前进、后退都会触发:只在「从带标记那条退回原来那条」时问;前进回到带标记那条不问,
    // 只把 leaving 清掉(离开后从后退缓存 bfcache 回来再前进到这里时,JS 状态原样恢复,leaving 还是 true)
    const onPop = (e: PopStateEvent) => {
      if (marked(e.state)) {
        leaving = false;
        return;
      }
      if (leaving) return;

      if (window.confirm('要离开看板吗?\n(触摸板左滑、鼠标侧键都会触发浏览器后退)')) {
        leaving = true;
        history.back();
      } else arm();
    };

    // 点击 / 按键时才压:Chrome 防滥用,页面没被操作过就加的历史项,后退时会被直接跳过。
    // 常驻不只听一次:离开后又从后退缓存回来时,用户一操作就重新压上
    // 捕获阶段:图表编辑器拖画线 / 画线工具会在半路截下按键(stopPropagation),冒泡阶段就收不到了
    window.addEventListener('pointerdown', arm, true);
    window.addEventListener('keydown', arm, true);
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('pointerdown', arm, true);
      window.removeEventListener('keydown', arm, true);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
