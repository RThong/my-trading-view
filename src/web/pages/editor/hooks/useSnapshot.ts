// 导出图片的两个动作(菜单与快捷键共用)+ 做完后的提示(页面顶部居中显示几秒,成败都报)。拼图见 ../snapshot。
import { type RefObject, useEffect, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Interval } from '../../../hooks/interval';
import type { ChartDoc } from '../../../views/chartDoc/chartDoc';
import { latestTime, snapshotLegend } from '../../../views/chartDoc/Legend';
import type { LayerData } from '../../../views/chartDoc/layerPoints';
import type { LegendLayout } from '../../../views/chartDoc/useCrosshairLegend';
import { CHART_CHROME, useTheme } from '../../../hooks/theme';
import { copyPng, downloadPng, snapshotCanvas } from '../snapshot';

export type SnapshotMessage = { text: string; error?: true };
export type SnapshotActions = { download: () => void; copy: () => void; message: SnapshotMessage | null };

// 提示停留多久:失败的多留一会儿,来得及读原因
const SHOW_MS = { ok: 2000, error: 5000 };

export function useSnapshot(
  container: RefObject<HTMLElement | null>,
  chartRef: RefObject<IChartApi | null>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
  layout: LegendLayout,
  interval: Interval,
): SnapshotActions {
  const theme = useTheme();
  const [message, setMessage] = useState<SnapshotMessage | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.error ? SHOW_MS.error : SHOW_MS.ok);

    return () => clearTimeout(t);
  }, [message]);
  // 有的浏览器 reject 的不是 Error(没有 message),原样转成字符串
  const fail = (what: string) => (e: unknown) =>
    setMessage({ text: `${what}失败:${e instanceof Error ? e.message : String(e)}`, error: true });

  // 导出日(本地时区):落款写数据截至哪天,没数据才写导出日
  const today = () => new Date().toLocaleDateString('sv-SE');
  // 文件名同 TradingView(「AAPL_2026-11-13_17-57-11.png」,2026-11-13 演示页实测):名字_日期_本地时分秒,
  // 同一天导出多张不重名。名字用标题,没标题用图上第一条线(对应 TV 的代码)
  const fileName = () => {
    const name = doc.title ?? snapshotLegend(doc, data).flat()[0]?.label ?? '图表';
    const stamp = new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');

    return `${name}_${stamp}`;
  };
  const make = () => {
    const chart = chartRef.current;
    const origin = container.current;
    if (!chart || !origin) return null;
    const latest = latestTime(doc, data);

    return snapshotCanvas({
      chart,
      origin,
      legend: snapshotLegend(doc, data),
      layout,
      title: doc.title,
      ink: CHART_CHROME[theme].ink,
      footer: `${interval} · ${latest ? `截至 ${latest}` : `导出于 ${today()}`}`,
    });
  };

  return {
    message,
    download: () => {
      const canvas = make();
      if (!canvas) return;
      downloadPng(canvas, fileName()).then(() => setMessage({ text: '图片已下载' }), fail('下载图片'));
    },
    copy: () => {
      const canvas = make();
      if (!canvas) return;
      copyPng(canvas).then(() => setMessage({ text: '图片已复制到剪贴板' }), fail('复制图片'));
    },
  };
}
