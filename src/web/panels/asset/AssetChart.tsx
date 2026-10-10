import { useMemo, useRef } from 'react';
import type { Interval } from '../../hooks/interval';
import { COLORS, buildSpecs, paneConfig, toBars, useAssetData } from './assetChart.hooks';
import { aggregateBars } from '../../lib/chart';
import { usePaneChartStack } from '../chart/paneChart.hooks';
import { PaneChartView } from '../chart/PaneChartView';
import { INDICATORS, computeIndicatorLines, useIndicatorSelection, withIndicators } from '../chart/priceIndicators';
import { OscillatorPanel } from '../chart/OscillatorPanel';
import { OSC_IDS, OSC_OPTIONS } from '../chart/oscillator.hooks';

// 一个资产的指标放进同一个 chart 的多个 pane(共享时间轴),顶部恒为现货蜡烛:
//   pane0 现货(OHLC)· pane1 25Δ call/put IV · pane2 skew · [pane3 隐含vs已实现RV · pane4 VRP]
// 后两个 pane 仅有免费波动率指数的标的有(SPY/QQQ/GLD/USO/BTC,vrpUnderlying 给定时);
// 无对应指数的(.VIX/TLT)只到 skew(3 pane)。pane 集合由 paneConfig 决定。
// 各横向功能(取数/引擎/布局/图例)拆进 ./assetChart.hooks,本组件只拼装 + JSX。
// 实例与标的绑定一辈子(App keep-alive),故无需按标的 reset。
export function AssetChart({
  interval,
  underlying,
  vrpUnderlying,
}: {
  interval: Interval;
  underlying: string;
  vrpUnderlying?: string;
}) {
  const label = underlying.replace(/^\./, '');
  // 每渲染直接算(paneConfig 是查表,便宜);paneDefs 的引用稳定由 usePaneLayout 内部 useStable 负责,无需在此 memo。
  const base = paneConfig(vrpUnderlying);
  const { paneCount, desc } = base;
  const containerRef = useRef<HTMLDivElement>(null);
  const storageKey = `asset:${underlying}`;

  const { opt, vrp, price, error, isLoading } = useAssetData(underlying, vrpUnderlying);
  const indicators = useIndicatorSelection(storageKey);
  // 叠加指标挂在现货蜡烛上,并把线并进现货 pane 的图例 / 折叠。
  // 计算缓存住:十字线每动一下组件都重渲染,长历史上每次重算 8 条 EMA + 布林带是白耗。
  const bars = useMemo(() => aggregateBars(toBars(price), interval), [price, interval]);
  const lines = useMemo(() => computeIndicatorLines(indicators.active, bars), [indicators.active, bars]);
  const { paneDefs, specs, seriesName, colors } = withIndicators(
    indicators.active,
    lines,
    'price',
    base.paneDefs,
    buildSpecs(opt, vrp, price, interval, vrpUnderlying, base.paneDefs, base.seriesName),
    base.seriesName,
    COLORS,
  );
  const {
    order,
    collapsed,
    move,
    toggle,
    cells,
    hovering,
    tops,
    drawing,
    toggleDrawing,
    selection,
    deleteSelected,
    solo,
    chartRef,
  } = usePaneChartStack(containerRef, paneDefs, paneCount, specs, { storageKey });

  // 副图(MACD / RSI)只在只展开现货格时出现:否则主图已被多格瓜分,再压两张副图读不了。
  // 勾选状态保留,展开别的格时只是暂不显示,收回去自动恢复。
  const onlyPrice = paneDefs.every((p) => p.key === 'price' || collapsed.has(p.key));
  const oscIds = OSC_IDS.filter((id) => onlyPrice && indicators.ids.includes(id));
  const activeIds = [...indicators.active.map((d) => d.id), ...oscIds];

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <PaneChartView
          containerRef={containerRef}
          paneDefs={paneDefs}
          paneCount={paneCount}
          order={order}
          collapsed={collapsed}
          move={move}
          toggle={toggle}
          cells={cells}
          hovering={hovering}
          tops={tops}
          seriesName={seriesName}
          colors={colors}
          isLoading={isLoading}
          error={error}
          errorLabel={label}
          desc={desc}
          drawing={drawing}
          toggleDrawing={toggleDrawing}
          selection={selection}
          deleteSelected={deleteSelected}
          solo={{ label: '只看现货', active: onlyPrice, onClick: () => solo('price') }}
          indicators={{
            options: [...INDICATORS, ...OSC_OPTIONS],
            active: activeIds,
            toggle: indicators.toggle,
            disabled: onlyPrice ? undefined : { ids: OSC_IDS, hint: '点「只看现货」后可用' },
          }}
        />
      </div>
      {oscIds.length > 0 && <OscillatorPanel ids={oscIds} bars={bars} mainChartRef={chartRef} />}
    </div>
  );
}
