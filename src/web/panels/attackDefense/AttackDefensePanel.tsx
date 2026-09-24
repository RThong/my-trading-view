// src/web/panels/AttackDefensePanel.tsx
// 攻防:上 QQQ 蜡烛、下 NOBL/QQQ 比值 + 绿(防守)/红(进攻)背景区 + 均线快线细色带。恒日频,不吃全局 interval。
// 薄壳:取 model(useAttackDefenseData)→ 纯 buildSpecs → 通用 pane 壳。
import { useRef } from 'react';
import { usePaneChartStack } from '../chart/paneChart.hooks';
import type { PaneDef } from '../chart/paneChart.types';
import { PaneChartView } from '../chart/PaneChartView';
import {
  useAttackDefenseData,
  buildAttackDefenseSpecs,
  RATIO_COLOR,
  MA_COLOR,
  FAST_MA,
  FAST_BAND,
  SWING_PCT,
} from './attackDefense.hooks';

const PANE_DEFS: PaneDef[] = [
  { key: 'qqq', label: 'QQQ', series: ['qqq'] },
  { key: 'ad', label: 'NOBL/QQQ', series: ['ad', 'ad-ma'] },
];
const SERIES_NAME = { qqq: 'QQQ', ad: 'NOBL/QQQ', 'ad-ma': `MA${FAST_MA}` };
const COLORS = { ad: RATIO_COLOR, 'ad-ma': MA_COLOR };
const DESC: Record<string, string> = {
  qqq: '定义:QQQ(纳指 100 ETF)蜡烛。\n进攻资产的价格参照。',
  ad: `定义:NOBL / QQQ 比值。\nNOBL = 标普红利贵族(防守),QQQ = 成长(进攻)。上行(绿)= 防守跑赢 = 避险;下行(红)= 进攻跑赢 = risk-on。恒日频。\n背景(慢,事后确认):ZigZag ${SWING_PCT * 100}% 反转阈值识别的上行 / 下行 regime;拐点回贴到极值日,是事后才知道的;末段未确认用淡色。\n底部细色带(快,当日可知):比值高于 ${FAST_MA} 日均线 ${FAST_BAND * 100}% 以上翻绿、低于 ${FAST_BAND * 100}% 以上翻红,带内保持。\n色带与背景同色 = 一致;色带先翻反色 = 预警(实测约 4 成是假警报)。\n盲区:全市场齐跌(如 2020-03)比值不动,本指标看不出。`,
};

export function AttackDefensePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { qqq, ratio, zones, fast, error, isLoading } = useAttackDefenseData();
  // 故意不 useMemo:usePaneChart 已内部按内容稳定化 specs(useStable/isDeepEqual),无需调用方 memo。
  const specs = buildAttackDefenseSpecs(qqq, ratio, zones, fast);
  const { order, collapsed, move, toggle, cells, hovering, tops, drawing, toggleDrawing, selection, deleteSelected } =
    usePaneChartStack(containerRef, PANE_DEFS, PANE_DEFS.length, specs, { storageKey: 'attackDefense' });

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
      drawing={drawing}
      toggleDrawing={toggleDrawing}
      selection={selection}
      deleteSelected={deleteSelected}
    />
  );
}
