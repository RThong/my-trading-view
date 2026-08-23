/**
 * Bitstamp BTC/USD 日 OHLC —— 只用来补 **Deribit 之前** 的历史。
 * Deribit BTC-PERPETUAL 2018-08 才上线,更早的价格它没有;Yahoo BTC-USD 也只到 2014-09。
 * Bitstamp 2011-08 开市至今连续,免 key 公开 REST,是免费源里回溯最长的那个。
 *
 * 单次 limit 上限 1000 根,故按 1000 天分页往前推。
 * **要么整段拉全、要么抛** —— 见下面的完整性校验,原因写在那里。
 */
import { fetchWithTimeout } from './http';
import type { Bar } from './moomooHistoryKL'; // 日线 OHLC 类型的单一真源

const URL_BASE = 'https://www.bitstamp.net/api/v2/ohlc/btcusd/';
const DAY = 86_400;
const PAGE = 1000;
// 判「这次没拉全」的洞宽阈值。分页里任一页瞬时回空会留一个 ~1000 天的洞,
// 而真实缺失(早年零成交日被滤掉)只缺 1 天 —— 7 天足够把两者分开。
const MAX_GAP_DAYS = 7;

const dayGap = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

type Ohlc = { timestamp: string; open: string; high: string; low: string; close: string };

/** [startDate, endDate] 闭区间,YYYY-MM-DD。 */
export async function fetchBitstampBtcDaily(startDate: string, endDate: string): Promise<Bar[]> {
  const endTs = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000);

  const byDate = new Map<string, Bar>();
  for (let from = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000); from <= endTs; from += PAGE * DAY) {
    const url = `${URL_BASE}?step=${DAY}&limit=${PAGE}&start=${from}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Bitstamp OHLC → HTTP ${res.status}`);

    // 空页不中断:区间是写死的历史段(Bitstamp 2011-08 就开市了),这里回空只可能是源抽风。
    // 提前 break 会静默截掉尾巴,而带洞的结果一旦落库、洞就永久留在那儿(见下面的校验)。
    const rows = ((await res.json()) as { data?: { ohlc?: Ohlc[] } }).data?.ohlc ?? [];

    for (const r of rows) {
      const ts = Number(r.timestamp);
      if (ts > endTs) continue;
      const close = Number(r.close);
      // 早年有零成交日,Bitstamp 会回 0 价 —— 落进去会让对数收益出 -Infinity,整段 RV/夏普作废。
      if (!(close > 0)) continue;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      byDate.set(date, { date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close });
    }
  }

  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 完整性校验:首尾各补一个哨兵,一次把「头缺 / 中间缺 / 尾巴被截」三种洞都查掉。
  // 带洞就整次不落库、下次重来 —— 调用方判「补完了」只看最早那天是否已到起点,
  // 带洞的结果落进去,守卫从此判 false,那个洞就再也没人补。
  const marks = [startDate, ...bars.map((b) => b.date), endDate];
  const holes = marks.slice(1).filter((d, i) => dayGap(marks[i], d) > MAX_GAP_DAYS);
  if (holes.length > 0) {
    throw new Error(
      `Bitstamp ${startDate}~${endDate} 没拉全:${holes.length} 处 >${MAX_GAP_DAYS} 天的洞(首个在 ${holes[0]} 前)`,
    );
  }

  return bars;
}
