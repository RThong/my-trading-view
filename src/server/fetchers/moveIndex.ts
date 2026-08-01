// MOVE(ICE BofA 债市波动率指数)。Yahoo `^MOVE` 的日线 close 会整段返回 null
// (2026-07-20 起持续至今),但同一响应的 meta 仍带当日值 —— 数据在 Yahoo 手上,
// 只是没写进时间序列。故:序列缺的当天用 meta 补,整条序列落库做本地镜像;
// 读时 Yahoo 优先、库兜底(mergeMove),源自愈后旧值自动被真值盖掉,无需清理。
// (带 caret;无 caret 的 MOVE 是 Movado 股票。)
import YahooFinance from 'yahoo-finance2';
import { HISTORY_START_DATE } from '../config';
import { nyParts } from '../jobs/tradingCalendar';

export type MovePoint = { date: string; value: number };
/** meta 快照点 = 序列点 + 原始时间戳(毫秒)。 */
export type MetaPoint = MovePoint & { at: number };

type MoveChart = {
  meta: { regularMarketPrice?: number; regularMarketTime?: Date | number };
  quotes: { date: Date; close?: number | null }[];
};

export type MoveChartClient = (since: Date) => Promise<MoveChart>;

function defaultMoveClient(): MoveChartClient {
  const instance = new YahooFinance();
  return (since) => instance.chart('^MOVE', { period1: since, interval: '1d' }) as unknown as Promise<MoveChart>;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 时间戳 → 毫秒。Date(可能是 Invalid Date)与 epoch 秒都认;认不出返回 NaN。 */
function toMillis(stamp: Date | number | undefined): number {
  if (stamp instanceof Date) return stamp.getTime(); // Invalid Date → NaN
  return typeof stamp === 'number' ? stamp * 1000 : Number.NaN;
}

const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;
const HISTORY_START_MS = Date.parse(HISTORY_START_DATE);

/**
 * meta 的当日快照点(日线断供时的唯一来源);价或时间戳不可用 → null,不写垃圾值。
 * 额外回传 at(时间戳毫秒):落库前要靠它判断这是收盘值还是盘中值(见 moveSnapshot)。
 */
export function metaPoint(meta: MoveChart['meta'], now: number = Date.now()): MetaPoint | null {
  const value = meta.regularMarketPrice;
  const millis = toMillis(meta.regularMarketTime);

  // typeof 不只是防御,也是 TS 的收窄依据(Number.isFinite 不是类型守卫)。
  // value <= 0:schema 里 regularMarketPrice 是 required,源缺值时更可能填 0 占位而不是消失,
  // 而 MOVE 取不到 0 —— 同 ICE CDS 的「价 ≤0 当缺价滤掉」。
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;

  // 时间戳上下界都要挡:早于建库起点的(0/负数/1 秒都算)写成 1970,远期值(比如单位变成毫秒)
  // 写成公元五万年,而落库后按设计没有删除路径,清不掉。NaN / Infinity 由 isFinite 一并挡下。
  if (!Number.isFinite(millis) || millis < HISTORY_START_MS || millis > now + TWO_DAYS_MS) return null;

  // 日期按 **ET 日**截,不按 UTC 日:meta 是收盘后打的戳,晚到 20:00 ET 就跨进次日 UTC,
  // 按 UTC 截会把日期挪后一天。日线那批(09:30 ET = 13:3xZ)两者永远同日,故仍用 toIsoDate。
  return { date: nyParts(new Date(millis)).date, value, at: millis };
}

/** Yahoo 优先、库兜底:同一天两边都有取 bars,升序输出。 */
export function mergeMove(bars: MovePoint[], fallback: MovePoint[]): MovePoint[] {
  // fallback 先入、bars 后入:同 key 后者覆盖 = Yahoo 优先。
  const byDate = new Map([...fallback, ...bars].map((p) => [p.date, p.value]));

  return [...byDate].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 对外主入口:一次 chart 调用 → 非空日线 + meta 补当天,合成一条序列。
 * meta 单独回传:抓取成败要看它有没有值(日线断供时它是当天唯一来源,
 * 而 points 里那几千行历史照样在,只看条数会把「今天没拿到」误判成成功)。
 */
export async function fetchMoveSeries(
  since: Date,
  client: MoveChartClient = defaultMoveClient(),
): Promise<{ points: MovePoint[]; meta: MetaPoint | null }> {
  const chart = await client(since);
  const bars = chart.quotes
    .filter((q) => Number.isFinite(q.close))
    .map((q) => ({ date: toIsoDate(q.date), value: q.close as number }));
  const meta = metaPoint(chart.meta);

  return { points: mergeMove(bars, meta ? [meta] : []), meta };
}
