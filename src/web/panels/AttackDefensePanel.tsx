// src/web/panels/AttackDefensePanel.tsx
import { useMemo, useRef } from 'react';
import useSWR from 'swr';
import { usePaneChartStack, type Spec, type PaneDef, type PriceBar } from './assetChart.hooks';
import { PaneChartView } from './PaneChartView';
import { ratioSeries, SWING_PCT } from './attackDefense.hooks';
import { zigzagRegimes, type Regime } from '../lib/zigzag';

// 攻防:上 QQQ 蜡烛、下 NOBL/QQQ 比值 + 绿(防守)/红(进攻)背景区。恒日频,不吃全局 interval。
const BG_GREEN = 'rgba(34,197,94,0.35)';
const BG_RED = 'rgba(239,68,68,0.35)';
const BG_GREEN_DIM = 'rgba(34,197,94,0.15)'; // pending 待定腿:更淡
const BG_RED_DIM = 'rgba(239,68,68,0.15)';
const BG_NONE = 'rgba(0,0,0,0)';
const RATIO_COLOR = '#d4d4d8'; // 中性亮线,压在红绿背景上清楚

const PANE_DEFS: PaneDef[] = [
  { key: 'qqq', label: 'QQQ', series: ['qqq'] },
  { key: 'ad', label: 'NOBL/QQQ', series: ['ad'] },
];
const SERIES_NAME = { qqq: 'QQQ', ad: 'NOBL/QQQ' };
const COLORS = { ad: RATIO_COLOR };

const getJson = (url: string) => fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

export function AttackDefensePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const qq = useSWR<PriceBar[]>('/api/price/QQQ', getJson, SWR_OPTS);
  const nb = useSWR<PriceBar[]>('/api/price/NOBL', getJson, SWR_OPTS);

  // specs 必须 memo:否则每渲染都是新数组引用,usePaneChart 的 [specs] effect 每帧重跑并 setState
  // → Maximum update depth(无限循环)。仅在两条价数据变化时重算(对齐 RegimeChart 的做法)。
  const specs: Spec[] = useMemo(() => {
    const qqq = qq.data ?? [];
    const nobl = nb.data ?? [];
    const ratio = ratioSeries(nobl, qqq);
    const zones = zigzagRegimes(ratio, SWING_PCT);
    const bgColor = (regime: Regime, pending: boolean) =>
      regime === 'defense' ? (pending ? BG_GREEN_DIM : BG_GREEN)
      : regime === 'offense' ? (pending ? BG_RED_DIM : BG_RED)
      : BG_NONE;
    return [
      { key: 'qqq', pane: 0, kind: 'candle', title: 'QQQ',
        data: qqq.map((b) => ({ time: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close })) },
      // 背景先画(z-order 在线下方);全高靠 priceScaleId。
      { key: 'ad-bg', pane: 1, kind: 'histogram', title: '', priceScaleId: 'bg-ad',
        data: zones.map((z) => ({ time: z.date, value: z.regime === 'neutral' ? 0 : 1, color: bgColor(z.regime, z.pending) })) },
      { key: 'ad', pane: 1, kind: 'line', color: RATIO_COLOR, title: 'NOBL/QQQ',
        data: ratio.map((p) => ({ time: p.date, value: p.value })) },
    ];
  }, [qq.data, nb.data]);

  const { order, collapsed, move, toggle, cells, hovering, tops } = usePaneChartStack(containerRef, PANE_DEFS, PANE_DEFS.length, specs);

  const error = (qq.error ?? nb.error) as Error | undefined;
  const isLoading = qq.isLoading || nb.isLoading;

  return (
    <PaneChartView
      containerRef={containerRef} paneDefs={PANE_DEFS} paneCount={PANE_DEFS.length}
      order={order} collapsed={collapsed} move={move} toggle={toggle}
      cells={cells} hovering={hovering} tops={tops}
      seriesName={SERIES_NAME} colors={COLORS} isLoading={isLoading} error={error}
    />
  );
}
