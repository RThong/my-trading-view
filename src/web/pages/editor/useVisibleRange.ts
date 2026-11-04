// 图上当前可视的时间区间(防抖后的),给「叠加对比」在视口里选基准段用。
import { type RefObject, useEffect, useState } from 'react';
import type { IChartApi, IRange, Time } from 'lightweight-charts';
import { fmtDate } from '../../chart/core';

export type DateRange = { from: string; to: string };

// 拖动 / 缩放时每帧都会回调;停下来 250ms 再更新,免得每帧触发整页重渲染
const DEBOUNCE_MS = 250;

export function useVisibleRange(chartRef: RefObject<IChartApi | null>): DateRange | null {
  const [range, setRange] = useState<DateRange | null>(null);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // 订阅「逻辑范围」而不是「时间范围」:lw-charts 5.2 在数据改动的那一刻(比如平移让时间轴多出未来日期)
    // 派发时间范围事件时,可视区间会短暂指向还没有日期的下标,它内部换算日期取到 null 直接抛 Value is null,
    // 抛在它的事件派发里,整页白屏(实测:SPY + QQQ,QQQ 平移 +1)。逻辑范围不换算日期,不走那段代码;
    // 等防抖结束、图稳定了再自己换算,万一还是换算不了就跳过这一次。
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (chartRef.current !== chart) return;
        let r: IRange<Time> | null = null;
        try {
          r = chart.timeScale().getVisibleRange();
        } catch {
          return;
        }
        const next = r ? { from: fmtDate(r.from), to: fmtDate(r.to) } : null;
        setRange((prev) => (prev?.from === next?.from && prev?.to === next?.to ? prev : next));
      }, DEBOUNCE_MS);
    };
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(onChange);

    return () => {
      clearTimeout(timer);
      // 卸载时建图 hook 的清理先跑,图已销毁就不再碰
      if (chartRef.current === chart) ts.unsubscribeVisibleLogicalRangeChange(onChange);
    };
  }, [chartRef]);

  return range;
}
