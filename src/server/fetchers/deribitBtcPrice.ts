/**
 * Deribit BTC 日线收盘(BTC-PERPETUAL,via get_tradingview_chart_data)。
 * 用作 BTC VRP 的 RV 腿主源(权威加密价、与 DVOL 同交易所),Yahoo BTC-USD 作降级。
 * 免 key 公开 REST,返回平行数组 { ticks:[ms], close:[...], ... }。
 * 永续价≈现货指数(差一个 funding basis,对 RV 收益率可忽略)。
 * 按 ~180 天滚动窗口分页拉全(单次跨度过长会被截断)。
 */
import type { Bar } from './moomooHistoryKL'; // 日线 OHLC 类型的单一真源

const BASE = 'https://www.deribit.com/api/v2/public';
const WINDOW_DAYS = 180;

export async function fetchBtcDailyBars(startMs: number, endMs: number): Promise<Bar[]> {
  const byDate = new Map<string, Bar>();
  for (let from = startMs; from < endMs; from += WINDOW_DAYS * 86400_000) {
    const to = Math.min(from + WINDOW_DAYS * 86400_000, endMs);
    const url = `${BASE}/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${from}&end_timestamp=${to}&resolution=1D`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Deribit BTC chart → HTTP ${res.status}`);
    const j = (await res.json()) as { result?: { ticks?: number[]; open?: number[]; high?: number[]; low?: number[]; close?: number[] }; error?: unknown };
    if (j.error) throw new Error(`Deribit BTC chart → ${JSON.stringify(j.error)}`);
    const r = j.result ?? {};
    const ticks = r.ticks ?? [];
    const num = (arr: number[] | undefined, i: number) => (typeof arr?.[i] === 'number' ? arr[i] : null);
    for (let i = 0; i < ticks.length; i++) {
      if (typeof ticks[i] === 'number' && typeof r.close?.[i] === 'number') {
        const date = new Date(ticks[i]).toISOString().slice(0, 10);
        byDate.set(date, { date, open: num(r.open, i), high: num(r.high, i), low: num(r.low, i), close: r.close[i] });
      }
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
