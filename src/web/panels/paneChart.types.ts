// 通用多 pane 图表栈的类型(与数据源无关)。原在 assetChart.hooks.ts,因被
// AssetChart / RegimeChart / AttackDefensePanel 三方复用,抽到中立模块,校正依赖方向。
import type { ISeriesApi } from 'lightweight-charts';
import type { LinePoint, Bar } from '../lib/chart';

export type PaneDef = { key: string; label: string; series: string[] };
export type LineSpec = {
  key: string;
  pane: number;
  kind: 'line';
  color: string;
  title: string;
  data: LinePoint[];
  baseline?: number;
  refLines?: { price: number; title: string }[];
};
export type CandleSpec = { key: string; pane: number; kind: 'candle'; title: string; data: Bar[] };
export type HistoPoint = { time: string; value: number; color: string };
// priceScaleId 给定 → 挂独立 overlay 轴(自身 0–1 自缩放),用来画满高度背景带(极端期着色)。
export type HistoSpec = {
  key: string;
  pane: number;
  kind: 'histogram';
  title: string;
  data: HistoPoint[];
  baseline?: number;
  priceScaleId?: string;
};
export type Spec = LineSpec | CandleSpec | HistoSpec;
export type LegendCell =
  | { kind: 'candle'; open: number; high: number; low: number; close: number; delta: number | null; pct: number | null }
  | { kind: 'line'; value: number; delta: number | null; pct: number | null };
export type AnySeries = ISeriesApi<'Line' | 'Candlestick' | 'Histogram'>;
