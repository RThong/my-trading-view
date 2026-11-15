import { fetchWithTimeout } from './http';

// BTC 现货日成交额:Binance 现货 BTCUSDT 日 K 的 quote volume(USDT 计,≈ 美元),单位**亿美元**。
// 选 Binance 不选 Bitstamp(K 线同源):实测 Bitstamp 日成交额只有 Binance 的 1/10~1/20、份额多年变化大,长期走势会失真。
// 免 key 公开端点,日本 IP 可用(2026-11-15 实测);2017-08-17 起,UTC 0 点切日(与 Bitstamp K 线同),读时现拉、不落库。
// ⚠️ 2022-07-08 ~ 2023-03-22 Binance 对 BTC 现货部分交易对零手续费,刷量把那段成交额吹高过一截,不是真实活跃度。
const URL_BASE = 'https://api.binance.com/api/v3/klines';
const START = Date.UTC(2017, 7, 17);
const PAGE = 1000;
const DAY_MS = 86_400_000;

export type Point = { date: string; value: number };
// [开盘时间, 开, 高, 低, 收, 成交量(BTC), 收盘时间, 成交额(USDT), ...]
type Kline = [number, string, string, string, string, string, number, string, ...unknown[]];

const NUM = /^\d+(?:\.\d+)?$/;

/**
 * 日 K → 日成交额(亿美元)。只收开盘早于今天 UTC 0 点的(按开盘时间自己判,不信源给的收盘时间):
 * 当天还在累计,画出来像「突然缩量」。必须从 2017-08-17 起逐日连续、最后一根正好是昨天(UTC),
 * 否则整条抛 —— 缺段 / 截短都不悄悄画。
 */
export function dailyQuoteVolume(rows: Kline[], now: number): Point[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const closed = rows.filter((k) => k[0] < today);
  const bad = closed.find(
    (k) => !Number.isFinite(k[0]) || typeof k[7] !== 'string' || !NUM.test(k[7]) || !Number.isFinite(Number(k[7])),
  );
  if (bad) throw new Error(`Binance K 线:坏行「${JSON.stringify(bad).slice(0, 120)}」`);
  const gap = closed.find((k, i) => k[0] !== START + i * DAY_MS);
  if (!closed.length || gap) throw new Error(`Binance K 线:不连续(${gap ? new Date(gap[0]).toISOString() : '0 根'})`);
  if (closed[closed.length - 1][0] !== today - DAY_MS)
    throw new Error('Binance K 线:最后一根不是昨天(UTC),源截短或停更');

  return closed.map((k) => ({ date: new Date(k[0]).toISOString().slice(0, 10), value: Number(k[7]) / 1e8 }));
}

async function page(start: number, doFetch: typeof fetchWithTimeout): Promise<Kline[]> {
  const qs = new URLSearchParams({ symbol: 'BTCUSDT', interval: '1d', startTime: String(start), limit: String(PAGE) });
  const res = await doFetch(`${URL_BASE}?${qs}`, undefined, 30_000);
  // 451 = 地域封锁(美国 IP 等)
  if (!res.ok) throw new Error(`Binance K 线 ${res.status}`);

  return (await res.json()) as Kline[];
}

/** BTCUSDT 日成交额(亿美元),2017-08-17 起、到昨天(UTC),升序。每页 1000 天,并发拉。 */
export async function fetchBtcVolume(
  doFetch: typeof fetchWithTimeout = fetchWithTimeout,
  now: number = Date.now(),
): Promise<Point[]> {
  const starts = Array.from(
    { length: Math.ceil((now - START) / (PAGE * DAY_MS)) },
    (_, i) => START + i * PAGE * DAY_MS,
  );
  const rows = (await Promise.all(starts.map((s) => page(s, doFetch)))).flat();

  return dailyQuoteVolume(rows, now);
}
