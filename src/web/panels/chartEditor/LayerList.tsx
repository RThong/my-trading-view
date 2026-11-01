import { type DragEvent, useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { ChartDoc, Layer, Pane, PaneTarget, ScaleChoice } from './chartDoc';
import { seriesDef } from './registry';

type Props = {
  doc: ChartDoc;
  /** before:插到这条图层前面;缺省 = 追加到该格末尾 */
  onMove: (layerId: string, target: PaneTarget, before?: string) => void;
  onScale: (layerId: string, choice: ScaleChoice) => void;
  onColor: (layerId: string, color: string) => void;
  onRemove: (layerId: string) => void;
};

// <select> 的 value 只能是字符串:挂轴选择编码成 right / left / new / ov:<轴 id>
const encodeScale = (scaleId: string) => (scaleId === 'right' || scaleId === 'left' ? scaleId : `ov:${scaleId}`);
const decodeScale = (v: string): ScaleChoice =>
  v === 'right' || v === 'left' ? v : v === 'new' ? 'newOverlay' : { overlay: v.slice(3) };

const SELECT =
  'rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300 hover:border-neutral-600';
const DRAG_TYPE = 'text/plain';

// 右侧下半:一格一个区块,区块里是该格的图层卡片。卡片整张可拖:
// 放到另一张卡片上 = 插到它前面(同格即调顺序);放到区块空白处 = 追加到该格末尾;
// 拖到最下面的虚线框 = 新开一格。
export function LayerList({ doc, onMove, onScale, onColor, onRemove }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<PaneTarget | null>(null);
  // 拖到哪张卡片上方(插入提示线画在它顶上)
  const [overCard, setOverCard] = useState<string | null>(null);

  if (doc.panes.length === 0) {
    return <p className="px-1 text-xs leading-relaxed text-neutral-500">在上方勾选序列,它们会以卡片出现在这里</p>;
  }

  // 放置目标(格区块 / 新开一格)共用的拖放处理
  const dropTarget = (target: PaneTarget) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      if (over !== target) setOver(target);
      // 在区块空白处(不在任何卡片上)→ 去掉插入提示线
      if (overCard && !(e.target as HTMLElement).closest('li[draggable]')) setOverCard(null);
    },
    onDragLeave: (e: DragEvent) => {
      // 移进子元素也会触发 leave,只有真离开区块才清
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setOver(null);
        setOverCard(null);
      }
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id) onMove(id, target);
      endDrag();
    },
  });

  // 卡片本身也是放置目标:插到这张前面。stopPropagation 免得外层区块再按「追加到末尾」处理一次。
  const cardDrop = (paneId: string, layerId: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      if (overCard !== layerId) setOverCard(layerId);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id) onMove(id, paneId, layerId);
      endDrag();
    },
  });

  const startDrag = (layerId: string) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, layerId);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(layerId);
  };
  function endDrag() {
    setDragging(null);
    setOver(null);
    setOverCard(null);
  }

  return (
    <section className="flex flex-col gap-2">
      {doc.panes.map((pane, i) => (
        <div
          key={pane.id}
          {...dropTarget(pane.id)}
          className={
            'rounded border p-1.5 transition-colors ' +
            (over === pane.id ? 'border-sky-500 bg-sky-500/5' : 'border-neutral-800')
          }
        >
          <h3 className="mb-1 px-0.5 text-xs text-neutral-500">
            第 {i + 1} 格{i === 0 && '(主图)'}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {pane.layers.map((l) => (
              <LayerCard
                key={l.id}
                layer={l}
                pane={pane}
                faded={dragging === l.id}
                insertMark={overCard === l.id && dragging !== l.id}
                drop={cardDrop(pane.id, l.id)}
                onDragStart={startDrag(l.id)}
                onDragEnd={endDrag}
                onScale={onScale}
                onColor={onColor}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      ))}

      <div
        {...dropTarget('new')}
        className={
          'rounded border border-dashed px-2 py-3 text-center text-xs transition-colors ' +
          (over === 'new'
            ? 'border-sky-500 bg-sky-500/5 text-sky-300'
            : dragging
              ? 'border-neutral-500 text-neutral-400'
              : 'border-neutral-800 text-neutral-600')
        }
      >
        拖到这里新开一格
      </div>
    </section>
  );
}

type CardProps = Pick<Props, 'onScale' | 'onColor' | 'onRemove'> & {
  layer: Layer;
  pane: Pane;
  faded: boolean;
  /** 在这张卡片顶上画插入提示线 */
  insertMark: boolean;
  drop: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
};

function LayerCard({
  layer,
  pane,
  faded,
  insertMark,
  drop,
  onDragStart,
  onDragEnd,
  onScale,
  onColor,
  onRemove,
}: CardProps) {
  const overlays = pane.scales.filter((s) => s.side === 'overlay');

  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      {...drop}
      className={
        'relative cursor-grab rounded border border-neutral-800 bg-neutral-950 px-1.5 py-1.5 active:cursor-grabbing ' +
        (faded ? 'opacity-40 ' : '') +
        (insertMark
          ? "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded before:bg-sky-500 before:content-['']"
          : '')
      }
    >
      <div className="flex items-center gap-1.5">
        <GripVertical size={14} className="shrink-0 text-neutral-600" />
        <input
          type="color"
          value={layer.color}
          onChange={(e) => onColor(layer.id, e.target.value)}
          className="h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border-0 bg-transparent p-0"
          title="颜色"
        />
        <span className="flex-1 truncate text-sm text-neutral-200">
          {seriesDef(layer.series)?.label ?? layer.series}
        </span>
        <select
          value={encodeScale(layer.scale)}
          onChange={(e) => onScale(layer.id, decodeScale(e.target.value))}
          className={SELECT}
          title="挂哪根纵轴"
        >
          <option value="right">右轴</option>
          <option value="left">左轴</option>
          {overlays.map((s, i) => (
            <option key={s.id} value={`ov:${s.id}`}>
              独立轴 {i + 1}
            </option>
          ))}
          <option value="new">新独立轴</option>
        </select>
        <button
          type="button"
          onClick={() => onRemove(layer.id)}
          className="text-neutral-600 hover:text-neutral-200"
          title="删除"
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}
