import { useEffect } from 'react';

// 后退时先弹窗确认,不直接离开看板(触摸板左滑容易误触浏览器后退;Chrome 那边 styles.css 已关掉滑动导航,这里给 Safari、
// 键盘 / 鼠标侧键后退兜底)。做法:在当前这条历史项之后再压一条同址、带标记的,并停在它上面;后退先退回原来那条
// (还在看板里,触发 popstate)→ 问一句 → 确认就再退一步真正离开,取消就重新压上。
// 不用 beforeunload:它连刷新、关标签页、开发时的热重载都会弹,而且提示文字定不了。
const MARK = 'mtvBackGuard';
// 本页最底下那条历史(再往后退就离开看板)。地址栏改 hash / 点 #/… 的链接也会触发 popstate(新压一条、state 为空),
// 那不是后退:只有退到带这个标记的那条才问
const BASE = 'mtvBackBase';

function flagged(state: unknown, key: string): boolean {
  return !!(state as Record<string, unknown> | null)?.[key];
}

function isGuardState(state: unknown): boolean {
  return flagged(state, MARK);
}

export function useBackGuard() {
  useEffect(() => {
    // 这个标签页里本来就没有上一页(新标签页直接打开;刷新前压过的那条不算):后退本来也离不开,
    // 拦了只会让 Safari 左滑白弹一次窗,点确定还走不了 —— 不拦(用户定)
    const hasPrevPage = history.length > (isGuardState(history.state) ? 2 : 1);
    if (!hasPrevPage) return;

    // 只给 state 为空的那条打(= 本页第一次打开的那条)。历史项的 state 刷新后还在:停在守卫那条上刷新时底下那条早已标过;
    // 停在地址栏改 hash 新压的那条上刷新时,它已被 useHashRoute 标过,不是最底下,不能再当底
    if (history.state === null) history.replaceState({ [BASE]: true }, '');

    // 确认离开后不再拦(再退一步若仍落在本页,别重复弹);重新压上、或又回到带标记那条时清掉
    let leaving = false;

    const arm = () => {
      if (isGuardState(history.state)) return;
      history.pushState({ [MARK]: true }, '');
      leaving = false;
    };

    // popstate 前进、后退、改 hash 都会触发:只在「退回最底下那条」时问;前进回到带标记那条不问,
    // 只把 leaving 清掉(离开后从后退缓存 bfcache 回来再前进到这里时,JS 状态原样恢复,leaving 还是 true)
    const onPop = (e: PopStateEvent) => {
      if (isGuardState(e.state)) {
        leaving = false;
        return;
      }
      if (leaving || !flagged(e.state, BASE)) return;

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
