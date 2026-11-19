import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Ask } from '../components/useChoice';

// 后退时先弹窗确认,不直接离开看板(触摸板左滑容易误触浏览器后退;Chrome 那边 styles.css 已关掉滑动导航,这里给 Safari、
// 键盘 / 鼠标侧键后退兜底)。做法:在本页最底下那条历史之上再压一条同址、带标记的,并停在它上面;后退先退回最底下那条
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

/**
 * 停在最底下那条上时压一条守卫的(已在上面就不动)。自己也要压历史的地方(全屏编辑页)先调它:
 * 不然自己那条直接压在最底下那条上,从那里后退会落到最底下、被当成「要离开看板」
 */
export function armGuard() {
  if (flagged(history.state, BASE)) history.pushState({ [MARK]: true }, '');
}

type Confirm = (a: Ask<boolean>) => Promise<boolean>;

/** ask:问「要离开吗」用的弹窗(useChoice) */
export function useBackGuard(ask: Confirm) {
  const askRef = useRef(ask);

  useEffect(() => {
    askRef.current = ask;
  });

  // layout effect:要赶在所有普通 effect 之前给最底下那条打标 —— 子组件的 effect 先跑,
  // 直接打开编辑页链接时编辑页会先压一条历史,晚了就认不出最底下那条
  useLayoutEffect(() => {
    // 这个标签页里本来就没有上一页(新标签页直接打开;刷新前压过的那条不算):后退本来也离不开,
    // 拦了只会让 Safari 左滑白弹一次窗,点确定还走不了 —— 不拦(用户定)
    const hasPrevPage = history.length > (isGuardState(history.state) ? 2 : 1);
    if (!hasPrevPage) return;

    // 只给 state 为空的那条打(= 本页第一次打开的那条)。历史项的 state 刷新后还在:停在守卫那条上刷新时底下那条早已标过;
    // 停在地址栏改 hash 新压的那条上刷新时,它已被 useHashRoute 标过,不是最底下,不能再当底
    if (history.state === null) history.replaceState({ [BASE]: true }, '');

    // 确认离开后不再拦(再退一步若仍落在本页,别重复弹);重新压上、或又回到带标记那条时清掉
    let leaving = false;
    // 弹窗不卡页面,开着时可能又来一次后退:只问一次
    let asking = false;

    const arm = () => {
      armGuard();
      leaving = false;
    };

    // popstate 前进、后退、改 hash 都会触发:只在「退回最底下那条」时问;前进回到带标记那条不问,
    // 只把 leaving 清掉(离开后从后退缓存 bfcache 回来再前进到这里时,JS 状态原样恢复,leaving 还是 true)
    const onPop = (e: PopStateEvent) => {
      if (isGuardState(e.state)) {
        leaving = false;
        return;
      }
      if (leaving || asking || !flagged(e.state, BASE)) return;

      // 先重新压上再问:弹窗开着时再按一次后退,落回最底下那条(asking 挡住不重问),不会直接离开
      asking = true;
      arm();
      void askRef
        .current({
          title: '要离开看板吗?',
          description: '触摸板左滑、鼠标侧键都会触发浏览器后退',
          choices: [
            { label: '离开', value: true },
            { label: '留下', value: false, variant: 'default' },
          ],
          cancel: false,
        })
        .then((leave) => {
          asking = false;
          if (!leave) return arm();

          leaving = true;
          // 停在重新压上的那条上要退两步,越过最底下那条
          history.go(isGuardState(history.state) ? -2 : -1);
        });
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
