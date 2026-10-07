/**
 * BTC 已实现供应密度(Realized Supply Density,Glassnode 同名指标的免费复刻)的原始日值:
 * 成本价落在当日收盘价 ±5% 内的 BTC ÷ 总供应量,百分点。Murphy(@Murphychen888)的「供应集中度」= 这条的 7 日均线。
 *
 * 源:BRK(Bitcoin Research Kit,开源 MIT,github.com/bitcoinresearchkit/mono)自建全节点算的 URPD,
 * 公开 API `bitview.space/api/urpd/all/{date}`,免 key。每天一份、2009 年起全历史 → 可回填。
 * 响应自带 `close`(当日收盘价)与 `total_supply`(全部供应,各桶加总恰好等于它)。
 *
 * ⚠️ **价格档必须 `agg=log2000`**:粗档在 ±5% 边界上整档进出,2026-01-01 用 lin200 少算 1.1pp、
 *    log1000 少 0.5pp;log2000(~500KB/天)与 raw(~8MB/天)差 ≤0.14pp(2026-10 实测四个日期)。
 * ⚠️ 当天(UTC)的条目是**盘中快照**,收盘前会变 → job 按 fetched_at 认出盘中抓的行,下次重拉覆盖。
 * ⚠️ 个人维护的免费服务、无 SLA。挂了可自建(要比特币全节点)。
 * 2026-10 对账:7 日均线 2026-01-01 / 08-01 / 10-02 = 14.91 / 13.22 / 12.12,Murphy 图标 14.9 / 12.9 / 12。
 */
import { fetchWithTimeout, NonRetryableError } from './http';

const BASE = 'https://bitview.space/api/urpd/all';
const BAND = 0.05; // Murphy / Glassnode 的 ±5% 口径

// 只认真 number:`'123' > 0`、`'Infinity' > 0` 在 JS 里都成立,Infinity 当分母会算出假的 0%。
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

type Urpd = { date: string; close: number; total_supply: number; buckets: { price_floor: number; supply: number }[] };

/** 纯计算:当日收盘价 ±5% 内的桶求和 ÷ 总供应,百分点。 */
export function supplyDensityPct(u: Pick<Urpd, 'close' | 'total_supply' | 'buckets'>): number {
  const near = u.buckets.reduce((sum, b) => (Math.abs(b.price_floor / u.close - 1) <= BAND ? sum + b.supply : sum), 0);

  return (near / u.total_supply) * 100;
}

/** 有 URPD 的全部日期(升序)。 */
export async function fetchUrpdDates(): Promise<string[]> {
  const res = await fetchWithTimeout(`${BASE}/dates`);
  if (!res.ok) throw new Error(`BRK urpd dates → HTTP ${res.status}`);

  // 下游用末项判停更:元素格式或顺序一变就会算错,宁可整次失败。
  const dates = (await res.json()) as unknown;
  const ok = Array.isArray(dates) && dates.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!ok) throw new NonRetryableError('BRK urpd dates 格式异常');

  return [...dates].sort();
}

/** 某日的密度原始值。格式漂移直接抛,别静默写进一个假数。 */
export async function fetchSupplyDensity(date: string): Promise<number> {
  const res = await fetchWithTimeout(`${BASE}/${date}?agg=log2000`, undefined, 60_000);
  if (res.status === 404) throw new NonRetryableError(`BRK urpd ${date} → 404`);
  if (!res.ok) throw new Error(`BRK urpd ${date} → HTTP ${res.status}`);

  const u = (await res.json()) as Urpd;
  const sane =
    u.date === date &&
    isPositive(u.close) &&
    isPositive(u.total_supply) &&
    Array.isArray(u.buckets) &&
    u.buckets.length > 0 &&
    u.buckets.every(
      (b) =>
        typeof b.price_floor === 'number' &&
        Number.isFinite(b.price_floor) &&
        Number.isFinite(b.supply) &&
        b.supply >= 0,
    );
  if (!sane) throw new NonRetryableError(`BRK urpd ${date} 格式异常`);

  // 各桶加总恰好等于 total_supply(2026-10 实测);对不上多半是单位变了(如改成聪),
  // 那样算出 ~1e-7% 照样落在 [0,100] 里,只靠越界检查挡不住。
  const bucketSum = u.buckets.reduce((s, b) => s + b.supply, 0);
  if (Math.abs(bucketSum / u.total_supply - 1) > 0.01)
    throw new NonRetryableError(`BRK urpd ${date} 桶加总 ${bucketSum} 与 total_supply ${u.total_supply} 对不上`);

  const value = supplyDensityPct(u);
  if (!(value >= 0 && value <= 100)) throw new NonRetryableError(`BRK urpd ${date} 密度越界:${value}`);

  return value;
}
