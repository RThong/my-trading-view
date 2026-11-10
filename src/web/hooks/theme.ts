// 明暗主题:<html data-theme="light"> 时 styles.css 把 neutral 色阶整条翻成暖白,Tailwind 类不用逐个改;
// 画布(lightweight-charts)读不到 CSS 变量,另按 chartChrome 换色。选择存 localStorage,首屏前由 index.html 的内联脚本先设好,免得闪一下深色。
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

// index.html 的内联脚本里写死了同一个键,改名要两边一起改
const STORAGE_KEY = 'mtv:theme';
const EVENT = 'mtv:theme';

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* 隐私模式存不上:本次会话照常切换 */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

/**
 * 画布上的底色 / 文字 / 网格 / 边框(对应 styles.css 的 neutral 950 / 400 / 900 附近 / 800);
 * ink = 手写文字的正文色(对应 neutral 200 / 深色号,比轴上刻度的 text 更实,画线工具「文字」用)
 */
export const CHART_CHROME: Record<Theme, { bg: string; text: string; ink: string; grid: string; border: string }> = {
  dark: { bg: '#0a0a0a', text: '#a1a1aa', ink: '#e5e5e5', grid: '#1f1f1f', border: '#262626' },
  light: { bg: '#faf7f0', text: '#6e665a', ink: '#2b2620', grid: '#ede7da', border: '#e1d9c8' },
};

/** 给 chart.applyOptions 的那部分主题色(建图时也用它,切主题时再调一次) */
export function chartThemeOptions(t: Theme) {
  const c = CHART_CHROME[t];
  return {
    layout: { background: { color: c.bg }, textColor: c.text, panes: { separatorColor: c.border } },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border },
    leftPriceScale: { borderColor: c.border },
    timeScale: { borderColor: c.border },
  };
}
