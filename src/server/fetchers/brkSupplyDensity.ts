/**
 * BTC 已实现供应密度(Realized Supply Density,Glassnode 同名指标的免费复刻)的原始日值:
 * 成本价落在当日收盘价 ±5% 内的 BTC ÷ 总供应量,百分点。Murphy(@Murphychen888)的「供应集中度」= 这条的 7 日均线。
 *
 * 源:BRK(Bitcoin Research Kit,开源 MIT,github.com/bitcoinresearchkit/mono)自建全节点算好的现成序列
 * `supply_density`,公开 API `bitview.space/api/series/{id}/day1`,免 key。一次请求即全段历史。
 * 口径(实读源码确认):`crates/bitview_urpd/src/density_band.rs` 的 [0.95, 1.05] × 收盘价,
 * URPD 价格档 4 位有效数字(`COST_BASIS_PRICE_DIGITS`),比我们以前自算用的 log2000 粗档更准。
 *
 * ⚠️ 2026-10-30 v0.13.0 删了 `/api/urpd/{cohort}/dates`、URPD 改列式 —— 以前自算 URPD 那版当天就断了。
 *    改读现成序列,对源的依赖只剩「序列名 + 一个数组」。BRK 还在 1.0 前,小版本约 1~2 个月一次破坏性改动,
 *    每版的 API 变动 / 序列改名列在 bitview.space/changes/。
 * ⚠️ `day1` 的数组下标是**日历日**(下标 0 = 2009-01-01,逐日连续),日期别自己推:同一 index 的 `date` 序列给出。
 *    2010-08-16 前没有交易所价格,值是 null。
 * ⚠️ 当天(UTC)那个点是盘中值,收盘前会变 → job 每轮全量覆盖写,次日自然变成收盘值。
 * ⚠️ 个人维护的免费服务、无 SLA。挂了可自建(要比特币全节点,区块文件 ~700GB + BRK ~290GB)。
 */
import { fetchWithTimeout, NonRetryableError } from './http';

const BASE = 'https://bitview.space/api/series';

type SeriesData = { index: string; type: string; start: number; data: unknown[] };

export type DensityPoint = { date: string; value: number };

const DAY_MS = 86400_000;

const isDay1 = (s: unknown): s is SeriesData => {
  const o = s as Partial<SeriesData> | null;
  return o?.index === 'day1' && o.start === 0 && Array.isArray(o.data);
};

// `Date.parse('2026-02-30')` 会滚到 3 月,只靠正则挡不住,要回转一遍比对
const isRealDay = (d: unknown): d is string => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d);

  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
};

// 下标即日历日:日期必须真实存在且逐日连续,否则按下标对齐会错位
const isContiguousDays = (data: unknown[]) =>
  data.every((d, i) => isRealDay(d) && (i === 0 || Date.parse(d) - Date.parse(data[i - 1] as string) === DAY_MS));

async function fetchDay1(id: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${BASE}/${id}/day1`, undefined, 60_000);
  // 序列被改名 / 删掉回 404,下次重试结果不变
  if (res.status === 404) throw new NonRetryableError(`BRK 序列 ${id} → 404(可能被改名,查 bitview.space/changes/)`);
  if (!res.ok) throw new Error(`BRK 序列 ${id} → HTTP ${res.status}`);

  return res.json().catch(() => {
    throw new NonRetryableError(`BRK 序列 ${id} 响应不是 JSON`);
  });
}

/**
 * 纯函数:把 density 与 date 两条 day1 序列按下标对齐成点列,跳过 null。格式漂移直接抛,别静默写进假数。
 * density 允许比 date 短(跨日那一刻 date 先长一格),反过来没日期可对 → 抛。
 */
export function zipDensity(density: unknown, dates: unknown): DensityPoint[] {
  const shapeOk =
    isDay1(density) && isDay1(dates) && density.data.length <= dates.data.length && isContiguousDays(dates.data);
  if (!shapeOk) throw new NonRetryableError('BRK supply_density / date 序列格式异常');

  // 单位改成比值(0~1)的话 type 会跟着变;光靠 [0,100] 区间挡不住
  if (density.type !== 'Percent') throw new NonRetryableError(`BRK supply_density 单位变了:${density.type}`);

  const points = density.data.flatMap((value, i) => (value == null ? [] : [{ date: dates.data[i] as string, value }]));
  const bad = points.find((p) => !(typeof p.value === 'number' && p.value >= 0 && p.value <= 100));
  if (bad) throw new NonRetryableError(`BRK supply_density ${bad.date} 越界或非数字:${bad.value}`);

  return points as DensityPoint[];
}

/** 全段原始日值(升序)。 */
export async function fetchSupplyDensitySeries(): Promise<DensityPoint[]> {
  const [density, dates] = await Promise.all([fetchDay1('supply_density'), fetchDay1('date')]);

  return zipDensity(density, dates);
}
