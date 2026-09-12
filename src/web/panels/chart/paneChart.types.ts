// 通用多 pane 图表栈的类型(与数据源无关)。原在 assetChart.hooks.ts,因被
// AssetChart / RegimeChart / AttackDefensePanel 三方复用,抽到中立模块,校正依赖方向。
import type { ISeriesApi } from 'lightweight-charts';
import type { LinePoint, Bar } from '../../lib/chart';

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
  /** 阶梯线。低频序列(季频 r*)专用:两次发布之间值就是不变的,平滑折线是在伪造发布间的信息。 */
  step?: boolean;
  /**
   * 价格轴的**上限框** `[lo, hi]`:自动缩放出来的范围与它求交(见 `lib/chart` 的 `clampPriceRange`)。
   * 只影响可视轴范围 —— 不改数据、不改 hover 读数、不改导出。
   *
   * 给「日常波动很窄、但带真实极端单点」的序列用(开工率季节 z 的 Uri 寒潮 −27、
   * 同比线的 2020 停摆基数 ±60)。**刻意做成声明式的两个数,不开 autoscaleInfoProvider 回调**:
   * 这里要的只是一个框,把 lightweight-charts 的回调签名漏进 spec 层,
   * 等于让每个调用方自己去实现「求交 + 倒挂退回」那套语义,迟早各写各的。
   */
  clampVisibleTo?: [number, number];
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
