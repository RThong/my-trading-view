// 叠加图层的两根轴对齐:B 挂自己的轴、按原值画;每帧读 A 轴当前的上下限,按基准段比例换算成 B 轴的上下限写回。
// 不管 A 的轴是怎么变的(缩放时间触发的自动缩放、手动拖轴),照着它当前的范围换算,两条线就一直叠得上。
import { type RefObject, useEffect, useRef } from 'react';
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';
import { type ChartDoc, scaleMode } from '../../../views/chartDoc/chartDoc';
import type { LayerSeries } from '../../../views/chartDoc/useDocChart';

/** a ≈ alpha + beta × b 反过来:A 轴的范围对应的 B 轴范围(beta < 0 时上下颠倒,由 B 轴的倒轴抵消)。 */
export function mapRange(
  { from, to }: { from: number; to: number },
  { alpha, beta }: { alpha: number; beta: number },
): { from: number; to: number } {
  const [lo, hi] = [(from - alpha) / beta, (to - alpha) / beta].sort((x, y) => x - y);
  return { from: lo, to: hi };
}

function same(x: number, y: number) {
  return Math.abs(x - y) <= Math.abs(y) * 1e-9;
}

export function useFitSync(chartRef: RefObject<IChartApi | null>, seriesRef: RefObject<LayerSeries>, doc: ChartDoc) {
  // 对齐过的 B 轴(格 + 轴 id)。取消叠加后 B 还独占这根轴就停在当时的范围(画面不跳,双击恢复自动);
  // B 被删 / 挪走、或别的线挂上这根轴时才转回自动缩放,否则那条线会落在旧范围外。只在 effect 里读写
  const syncedRef = useRef(
    new Map<string, { pane: IPaneApi<Time>; paneId: string; layerId: string; scaleId: string }>(),
  );

  useEffect(() => {
    const links = doc.panes.flatMap((p) =>
      p.layers.flatMap((l) =>
        l.fit
          ? [
              {
                key: `${p.id}|${l.id}|${l.scale}`,
                paneId: p.id,
                a: l.fit.target,
                b: l.id,
                scaleId: l.scale,
                params: l.fit,
              },
            ]
          : [],
      ),
    );
    const synced = syncedRef.current;
    // 键带上格:B 换了格还挂同名的 left / right,只认轴名会把旧格那根轴当成「还在对齐」、忘了恢复
    const linked = new Set(links.map((l) => l.key));
    // 格被删了不用管
    const live = new Set(chartRef.current?.panes() ?? []);
    // 冻结只在 B 仍独占这根轴、且轴还是普通坐标时成立:切到对数 / 百分比后手动范围的单位对不上,转回自动
    const frozen = (paneId: string, layerId: string, scaleId: string) => {
      const p = doc.panes.find((x) => x.id === paneId);
      const onScale = p?.layers.filter((l) => l.scale === scaleId) ?? [];
      const sc = p?.scales.find((s) => s.id === scaleId);
      return onScale.length === 1 && onScale[0].id === layerId && scaleMode(sc) === 'normal';
    };
    const stillOn = (paneId: string, layerId: string, scaleId: string) =>
      !!doc.panes.find((x) => x.id === paneId)?.layers.some((l) => l.id === layerId && l.scale === scaleId);
    [...synced].forEach(([key, { pane, paneId, layerId, scaleId }]) => {
      if (linked.has(key) || frozen(paneId, layerId, scaleId)) return;
      // B 还挂着这根轴:从 B 自己的 series 取轴(格换了下标后记下的格对象可能已装着别的格,按它取独立轴会抛错)。
      // B 走了:独立轴上不会剩别的线(有线挂上来时这条早被清掉了),已被回收;只剩内置左右轴要转回自动
      if (stillOn(paneId, layerId, scaleId)) seriesRef.current.get(layerId)?.priceScale().setAutoScale(true);
      else if (live.has(pane) && (scaleId === 'left' || scaleId === 'right'))
        pane.priceScale(scaleId).setAutoScale(true);
      synced.delete(key);
    });
    if (links.length === 0) return;

    // ponytail: 每帧轮询(lw-charts 没有「纵轴范围变了」的事件可订阅),最多慢一帧;范围没变时只比较两个数
    let raf = 0;
    const tick = () => {
      links.forEach(({ key, paneId, a, b, scaleId, params }) => {
        const sa = seriesRef.current.get(a);
        const sb = seriesRef.current.get(b);
        const range = sa?.priceScale().getVisibleRange();
        if (!sb || !range) return;

        const want = mapRange(range, params);
        const ps = sb.priceScale();
        const cur = ps.getVisibleRange();
        if (cur && same(cur.from, want.from) && same(cur.to, want.to)) return;
        ps.setVisibleRange(want);
        synced.set(key, { pane: sb.getPane(), paneId, layerId: b, scaleId });
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [chartRef, seriesRef, doc]);
}
