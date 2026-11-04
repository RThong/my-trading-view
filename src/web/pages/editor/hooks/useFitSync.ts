// 叠加图层的两根轴对齐:B 挂自己的轴、按原值画;每帧读 A 轴当前的上下限,按基准段比例换算成 B 轴的上下限写回。
// 不管 A 的轴是怎么变的(缩放时间触发的自动缩放、手动拖轴),照着它当前的范围换算,两条线就一直叠得上。
import { type RefObject, useEffect, useRef } from 'react';
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';
import type { ChartDoc } from '../../../views/chartDoc/chartDoc';
import type { LayerSeries } from './useEditorChart';

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
  // 上一轮对齐过的 B 轴(格 + 轴 id):叠加取消 / 线被删后要把那根轴转回自动缩放,否则它停在手动范围里,
  // 之后挂上这根轴的线会落在旧范围外。只在 effect 里读写
  const syncedRef = useRef(new Map<string, { pane: IPaneApi<Time>; scaleId: string }>());

  useEffect(() => {
    const links = doc.panes.flatMap((p) =>
      p.layers.flatMap((l) =>
        l.fit ? [{ key: `${p.id}|${l.id}|${l.scale}`, a: l.fit.target, b: l.id, scaleId: l.scale, params: l.fit }] : [],
      ),
    );
    const synced = syncedRef.current;
    // 键带上格:B 换了格还挂同名的 left / right,只认轴名会把旧格那根轴当成「还在对齐」、忘了恢复
    const linked = new Set(links.map((l) => l.key));
    // 只有内置左 / 右轴需要恢复:独立轴上没线了 lw-charts 会直接回收,再去取它会抛错;格被删了也不用管
    const live = new Set(chartRef.current?.panes() ?? []);
    [...synced].forEach(([key, { pane, scaleId }]) => {
      if (linked.has(key)) return;
      if (live.has(pane) && (scaleId === 'left' || scaleId === 'right')) pane.priceScale(scaleId).setAutoScale(true);
      synced.delete(key);
    });
    if (links.length === 0) return;

    // ponytail: 每帧轮询(lw-charts 没有「纵轴范围变了」的事件可订阅),最多慢一帧;范围没变时只比较两个数
    let raf = 0;
    const tick = () => {
      links.forEach(({ key, a, b, scaleId, params }) => {
        const sa = seriesRef.current.get(a);
        const sb = seriesRef.current.get(b);
        const range = sa?.priceScale().getVisibleRange();
        if (!sb || !range) return;

        const want = mapRange(range, params);
        const ps = sb.priceScale();
        const cur = ps.getVisibleRange();
        if (cur && same(cur.from, want.from) && same(cur.to, want.to)) return;
        ps.setVisibleRange(want);
        synced.set(key, { pane: sb.getPane(), scaleId });
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [chartRef, seriesRef, doc]);
}
