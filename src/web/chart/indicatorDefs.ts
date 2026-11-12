// 内置指标表(同 TradingView 的内置指标:脚本 = 这里的一行,ChartDoc 里只存 id + 参数,计算不进 JSON)。
// 输入是一条序列画在图上的点(当收盘价用),所以对任何线都能算;按图上的点算 = 周线就用周 K 算(同 TradingView)。
// 口径照旧:ema / bollinger / macd / rsi 已与 moomoo 逐位对账(见 ./indicators)。
import { needsLogScale, type Bar, type LinePoint } from './core';
import { bollinger, ema, macd, rsi } from './indicators';

export type IndicatorId = 'ema' | 'bb' | 'macd' | 'rsi';
export const INDICATOR_IDS: readonly IndicatorId[] = ['ema', 'bb', 'macd', 'rsi'];

/** 一个指标画的一样东西:一条线,或一组柱(MACD 柱)。fillTo = 与另一条之间填色(布林带 2σ 通道) */
export type PlotSpec = {
  key: string;
  title: string;
  color: string;
  kind: 'line' | 'signed';
  fillTo?: { key: string; color: string };
  /** 挂在这条上的水平参考线(RSI 30/50/70):一组只挂一条,挂多条会在同一格重复画 */
  refLines?: { price: number; title: string }[];
};

export type IndicatorCtx = {
  /** 当前是日线 */
  daily: boolean;
  /** 365 年线是默认那组自动带上的(7×24 资产、没自定义周期):这种只在日线上画(周线 365 根 ≈ 7 年,没意义);
   *  用户自己写了 365 就照画 */
  autoYear: boolean;
};

type Def = {
  label: string;
  /** 默认画在哪:叠在源线那格(overlay),或新开一格(pane)。之后可以像普通图层一样挪格换轴 */
  place: 'overlay' | 'pane';
  /** 有可改周期的指标:默认周期 */
  periods?: number[];
  /** 画哪几样(与数据无关,先于数据定下 → 渲染层可以先建好 series) */
  plots: (periods: number[]) => PlotSpec[];
  /** 按 plots 的顺序给每样的点 */
  compute: (pts: LinePoint[], periods: number[], ctx: IndicatorCtx) => LinePoint[][];
};

// 周期与配色照用户常用行情 App(moomoo):5 橙、20 蓝、50 红、144 粉、169 紫、200 黄、365 绿
const EMA_COLORS: Record<number, string> = {
  5: '#d89050',
  20: '#3a72ce',
  50: '#bd445b',
  144: '#d77084',
  169: '#6a37a7',
  200: '#e9c444',
  365: '#2cc290',
};
const YEAR_EMA = 365;
// 没在上表里的周期(用户自己改的)按顺序取这几色
const EXTRA_COLORS = ['#22d3ee', '#a3e635', '#f472b6', '#fb923c', '#94a3b8'];
const BB_COLOR = '#a1a1aa'; // 2σ 标准带
const BB3_COLOR = '#71717a'; // 3σ 外层(同 moomoo BOLL(20,2,1,3) 的 UPPER3/LOWER3),压暗一档、不填色
const BB_FILL = 'rgba(96, 165, 250, 0.1)'; // 通道底色:淡蓝,压在蜡烛下层
// RSI 配色照 moomoo:6 橙 / 12 蓝 / 24 紫;MACD:DIF 橙 / DEA 蓝
const RSI_COLORS = ['#d89050', '#3a72ce', '#c04fd6'];
// 超卖 / 中轴 / 超买分界(同 TradingView / moomoo 的 RSI 默认水平线)
const RSI_LEVELS = [30, 50, 70];

function closes(pts: LinePoint[]) {
  return pts.map((p) => ({ time: p.time, close: p.value }));
}
function emaColor(n: number, i: number) {
  return EMA_COLORS[n] ?? EXTRA_COLORS[i % EXTRA_COLORS.length];
}

export const INDICATORS: Record<IndicatorId, Def> = {
  ema: {
    label: 'EMA',
    place: 'overlay',
    periods: [5, 20, 50, 144, 169, 200],
    plots: (periods) =>
      periods.map((n, i) => ({
        key: `ema${n}`,
        title: `EMA${n}`,
        color: emaColor(n, i),
        kind: 'line',
      })),
    compute: (pts, periods, { daily, autoYear }) => {
      const c = closes(pts);
      return periods.map((n) => (n === YEAR_EMA && autoYear && !daily ? [] : ema(c, n)));
    },
  },
  // 只画上下轨:中轨 = SMA20,与 EMA20 几乎重合(差 ~0.3%),和 EMA 同开时是重复的一条线。
  // 两层:2σ(标准布林带,填底色)+ 3σ 外层;顺序从上到下,图例同序
  bb: {
    label: '布林带 20 (2σ/3σ)',
    place: 'overlay',
    plots: () => [
      { key: 'upper3', title: '上 3σ', color: BB3_COLOR, kind: 'line' },
      { key: 'upper', title: '上 2σ', color: BB_COLOR, kind: 'line', fillTo: { key: 'lower', color: BB_FILL } },
      { key: 'lower', title: '下 2σ', color: BB_COLOR, kind: 'line' },
      { key: 'lower3', title: '下 3σ', color: BB3_COLOR, kind: 'line' },
    ],
    compute: (pts) => {
      const bars: Bar[] = pts.map((p) => ({
        time: p.time,
        open: p.value,
        high: p.value,
        low: p.value,
        close: p.value,
      }));
      // 跨数量级的(BTC)在 ln(价) 上算,带宽按比例、对数轴上对称:算术口径在抛物线行情里下轨贴 0 / 变负
      // (BTC 周线 3σ 有 90 周 ≤0)。代价:BTC 读数不再对齐 moomoo
      // 只有全是正值才谈得上对数:VRP、skew、利差这类穿 0 的线,needsLogScale 只看正值之比会误判,取对数得 NaN
      const log = bars.every((b) => b.close > 0) && needsLogScale(bars);
      const rows = bollinger(log ? bars.map((b) => ({ ...b, close: Math.log(b.close) })) : bars, 20, 1);
      const toPrice = log ? Math.exp : (v: number) => v;
      // k=1 时 upper − mid 就是 σ,各层按倍数推,一次滚动窗口算完
      // 全正的序列(价格)上 ≤0 的轨道点滤掉:VIX / USO 的下 3σ 在 2018-02、2020-03 会算成负价,进了自动缩放会把价格轴
      // 拉到 0 以下、K 线压扁(同旧期权页);穿 0 的序列(VRP、skew)负值是真的,照留
      const positive = bars.every((b) => b.close > 0);
      const band = (k: number) =>
        rows
          .map((r) => ({ time: r.time, value: toPrice(r.mid + k * (r.upper - r.mid)) }))
          .filter((p) => !positive || p.value > 0);
      return [band(3), band(2), band(-2), band(-3)];
    },
  },
  macd: {
    label: 'MACD 12,26,9',
    place: 'pane',
    plots: () => [
      { key: 'hist', title: 'MACD', color: '#c04fd6', kind: 'signed' },
      { key: 'dif', title: 'DIF', color: '#d89050', kind: 'line' },
      { key: 'dea', title: 'DEA', color: '#3a72ce', kind: 'line' },
    ],
    compute: (pts) => {
      const rows = macd(closes(pts), 12, 26, 9);
      const of = (k: 'hist' | 'dif' | 'dea') => rows.map((r) => ({ time: r.time, value: r[k] }));
      return [of('hist'), of('dif'), of('dea')];
    },
  },
  rsi: {
    label: 'RSI',
    place: 'pane',
    periods: [6, 12, 24],
    plots: (periods) => {
      // 分界线挂在周期最短的那条:它暖机最短、数据最多,格里只要有 RSI 就有它(挂在没数据的线上,价位线画不出来)
      const host = periods.indexOf(Math.min(...periods));
      return periods.map((n, i) => ({
        key: `rsi${n}`,
        title: `RSI${n}`,
        color: RSI_COLORS[i % RSI_COLORS.length],
        kind: 'line',
        ...(i === host && { refLines: RSI_LEVELS.map((v) => ({ price: v, title: '' })) }),
      }));
    },
    compute: (pts, periods) => periods.map((n) => rsi(closes(pts), n)),
  },
};

/**
 * 实际用的周期:写了就照写的;没写用默认那组 —— 7×24 资产(BTC,一年 365 天都在交易)的 EMA 默认再带一条 365 年线
 * (美股一年 ~252 根,365 根没意义)。自定义时不自动加(用户定):要年线就自己写上 365
 */
export function periodsOf(id: IndicatorId, periods: number[] | undefined, sevenDay = false): number[] {
  if (periods) return periods;
  const base = INDICATORS[id].periods ?? [];
  return id === 'ema' && sevenDay ? [...base, YEAR_EMA] : base;
}
