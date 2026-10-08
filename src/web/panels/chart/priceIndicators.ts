// K 线叠加指标(EMA / 布林带):注册表 + 勾选状态 + 挂到蜡烛 pane。
// 每个指标是表里一行,彼此解耦;只做叠加在蜡烛上的(不新开 pane,pane 数每实例固定)。
import { useMemo, useState } from 'react';
import { ema, bollinger } from '../../lib/indicators';
import type { Bar, LinePoint } from '../../lib/chart';
import type { PaneDef, Spec } from './paneChart.types';

type IndicatorDef = {
  id: string;
  label: string;
  /** 产出的线(key 全局唯一,进图例/折叠);compute 结果与之按下标一一对应。 */
  series: { key: string; title: string; color: string }[];
  compute: (bars: Bar[]) => LinePoint[][];
};

// 周期与配色照用户常用行情 App(moomoo):5 橙、20 蓝、50 红、144 粉、169 紫、200 黄、365 绿;
// 120 是本面板自有的一条,那边没有对应色,取中性灰免得和其它线撞色。
const EMA_PERIODS: [number, string][] = [
  [5, '#d89050'],
  [20, '#3a72ce'],
  [50, '#bd445b'],
  [120, '#a1a1aa'],
  [144, '#d77084'],
  [169, '#6a37a7'],
  [200, '#e9c444'],
  [365, '#2cc290'],
];
const BB_COLOR = '#71717a';

export const INDICATORS: IndicatorDef[] = [
  // 一组均线是一个选项:开了就整组一起出。
  {
    id: 'ema',
    label: `EMA ${EMA_PERIODS.map(([n]) => n).join('/')}`,
    series: EMA_PERIODS.map(([n, color]) => ({ key: `ema${n}`, title: `EMA${n}`, color })),
    compute: (bars) => EMA_PERIODS.map(([n]) => ema(bars, n)),
  },
  {
    id: 'bb',
    label: '布林带 20,2',
    series: [
      { key: 'bbUpper', title: 'BB 上', color: BB_COLOR },
      { key: 'bbMid', title: 'BB 中', color: BB_COLOR },
      { key: 'bbLower', title: 'BB 下', color: BB_COLOR },
    ],
    compute: (bars) => {
      const rows = bollinger(bars, 20, 2);
      return (['upper', 'mid', 'lower'] as const).map((f) => rows.map((r) => ({ time: r.time, value: r[f] })));
    },
  },
];

const storageKeyOf = (key: string) => `indicators:${key}`;

function loadIds(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKeyOf(key)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 勾选状态(按 storageKey 记在 localStorage);active 恒按注册表顺序,与勾选先后无关。 */
export function useIndicatorSelection(storageKey: string) {
  const [ids, setIds] = useState<string[]>(() => loadIds(storageKey));

  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setIds(next);
    try {
      localStorage.setItem(storageKeyOf(storageKey), JSON.stringify(next));
    } catch {
      /* 落盘失败不阻断交互 */
    }
  };

  // 引用随 ids 稳定:调用方拿它当 useMemo 依赖缓存指标计算,不必自己再包一层。
  const active = useMemo(() => INDICATORS.filter((d) => ids.includes(d.id)), [ids]);
  return { active, toggle };
}

export type IndicatorLine = { key: string; title: string; color: string; data: LinePoint[] };

/** 算选中指标的线(重活:8 条 EMA + 布林带滚动窗口)。bars = 已按周期聚合的蜡烛,周线 EMA = 周收盘的 EMA。 */
export function computeIndicatorLines(active: IndicatorDef[], bars: Bar[]): IndicatorLine[] {
  return active.flatMap((d) => d.compute(bars).map((data, i) => ({ ...d.series[i], data })));
}

/**
 * 把选中指标挂到蜡烛(candleKey)所在 pane:paneDefs 该 pane 追加 series(图例 / 折叠才认得),
 * specs 追加线(lines 由 computeIndicatorLines 预先算好,便于调用方缓存)。
 * 没有蜡烛 spec 时只挂图例,不出线。
 */
export function withIndicators(
  active: IndicatorDef[],
  lines: IndicatorLine[],
  candleKey: string,
  paneDefs: PaneDef[],
  specs: Spec[],
  seriesName: Record<string, string>,
  colors: Record<string, string>,
) {
  const series = active.flatMap((d) => d.series);
  const candle = specs.find((s) => s.kind === 'candle' && s.key === candleKey);
  const lineSpecs: Spec[] = candle
    ? lines.map((l) => ({ ...l, pane: candle.pane, kind: 'line' as const, overlay: true }))
    : [];

  return {
    paneDefs: paneDefs.map((p) =>
      p.series.includes(candleKey) ? { ...p, series: [...p.series, ...series.map((s) => s.key)] } : p,
    ),
    specs: [...specs, ...lineSpecs],
    seriesName: { ...seriesName, ...Object.fromEntries(series.map((s) => [s.key, s.title])) },
    colors: { ...colors, ...Object.fromEntries(series.map((s) => [s.key, s.color])) },
  };
}
