import { type DragEvent, useState } from 'react';
import { isCorrLayer, type ChartDoc, type PaneTarget } from './chartDoc';
import { LayerCard, type CardActions } from './LayerCard';
import { canLogScale, type LayerData } from './layerPoints';
import type { ChartDocActions } from './useChartDoc';

type Props = {
  doc: ChartDoc;
  data: Record<string, LayerData>;
  actions: CardActions & Pick<ChartDocActions, 'move'>;
};

const DRAG_TYPE = 'text/plain';
// 相关性格不接收拖放(它的 −1~1 轴不能与别的线共用,见 chartDoc 的 isCorrLayer)
const NO_DROP = { onDragOver: () => {}, onDrop: () => {} };

// 右侧下半:一格一个区块,区块里是该格的图层卡片。卡片整张可拖:
// 放到另一张卡片上 = 插到它前面(同格即调顺序);放到区块空白处 = 追加到该格末尾;
// 拖到最下面的虚线框 = 新开一格。
export function LayerList({ doc, data, actions }: Props) {
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
      if (id) actions.move(id, target);
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
      if (id) actions.move(id, paneId, layerId);
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
          {...(pane.layers.some(isCorrLayer) ? {} : dropTarget(pane.id))}
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
                doc={doc}
                layer={l}
                pane={pane}
                data={data[l.id]}
                canLog={canLogScale(pane, l.scale, data)}
                actions={actions}
                faded={dragging === l.id}
                insertMark={overCard === l.id && dragging !== l.id}
                drop={pane.layers.some(isCorrLayer) ? NO_DROP : cardDrop(pane.id, l.id)}
                onDragStart={startDrag(l.id)}
                onDragEnd={endDrag}
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
