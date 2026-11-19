// 当前停在的 tab 写进地址栏(可复制成链接、刷新停在原处);地址栏里手改 hash / 点了别的链接就跳过去。
// 切 tab 只改当前这条历史(replaceState),不新增后退记录:后退照旧交给 useBackGuard(问要不要离开看板)。
// hashchange 分两种:新压的一条(地址栏改 hash / 点 #/… 链接,state 为空)→ 跳过去;
// 退回已有的那条(后退落到守卫那条、取消离开后守卫重压的那条、以前改 hash 压的那条)→ 后退不在 tab 间来回,只把地址改回当前。
import { useEffect, useRef, useState } from 'react';
import { parseRoute, type Route } from './route';

// 地址栏改 hash 新压的那条历史打这个标记(后退守卫靠「state 为空」认本页最底下那条,见 useBackGuard)
const HASH_NAV = 'mtvHashNav';

export function useHashRoute(hash: string, onNavigate: (r: Route) => void) {
  // 只在事件里读
  const hashRef = useRef(hash);
  const navRef = useRef(onNavigate);
  // 每次地址栏改动都 +1:跳不过去(链接里的 tab 不在了)时页面不动、hash 也不变,靠它再对一次地址
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    hashRef.current = hash;
    navRef.current = onNavigate;
  });

  // 带上原 state:后退守卫压的那条历史靠 state 里的标记认。changes 只用来在地址栏改动后再对一次
  useEffect(() => {
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }, [hash, changes]);

  useEffect(() => {
    const onHash = () => {
      if (history.state !== null) {
        history.replaceState(history.state, '', hashRef.current);
        return;
      }

      history.replaceState({ [HASH_NAV]: true }, '');
      const r = parseRoute(location.hash);
      if (r) navRef.current(r);
      setChanges((n) => n + 1);
    };

    window.addEventListener('hashchange', onHash);

    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}
