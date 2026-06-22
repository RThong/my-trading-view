/**
 * Deribit BTC 日线收盘(BTC-PERPETUAL,via get_tradingview_chart_data)。
 * 用作 BTC VRP 的 RV 腿主源(权威加密价、与 DVOL 同交易所),Yahoo BTC-USD 作降级。
 * 免 key 公开 REST,返回平行数组 { ticks:[ms], close:[...], ... }。
 * 永续价≈现货指数(差一个 funding basis,对 RV 收益率可忽略)。
 * 按 ~180 天滚动窗口分页拉全(单次跨度过长会被截断)。
 */
const BASE = 'https://www.deribit.com/api/v2/public';
const WINDOW_DAYS = 180;

export async function fetchBtcDailyClose(
  startMs: number,
  endMs: number,
): Promise<Array<{ date: string; close: number }>> {
  const byDate = new Map<string, number>();
  for (let from = startMs; from < endMs; from += WINDOW_DAYS * 86400_000) {
    const to = Math.min(from + WINDOW_DAYS * 86400_000, endMs);
    const url = `${BASE}/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${from}&end_timestamp=${to}&resolution=1D`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Deribit BTC chart → HTTP ${res.status}`);
    const j = (await res.json()) as { result?: { ticks?: number[]; close?: number[] }; error?: unknown };
    if (j.error) throw new Error(`Deribit BTC chart → ${JSON.stringify(j.error)}`);
    const ticks = j.result?.ticks ?? [];
    const close = j.result?.close ?? [];
    for (let i = 0; i < ticks.length; i++) {
      if (typeof ticks[i] === 'number' && typeof close[i] === 'number') {
        byDate.set(new Date(ticks[i]).toISOString().slice(0, 10), close[i]);
      }
    }
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}
