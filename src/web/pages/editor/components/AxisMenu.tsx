// 纵轴右键弹出的菜单(TradingView 价格轴菜单的样式:一列选项、勾选标在左边):倒轴开关 + 坐标模式单选 + 整图上下留白,
// 顶上一行写清是哪根轴、挂着哪几条线。
// 点菜单外、按 Esc、滚轮都收起(同 TradingView)
import { type RefObject, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { DEFAULT_MARGINS, MAX_MARGIN, onItsScale, type ChartDoc, scaleName } from '../../../views/chartDoc/chartDoc';
import { baseLabel } from '../../../views/chartDoc/layerLabel';
import { positiveScale, type LayerData } from '../../../views/chartDoc/layerPoints';
import type { AxisMenuAt } from '../hooks/useAxisMenu';
import type { ChartDocActions } from '../hooks/useChartDoc';
import { NumberField } from './NumberField';
import { NOT_POSITIVE_NOTE, type ScaleActions, type ScaleItem, scaleItems } from './ScaleControls';

type Props = {
  at: AxisMenuAt;
  doc: ChartDoc;
  data: Record<string, LayerData>;
  actions: ScaleActions & Pick<ChartDocActions, 'setMargins'>;
  onClose: () => void;
  /** 图表画布容器:菜单开着时点在它里面只关菜单 */
  chartEl: RefObject<HTMLElement | null>;
};

export function AxisMenu({ at, doc, data, actions, onClose, chartEl }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 监听只挂一次,关闭回调从 ref 读
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // 焦点移进菜单:按 Esc 时目标在 [role=menu] 里,画线那边(notOurs)不再拿它去退工具 / 取消选中
    ref.current?.focus({ preventScroll: true });
    // 先让菜单里的输入框失焦再关:留白输入框靠失焦提交,菜单直接卸载的话 onBlur 不会触发、打的值就丢了
    const close = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && ref.current?.contains(el)) el.blur();
      closeRef.current();
    };
    // 菜单开着时点图表区只关菜单,这一下不再传给选线 / 画线(否则顺带取消了选中)。点浮条、侧栏等别处照常(它们要靠按下获得焦点 / 响应)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (chartEl.current?.contains(t)) {
        e.stopPropagation();
        e.preventDefault();
      }
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只关菜单,不再冒泡到选线那边去清掉选中的线
      e.stopPropagation();
      close();
    };
    // 捕获阶段:图表 / 画线的监听可能截掉冒泡
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('blur', close);
    };
  }, [chartEl]);

  const index = doc.panes.findIndex((p) => p.id === at.paneId);
  const pane = doc.panes[index];
  if (!pane) return null;

  const margins = doc.margins ?? DEFAULT_MARGINS;
  const names = pane.layers.filter((l) => l.scale === at.scaleId && onItsScale(l)).map((l) => baseLabel(doc, l.id));
  // 选完就收起(同 TradingView)
  const { invert, modes, ineffective } = scaleItems(doc, pane, at.scaleId, positiveScale(pane, at.scaleId, data), {
    setMode: (...args) => {
      actions.setMode(...args);
      onClose();
    },
    setInvert: (...args) => {
      actions.setInvert(...args);
      onClose();
    },
  });

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="absolute z-30 flex w-60 flex-col rounded-md border border-neutral-700 bg-neutral-900 py-1 text-sm shadow-lg outline-none"
      style={{
        left: at.flipX ? undefined : at.x,
        right: at.flipX ? `calc(100% - ${at.x}px)` : undefined,
        top: at.flipY ? undefined : at.y,
        bottom: at.flipY ? `calc(100% - ${at.y}px)` : undefined,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* TV 没有这一行;留着是因为一格常有左右两根轴,改之前看清是哪根、会连带哪几条线 */}
      <div className="truncate px-3 py-1 text-xs text-neutral-500" title={names.join('、')}>
        第 {index + 1} 格 · {scaleName(pane, at.scaleId)} · {names.join('、')}
      </div>
      <Separator />
      <Item item={invert} role="menuitemcheckbox" />
      <Separator />
      {modes.map((it) => (
        <Item key={it.key} item={it} role="menuitemradio" />
      ))}
      {ineffective && <div className="px-3 py-1 text-xs text-amber-500">{NOT_POSITIVE_NOTE}</div>}
      <Separator />
      {/* TV 放在图表设置里;这里没有设置页,挂在轴菜单上。改完不收起,回车即见效 */}
      <div
        className="flex h-8 items-center gap-1 px-3 text-neutral-200"
        title={`整张图所有价格轴共用(同 TradingView 的 Margins),0~${MAX_MARGIN}%`}
      >
        <span className="mr-auto">上下留白 %</span>上
        <NumberField value={margins.top} onCommit={(top) => actions.setMargins({ ...margins, top })} className="w-8" />
        下
        <NumberField
          value={margins.bottom}
          onCommit={(bottom) => actions.setMargins({ ...margins, bottom })}
          className="w-8"
        />
      </div>
    </div>
  );
}

function Separator() {
  return <div role="separator" className="my-1 h-px bg-neutral-800" />;
}

// 一行:左边勾选列(勾上才画 ✓,不勾也占位,文字左对齐),同 TradingView 价格轴菜单
function Item({ item, role }: { item: ScaleItem; role: 'menuitemcheckbox' | 'menuitemradio' }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={item.on}
      disabled={item.disabled}
      title={item.title}
      onClick={item.run}
      className="flex h-8 items-center gap-2 px-3 text-left text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
    >
      <Check size={16} className={item.on ? 'shrink-0' : 'invisible shrink-0'} />
      {item.label}
    </button>
  );
}
