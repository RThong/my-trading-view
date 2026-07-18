// AssetChart 的横向功能维度,每块一个 hook,组件只负责拼装 + JSX。
// 前提:每个 AssetChart 实例与一个标的绑定一辈子(App 用 keep-alive 渲染,
// 切 tab 不卸载),所以这里所有 effect 都是「挂载建/卸载销」,不再按标的 reset。
import useSWR from 'swr';
import type { Interval } from '../hooks/interval';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../lib/chart';
import { ivIndexByUnderlying } from '../../shared/marketCatalog';
import type { PaneDef, Spec, LineSpec } from './paneChart.types';

export type OptRow = { date: string; callIv: number; putIv: number; skew: number };
export type VrpRow = { date: string; iv: number; rv: number; vrp: number };
export type PriceBar = { date: string; open: number | null; high: number | null; low: number | null; close: number };

export const COLORS = {
  price: '#d4d4d8', // 现货图例文字(蜡烛本身用涨绿跌红)
  call: '#22c55e',
  put: '#ec4899',
  skew: '#3b82f6',
  iv: '#3b82f6',
  rv: '#f59e0b',
  vrp: '#22c55e',
};
const HISTORY_DAYS = 3650;

// 稳定空引用:data 未就绪时避免每次 render 新建 [] 触发图表 effect。
const NO_OPT: OptRow[] = [];
const NO_VRP: VrpRow[] = [];
const NO_PRICE: PriceBar[] = [];
// EOD 数据一会话内视为不变:关掉全部自动重验。模块级常量,引用稳定。
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** pane 元数据 + series 短名(右轴 tag / 左上图例同一命名源)。所有 tab 顶部都有现货 pane;
 *  有 vrpUnderlying 的再加 隐含/RV + VRP 两个 pane。 */
// 各标的 VRP 隐含腿用的波动率指数名(图例显示「隐含 (VXN)」等),由标的目录派生,
// 与 server VRP RECIPE 同源(单一真相,不再需要手动跨端同步)。
const IV_INDEX = ivIndexByUnderlying();

export function paneConfig(vrpUnderlying?: string) {
  const ivName = vrpUnderlying ? (IV_INDEX[vrpUnderlying] ?? 'IV') : 'IV';
  const seriesName: Record<string, string> = {
    price: '现货',
    call: 'Call IV',
    put: 'Put IV',
    skew: 'Skew',
    iv: `隐含 (${ivName})`,
    rv: '已实现 RV',
    vrp: 'VRP',
  };
  const paneDefs: PaneDef[] = [
    { key: 'price', label: '现货', series: ['price'] },
    { key: 'iv', label: 'IV', series: ['call', 'put'] },
    { key: 'skew', label: 'Skew', series: ['skew'] },
    ...(vrpUnderlying
      ? [
          { key: 'ivrv', label: '隐含/RV', series: ['iv', 'rv'] },
          { key: 'vrp', label: 'VRP', series: ['vrp'] },
        ]
      : []),
    // VX1−V3 期限结构已搬到情绪视角(见 regimeChart.hooks);.VIX 只到 skew。
  ];
  const desc: Record<string, string> = {
    price: '定义:标的现货价(蜡烛)。\n期权指标的锚;和下面 IV / skew / VRP 对照看价格与波动的关系。',
    iv: '定义:25Δ 看涨 / 看跌期权隐含波动率。\n市场对该标的未来波动的定价。\nCall vs Put 的高低差就是 skew 的来源。',
    skew: '定义:25Δ 风险逆转(put IV − call IV)。\n符号:高 = 25Δ put 比 call 贵;低 / 负 = call 比 put 贵。\n情绪含义按标的分:普通权益(SPY/QQQ/GLD 等)高 = 抢下行保护 / 避险;但 VIX 等波动率标的 call 常被抢(赌波动上冲),负值不等于自满。\n注意:高 IV 标的采样点被推出活跃区,skew 偏噪声。',
    ivrv: '定义:隐含波动率(IV)vs 截至当日的历史已实现波动率(RV)。\nIV 持续高于近期 RV = 期权偏贵;能否变成卖方收益还要看随后实现的波动 + 成本。',
    vrp: '定义:当日 IV − 近期历史 RV 的价差(不是前瞻可实现收益)。\n正 = IV 高于近期 RV(通常卖方占优,但要与随后实现波动比才算数);负 = IV 低于近期 RV / 应激。',
  };
  return { seriesName, paneDefs, desc, paneCount: paneDefs.length };
}

const toLine = (rows: Array<Record<string, unknown>>, key: string): LinePoint[] =>
  rows.map((r) => ({ time: r.date as string, value: r[key] as number }));
// OHLC 缺失(个别源)时退化成 close 的一字蜡烛,避免 setData 报错。
const toBars = (rows: PriceBar[]): Bar[] =>
  rows.map((r) => ({
    time: r.date,
    open: r.open ?? r.close,
    high: r.high ?? r.close,
    low: r.low ?? r.close,
    close: r.close,
  }));

/** 把数据按 interval 聚合成各 series 的 spec;pane 下标从 paneDefs 派生(谁含此 series)。 */
export function buildSpecs(
  opt: OptRow[],
  vrp: VrpRow[],
  price: PriceBar[],
  interval: Interval,
  vrpUnderlying: string | undefined,
  paneDefs: PaneDef[],
  seriesName: Record<string, string>,
): Spec[] {
  const paneOf = (key: string) => paneDefs.findIndex((d) => d.series.includes(key));
  const line = (key: string, rows: Array<Record<string, unknown>>, field: string, color: string): LineSpec => ({
    key,
    pane: paneOf(key),
    kind: 'line',
    color,
    title: seriesName[key],
    data: aggregate(toLine(rows, field), interval),
  });
  return [
    {
      key: 'price',
      pane: paneOf('price'),
      kind: 'candle',
      title: seriesName.price,
      data: aggregateBars(toBars(price), interval),
    },
    line('call', opt, 'callIv', COLORS.call),
    line('put', opt, 'putIv', COLORS.put),
    line('skew', opt, 'skew', COLORS.skew),
    ...(vrpUnderlying
      ? [line('iv', vrp, 'iv', COLORS.iv), line('rv', vrp, 'rv', COLORS.rv), line('vrp', vrp, 'vrp', COLORS.vrp)]
      : []),
  ];
}

// ── 数据维度 ──────────────────────────────────────────────────────────────
export function useAssetData(underlying: string, vrpUnderlying?: string) {
  // vrpUrl 为 null 时 SWR 原生跳过请求(.VIX 无 VRP)。
  const optUrl = `/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`;
  const vrpUrl = vrpUnderlying ? `/api/vrp/${encodeURIComponent(vrpUnderlying)}` : null;
  const priceUrl = `/api/price/${encodeURIComponent(underlying)}`;
  const { data: opt = NO_OPT, error: oe, isLoading: optLoading } = useSWR(optUrl, getJson<OptRow[]>, SWR_OPTS);
  const { data: vrp = NO_VRP, error: ve, isLoading: vrpLoading } = useSWR(vrpUrl, getJson<VrpRow[]>, SWR_OPTS);
  const {
    data: price = NO_PRICE,
    error: pe,
    isLoading: priceLoading,
  } = useSWR(priceUrl, getJson<PriceBar[]>, SWR_OPTS);
  return {
    opt,
    vrp,
    price,
    error: (oe ?? ve ?? pe) as Error | undefined,
    isLoading: optLoading || vrpLoading || priceLoading,
  };
}
