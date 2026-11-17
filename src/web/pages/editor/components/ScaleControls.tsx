// 一根纵轴的属性(倒轴 + 坐标模式四选一):纵轴右键菜单(TradingView 样式的列表)和独立轴图层卡片(按钮)共用同一份选项。
// 都是整根轴的属性,挂在这根轴上的线一起变
import type { ReactNode } from 'react';
import { Button } from '../../../components/ui/button';
import {
  isFitTarget,
  SCALE_MODES,
  scaleMode,
  type ChartDoc,
  type Pane,
  type ScaleMode,
} from '../../../views/chartDoc/chartDoc';
import type { ChartDocActions } from '../hooks/useChartDoc';

export type ScaleActions = Pick<ChartDocActions, 'setInvert' | 'setMode'>;

export const LOCKED_TITLE = '叠加中由「叠加对比」设定,先取消叠加才能改';
const NOT_POSITIVE = '这根轴上有 ≤0 的值(利率、利差常见),用不了:对数取不了,百分比拿第一个点当分母会爆掉或画反';
export const NOT_POSITIVE_NOTE = '这根轴上有 ≤0 的值,暂按普通坐标显示';
// 顺序同 TradingView 价格轴右键菜单
const MODE_ORDER: ScaleMode[] = ['normal', 'percent', 'indexed', 'log'];

/** 一个选项:勾没勾、能不能点、悬停说明、点了做什么 */
export type ScaleItem = { key: string; label: string; on: boolean; disabled: boolean; title: string; run: () => void };

/**
 * 这根轴的全部选项:倒轴(开关)+ 坐标模式(单选)。
 * 轴上挂着叠加的任一头就全锁:B 的轴跟着 A 走,A 的轴改了模式 / 倒轴比例就对不上
 */
export function scaleItems(
  doc: ChartDoc,
  pane: Pane,
  scaleId: string,
  positive: boolean,
  actions: ScaleActions,
): { invert: ScaleItem; modes: ScaleItem[]; ineffective: boolean } {
  const scale = pane.scales.find((s) => s.id === scaleId);
  const locked = pane.layers.some((l) => l.scale === scaleId && (!!l.fit || isFitTarget(doc, l.id)));
  const inverted = !!scale?.invert;
  const mode = scaleMode(scale);

  return {
    invert: {
      key: 'invert',
      label: '倒轴',
      on: inverted,
      disabled: locked,
      title: locked ? LOCKED_TITLE : '倒轴:整根轴上下颠倒,挂在这根轴上的线一起倒',
      run: () => actions.setInvert(pane.id, scaleId, !inverted),
    },
    modes: MODE_ORDER.map((m) => ({
      key: m,
      label: SCALE_MODES[m].label,
      on: mode === m,
      disabled: locked || (m !== 'normal' && !positive && mode !== m),
      title: locked ? LOCKED_TITLE : m !== 'normal' && !positive ? NOT_POSITIVE : SCALE_MODES[m].desc,
      run: () => actions.setMode(pane.id, scaleId, m),
    })),
    ineffective: mode !== 'normal' && !positive,
  };
}

type Props = {
  doc: ChartDoc;
  pane: Pane;
  scaleId: string;
  /** 轴上所有线的值都 > 0(能用对数 / 百分比 / 起点 100) */
  positive: boolean;
  actions: ScaleActions;
};

/** 卡片里的按钮版(独立轴没有刻度可右键,只能在这里改) */
export function ScaleControls({ doc, pane, scaleId, positive, actions }: Props) {
  const { invert, modes, ineffective } = scaleItems(doc, pane, scaleId, positive, actions);

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-1">
        {modes.map((it) => (
          <Toggle key={it.key} item={it}>
            {it.label}
          </Toggle>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Toggle item={invert}>{invert.label}</Toggle>
      </div>
      {ineffective && <span className="text-amber-500">{NOT_POSITIVE_NOTE}</span>}
    </div>
  );
}

function Toggle({ item, children }: { item: ScaleItem; children: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="2xs"
      onClick={item.run}
      title={item.title}
      disabled={item.disabled}
      aria-pressed={item.on}
      className={item.on ? 'border-sky-600 bg-sky-600/20 text-sky-300 hover:bg-sky-600/30' : 'text-neutral-500'}
    >
      {children}
    </Button>
  );
}
