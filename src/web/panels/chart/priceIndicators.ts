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
  series: { key: string; title: string; color: string; fillTo?: { key: string; color: string } }[];
  compute: (bars: Bar[]) => LinePoint[][];
};

// 周期与配色照用户常用行情 App(moomoo):5 橙、20 蓝、50 红、144 粉、169 紫、200 黄、365 绿。
const EMA_PERIODS: [number, string][] = [
  [5, '#d89050'],
  [20, '#3a72ce'],
  [50, '#bd445b'],
  [144, '#d77084'],
  [169, '#6a37a7'],
  [200, '#e9c444'],
  [365, '#2cc290'],
];
const BB_COLOR = '#a1a1aa'; // 2σ 标准带
const BB3_COLOR = '#71717a'; // 3σ 外层(同 moomoo BOLL(20,2,1,3) 的 UPPER3/LOWER3),压暗一档、不填色
const BB_FILL = 'rgba(96, 165, 250, 0.1)'; // 通道底色:淡蓝,压在蜡烛下层

export const INDICATORS: IndicatorDef[] = [
  // 一组均线是一个选项:开了就整组一起出。
  {
    id: 'ema',
    label: `EMA ${EMA_PERIODS.map(([n]) => n).join('/')}`,
    series: EMA_PERIODS.map(([n, color]) => ({ key: `ema${n}`, title: `EMA${n}`, color })),
    compute: (bars) => EMA_PERIODS.map(([n]) => ema(bars, n)),
  },
  // 只画上下轨:中轨 = SMA20,与 EMA20 几乎重合(差 ~0.3%),和 EMA 组同开时是重复的一条线。
  // 两层:2σ(标准布林带,填底色)+ 3σ 外层;顺序从上到下,图例同序。
  {
    id: 'bb',
    label: '布林带 20 (2σ/3σ)',
    series: [
      { key: 'bbUpper3', title: 'BB 上 3σ', color: BB3_COLOR },
      { key: 'bbUpper', title: 'BB 上 2σ', color: BB_COLOR, fillTo: { key: 'bbLower', color: BB_FILL } },
      { key: 'bbLower', title: 'BB 下 2σ', color: BB_COLOR },
      { key: 'bbLower3', title: 'BB 下 3σ', color: BB3_COLOR },
    ],
    compute: (bars) => {
      // k=1 时 upper − mid 就是 σ,各层按倍数推,一次滚动窗口算完。
      const rows = bollinger(bars, 20, 1);
      const band = (k: number) => rows.map((r) => ({ time: r.time, value: r.mid + k * (r.upper - r.mid) }));
      return [band(3), band(2), band(-2), band(-3)];
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

export type IndicatorLine = IndicatorDef['series'][number] & { data: LinePoint[] };

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
