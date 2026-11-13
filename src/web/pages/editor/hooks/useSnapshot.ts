// 导出图片的两个动作(菜单与快捷键共用)+「已复制」的短暂提示。拼图见 ../snapshot。
import { type RefObject, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Interval } from '../../../hooks/interval';
import { copyPng, downloadPng, snapshotCanvas } from '../snapshot';

export type SnapshotActions = { download: () => void; copy: () => void; copied: boolean };

function fail(what: string) {
  return (e: Error) => window.alert(`${what}失败:${e.message}`);
}

export function useSnapshot(
  container: RefObject<HTMLElement | null>,
  chartRef: RefObject<IChartApi | null>,
  legend: RefObject<HTMLElement | null>,
  title: string | undefined,
  interval: Interval,
): SnapshotActions {
  const [copied, setCopied] = useState(false);

  // 落款的日期按本地时区取当天
  const today = () => new Date().toLocaleDateString('sv-SE');
  const make = () => {
    const chart = chartRef.current;
    const origin = container.current;
    if (!chart || !origin) return null;

    return snapshotCanvas({ chart, origin, overlay: legend.current, title, footer: `${interval} · ${today()}` });
  };

  return {
    copied,
    download: () => {
      const canvas = make();
      if (canvas) downloadPng(canvas, `${title ?? '图表'}-${today()}`).catch(fail('下载图片'));
    },
    copy: () => {
      const canvas = make();
      if (!canvas) return;
      copyPng(canvas).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }, fail('复制图片'));
    },
  };
}
