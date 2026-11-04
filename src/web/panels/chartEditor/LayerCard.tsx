import type { DragEvent, ReactNode } from 'react';
import { CircleAlert, GripVertical, X } from 'lucide-react';
import { fitScaleIds, isFitTarget, type ChartDoc, type Layer, type Pane, type ScaleChoice } from './chartDoc';
import { baseLabel, layerLabel } from './layerLabel';
import { NumberField } from './NumberField';
import type { ChartDocActions } from './useChartDoc';

export type CardActions = Pick<
  ChartDocActions,
  'setScale' | 'setColor' | 'remove' | 'setShift' | 'setInvert' | 'setLog' | 'clearFit'
>;

// <select> 的 value 只能是字符串:挂轴选择编码成 right / left / new / ov:<轴 id>
function encodeScale(scaleId: string) {
  return scaleId === 'right' || scaleId === 'left' ? scaleId : `ov:${scaleId}`;
}
function decodeScale(v: string): ScaleChoice {
  return v === 'right' || v === 'left' ? v : v === 'new' ? 'newOverlay' : { overlay: v.slice(3) };
}

const SELECT =
  'rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300 hover:border-neutral-600';
const LOCKED_TITLE = '叠加中由「叠加对比」设定,先取消叠加才能改';
const STEP_BTN =
  'rounded px-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

type Props = {
  doc: ChartDoc;
  layer: Layer;
  pane: Pane;
  /** 这张卡片所挂的轴能否取对数(轴上所有图层的值都 > 0),由列表按整根轴算好传进来 */
  canLog: boolean;
  actions: CardActions;
  faded: boolean;
  /** 在这张卡片顶上画插入提示线 */
  insertMark: boolean;
  drop: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
};

export function LayerCard({
  doc,
  layer,
  pane,
  canLog,
  actions,
  faded,
  insertMark,
  drop,
  onDragStart,
  onDragEnd,
}: Props) {
  const overlays = pane.scales.filter((s) => s.side === 'overlay');
  const fitScales = fitScaleIds(pane);
  const scale = pane.scales.find((s) => s.id === layer.scale);
  // 叠加的两头(B、被叠的 A)都不拖、不换轴、不平移:B 的轴跟着 A 的轴走、两者得留在同一格,
  // 比例也是按点按钮时的相对位置算的,任何一头挪了就对不上
  const fixed = !!layer.fit || isFitTarget(doc, layer.id);
  // 倒轴 / 对数是整根轴的属性:这根轴上只要挂着叠加的任一头,就锁住(和 A 共轴的第三条线也不能改)
  const axisLocked = pane.layers.some((l) => l.scale === layer.scale && (!!l.fit || isFitTarget(doc, l.id)));
  // 同格里和它挂同一根轴的其它线:同一根轴只有一套刻度,拖线 = 挪这根轴,会一起动
  const sharers = pane.layers.filter((l) => l.id !== layer.id && l.scale === layer.scale);
  const scaleName =
    layer.scale === 'right'
      ? '右轴'
      : layer.scale === 'left'
        ? '左轴'
        : `独立轴 ${overlays.findIndex((s) => s.id === layer.scale) + 1}`;
  const inverted = !!scale?.invert;
  const log = !!scale?.log;

  return (
    <li
      draggable={!fixed}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      {...drop}
      className={
        (fixed ? 'relative ' : 'relative cursor-grab active:cursor-grabbing ') +
        'rounded border border-neutral-800 bg-neutral-950 px-1.5 py-1.5 ' +
        (faded ? 'opacity-40 ' : '') +
        (insertMark
          ? "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded before:bg-sky-500 before:content-['']"
          : '')
      }
    >
      <div className="flex items-center gap-1.5">
        <GripVertical size={14} className={`shrink-0 ${fixed ? 'invisible' : 'text-neutral-600'}`} />
        <input
          type="color"
          value={layer.color}
          onChange={(e) => actions.setColor(layer.id, e.target.value)}
          className="h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border-0 bg-transparent p-0"
          title="颜色"
        />
        <span className="min-w-0 truncate text-sm text-neutral-200" title={layerLabel(doc, layer)}>
          {layerLabel(doc, layer)}
        </span>
        {sharers.length > 0 && (
          <Tip
            text={`和 ${sharers.map((l) => baseLabel(doc, l.id)).join('、')} 共用${scaleName},拖动会一起动;要单独拖,把纵轴改成别的轴`}
          />
        )}
        <span className="flex-1" />
        {!fixed && (
          <select
            value={encodeScale(layer.scale)}
            onChange={(e) => actions.setScale(layer.id, decodeScale(e.target.value))}
            className={SELECT}
            title="挂哪根纵轴"
          >
            {/* 被叠加的线占着的轴不列:挂上去会被强行按 A 的比例缩放(chartDoc 也会拒绝) */}
            {!fitScales.has('right') && <option value="right">右轴</option>}
            {!fitScales.has('left') && <option value="left">左轴</option>}
            {overlays.map((s, i) =>
              fitScales.has(s.id) ? null : (
                <option key={s.id} value={`ov:${s.id}`}>
                  独立轴 {i + 1}
                </option>
              ),
            )}
            <option value="new">新独立轴</option>
          </select>
        )}
        <button
          type="button"
          onClick={() => actions.remove(layer.id)}
          className="text-neutral-600 hover:text-neutral-200"
          title="删除"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-xs text-neutral-500">
        <SeriesControls layer={layer} shiftLocked={fixed} inverted={inverted} actions={actions} />
        <Toggle
          on={inverted}
          disabled={axisLocked}
          onClick={() => actions.setInvert(pane.id, layer.scale, !inverted)}
          title={axisLocked ? LOCKED_TITLE : '倒轴:整根轴上下颠倒,挂在这根轴上的线一起倒'}
        >
          倒轴
        </Toggle>
        <Toggle
          on={log}
          disabled={axisLocked || (!canLog && !log)}
          onClick={() => actions.setLog(pane.id, layer.scale, !log)}
          title={
            axisLocked
              ? LOCKED_TITLE
              : canLog
                ? '对数坐标:等比例的涨跌画成等高,适合跨好几个数量级的线(BTC、长历史指数)'
                : '这根轴上有 ≤0 的值(利率、利差常见),取不了对数'
          }
        >
          对数
        </Toggle>
        {log && !canLog && <span className="text-amber-500">这根轴上有 ≤0 的值,暂按普通坐标显示</span>}
      </div>
    </li>
  );
}

function SeriesControls({
  layer,
  shiftLocked,
  inverted,
  actions,
}: {
  layer: Layer;
  shiftLocked: boolean;
  inverted: boolean;
  actions: CardActions;
}) {
  const shift = layer.shift ?? 0;

  return (
    <>
      <span
        className="flex items-center gap-0.5"
        title={shiftLocked ? LOCKED_TITLE : '平移(交易日):正数往右挪,看它是不是领先别的线'}
      >
        平移
        <button
          type="button"
          className={STEP_BTN}
          disabled={shiftLocked}
          onClick={() => actions.setShift(layer.id, shift - 1)}
        >
          −
        </button>
        <NumberField value={shift} disabled={shiftLocked} onCommit={(n) => actions.setShift(layer.id, n)} />
        <button
          type="button"
          className={STEP_BTN}
          disabled={shiftLocked}
          onClick={() => actions.setShift(layer.id, shift + 1)}
        >
          +
        </button>
        天
      </span>
      {layer.fit && (
        <span className="flex w-full items-center gap-1.5 text-neutral-400">
          <span>
            基准段 {layer.fit.start} ~ {layer.fit.end}
            {` · 相关 ${layer.fit.r.toFixed(2)}`}
            {layer.fit.beta < 0 && (inverted ? ' · 反向,轴已倒过来' : ' · 反向(A 的轴已倒,不用倒)')}
          </span>
          <button type="button" className={STEP_BTN} onClick={() => actions.clearFit(layer.id)}>
            取消叠加
          </button>
        </span>
      )}
    </>
  );
}

function Toggle({
  on,
  onClick,
  title,
  disabled,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        'rounded border px-1.5 py-px text-xs disabled:cursor-not-allowed disabled:opacity-40 ' +
        (on
          ? 'border-sky-600 bg-sky-600/20 text-sky-300'
          : 'border-neutral-800 text-neutral-500 hover:text-neutral-300')
      }
    >
      {children}
    </button>
  );
}

// 黄色感叹号,悬停显示说明(纯 CSS group-hover,不用状态)。
// 浮层不以图标为基准(图标位置随名字长短变,靠边就被侧栏裁掉),而是对齐整张卡片(li 是 relative),铺在名字那行下面
function Tip({ text }: { text: string }) {
  return (
    <span className="group shrink-0">
      <CircleAlert size={13} className="text-amber-400" />
      <span className="pointer-events-none absolute inset-x-1 top-8 z-20 hidden rounded border border-amber-500/40 bg-neutral-900 px-2 py-1.5 text-[11px] leading-snug text-amber-200 shadow-lg group-hover:block">
        {text}
      </span>
    </span>
  );
}
