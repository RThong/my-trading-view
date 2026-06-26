/**
 * Deribit DVOL(加密版 VIX)历史抓取器。免 key 公开 REST:
 *   get_volatility_index_data?currency=BTC&start_timestamp&end_timestamp&resolution
 * 返回 { data: [[ts, open, high, low, close], ...] }。取每日 close 作为 DVOL 值。
 *
 * DVOL 是百分点(40 = 40%),与 VIX 同口径,直接存。
 * 分窗口分页:单次请求时间跨度过长可能被服务端截断,这里按 ~180 天滚动窗口拉全。
 */
import { fetchWithTimeout } from './http';

const BASE = 'https://www.deribit.com/api/v2/public';
const WINDOW_DAYS = 180;

export async function fetchDvolHistory(
  currency: string,
  startMs: number,
  endMs: number,
): Promise<Array<{ date: string; value: number }>> {
  const byDate = new Map<string, number>(); // 同日多点取后写入的(=当日 close)
  for (let from = startMs; from < endMs; from += WINDOW_DAYS * 86400_000) {
    const to = Math.min(from + WINDOW_DAYS * 86400_000, endMs);
    const url = `${BASE}/get_volatility_index_data?currency=${currency}&start_timestamp=${from}&end_timestamp=${to}&resolution=1D`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Deribit DVOL → HTTP ${res.status}`);
    const j = (await res.json()) as { result?: { data?: number[][] }; error?: unknown };
    if (j.error) throw new Error(`Deribit DVOL → ${JSON.stringify(j.error)}`);
    for (const row of j.result?.data ?? []) {
      const [ts, , , , close] = row;
      if (typeof ts === 'number' && typeof close === 'number') {
        byDate.set(new Date(ts).toISOString().slice(0, 10), close);
      }
    }
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}
