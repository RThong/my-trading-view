// src/web/panels/AttackDefensePanel.tsx
// 攻防:上 QQQ 蜡烛、下 NOBL/QQQ 比值 + 绿(防守)/红(进攻)背景区。恒日频,不吃全局 interval。
// 薄壳:取 model(useAttackDefenseData)→ 纯 buildSpecs → 通用 pane 壳。
import { useRef } from 'react';
import { usePaneChartStack } from '../chart/paneChart.hooks';
import type { PaneDef } from '../chart/paneChart.types';
import { PaneChartView } from '../chart/PaneChartView';
import { useAttackDefenseData, buildAttackDefenseSpecs, RATIO_COLOR } from './attackDefense.hooks';

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

export function AttackDefensePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { qqq, ratio, zones, error, isLoading } = useAttackDefenseData();
  // 故意不 useMemo:usePaneChart 已内部按内容稳定化 specs(useStable/isDeepEqual),无需调用方 memo。
  const specs = buildAttackDefenseSpecs(qqq, ratio, zones);
  const { order, collapsed, move, toggle, cells, hovering, tops } = usePaneChartStack(
    containerRef,
    PANE_DEFS,
    PANE_DEFS.length,
    specs,
  );

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
