// src/web/panels/AttackDefensePanel.tsx
import { useRef } from 'react';
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
const DESC: Record<string, string> = {
  qqq: '定义:QQQ(纳指 100 ETF)蜡烛。\n进攻资产的价格参照。',
  ad: '定义:NOBL / QQQ 比值。\nNOBL = 标普红利贵族(防守),QQQ = 成长(进攻)。\n绿 / 红 = ZigZag(20% 反转阈值)识别的上行 / 下行 regime,不是逐日涨跌色;未确认腿用淡色。\n上行(绿)= 防守跑赢 = 避险;下行(红)= 进攻跑赢 = risk-on。恒日频。',
};

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

export function AttackDefensePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const qq = useSWR<PriceBar[]>('/api/price/QQQ', getJson, SWR_OPTS);
  const nb = useSWR<PriceBar[]>('/api/price/NOBL', getJson, SWR_OPTS);

  const qqq = qq.data ?? [];
  const nobl = nb.data ?? [];
  const ratio = ratioSeries(nobl, qqq);
  const zones = zigzagRegimes(ratio, SWING_PCT);
  const bgColor = (regime: Regime, pending: boolean) =>
    regime === 'defense'
      ? pending
        ? BG_GREEN_DIM
        : BG_GREEN
      : regime === 'offense'
        ? pending
          ? BG_RED_DIM
          : BG_RED
        : BG_NONE;
  // 故意不 useMemo:usePaneChart 已内部按内容稳定化 specs(useStable/isDeepEqual),无需调用方 memo 保正确。
  // (数据量小,每帧重算 sub-ms;不必仿 AssetChart/RegimeChart 的 memo。)
  const specs: Spec[] = [
    {
      key: 'qqq',
      pane: 0,
      kind: 'candle',
      title: 'QQQ',
      data: qqq.map((b) => ({
        time: b.date,
        open: b.open ?? b.close,
        high: b.high ?? b.close,
        low: b.low ?? b.close,
        close: b.close,
      })),
    },
    {
      key: 'ad-bg',
      pane: 1,
      kind: 'histogram',
      title: '',
      priceScaleId: 'bg-ad',
      data: zones.map((z) => ({
        time: z.date,
        value: z.regime === 'neutral' ? 0 : 1,
        color: bgColor(z.regime, z.pending),
      })),
    },
    {
      key: 'ad',
      pane: 1,
      kind: 'line',
      color: RATIO_COLOR,
      title: 'NOBL/QQQ',
      data: ratio.map((p) => ({ time: p.date, value: p.value })),
    },
  ];

  const { order, collapsed, move, toggle, cells, hovering, tops } = usePaneChartStack(
    containerRef,
    PANE_DEFS,
    PANE_DEFS.length,
    specs,
  );

  const error = (qq.error ?? nb.error) as Error | undefined;
  const isLoading = qq.isLoading || nb.isLoading;

  return (
    <PaneChartView
      containerRef={containerRef}
      paneDefs={PANE_DEFS}
      paneCount={PANE_DEFS.length}
      order={order}
      collapsed={collapsed}
      move={move}
      toggle={toggle}
      cells={cells}
      hovering={hovering}
      tops={tops}
      seriesName={SERIES_NAME}
      colors={COLORS}
      isLoading={isLoading}
      error={error}
      desc={DESC}
    />
  );
}
