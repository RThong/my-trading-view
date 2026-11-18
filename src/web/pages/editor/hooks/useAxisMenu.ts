// 纵轴右键菜单(同 TradingView 价格轴右键):在某一格的左 / 右轴刻度上右键,弹出这根轴的坐标模式和倒轴。
// 轴的属性挂在轴上改,不用去某条线的卡片里改(改一条线的卡片会连带改掉共用这根轴的所有线,位置不对)。
// 独立轴勾了「显示刻度」画在右轴外侧的(useAxisDecor),在那截上右键同样弹出,改的是那根独立轴
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import { onItsScale, type ChartDoc } from '../../../views/chartDoc/chartDoc';
import type { StripHit } from '../../../views/chartDoc/useAxisDecor';
import { axisAt } from './paneHit';

/** 菜单挂在哪一格哪根轴上;x / y 是相对图表容器的弹出点,flipX / flipY = 点在右半 / 下半,菜单往左 / 往上展开免得出界 */
export type AxisMenuAt = {
  paneId: string;
  /** left / right,或画在右轴外侧的独立轴 id */
  scaleId: string;
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
};

export function useAxisMenu(
  container: RefObject<HTMLElement | null>,
  chartRef: RefObject<IChartApi | null>,
  doc: ChartDoc,
  /** 鼠标落在哪根多出来的轴上(见 useAxisDecor);右轴最外侧那几截归它,不算右轴 */
  stripAt: (e: MouseEvent) => StripHit | undefined,
) {
  const [at, setAt] = useState<AxisMenuAt | null>(null);
  // 监听只挂一次,文档从 ref 读
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const stripAtRef = useRef(stripAt);
  useEffect(() => {
    stripAtRef.current = stripAt;
  });

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const onContextMenu = (e: MouseEvent) => {
      const chart = chartRef.current;
      const strip = stripAtRef.current(e);
      const native = !strip && chart ? axisAt(el, chart, e) : undefined;
      const hit = strip
        ? { index: strip.paneIndex, scaleId: strip.scaleId }
        : native && { index: native.index, scaleId: native.side };
      const pane = hit && docRef.current.panes[hit.index];
      // 轴上没挂线(空着的那一侧)不弹:改了也看不出效果。不在轴上的右键交给浏览器
      if (!hit || !pane?.layers.some((l) => l.scale === hit.scaleId && onItsScale(l))) return;

      e.preventDefault();
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      setAt({ paneId: pane.id, scaleId: hit.scaleId, x, y, flipX: x > box.width / 2, flipY: y > box.height / 2 });
    };

    el.addEventListener('contextmenu', onContextMenu);
    return () => el.removeEventListener('contextmenu', onContextMenu);
  }, [container, chartRef]);

  // 那一格 / 那根轴上的线没了(撤销、删线)就收起,别对着一根空轴显示;
  // 真关掉而不只是不画:否则重做把线带回来时,菜单会在没右键的情况下自己又弹出来
  const pane = at && doc.panes.find((p) => p.id === at.paneId);
  const live = !!pane?.layers.some((l) => l.scale === at?.scaleId && onItsScale(l));
  useEffect(() => {
    if (at && !live) setAt(null);
  }, [at, live]);

  return { at: live ? at : null, close: () => setAt(null) };
}
