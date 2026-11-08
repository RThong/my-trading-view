/**
 * Cboe 认沽认购比(个股 / 指数 / 全部产品),取自 Cboe Daily Market Statistics:
 * `www.cboe.com/markets/us/options/market-statistics/daily?dt=YYYY-MM-DD`(免 key;旧地址 `/us/options/market_statistics/daily/` 302 到这里)。
 * 一页 ~420KB、服务端现渲染,首字节 0.5~3 秒:没有更轻的 JSON 接口(带 `RSC: 1` 头也照样回整页)。
 *
 * 取数方式:页面是 Next.js 服务端渲染,当天的统计以 JSON 嵌在 `self.__next_f.push(...)` 的载荷里
 * (引号被转义成 `\"`),不用跑 JS。按版块名取**成交量**(call / put)自己算比值 —— 页面上的
 * 比值只有 2 位小数,成交量是原始整数,算出来与页面一致(2026-11-05 个股 2430016 / 2719490 = 0.894 → 页面 0.89)。
 *
 * ⚠️ 口径:这是 **Cboe 自家交易所**的成交量(= 传统的 CPCE / CPCI 口径,YCharts 的 CBOEEPCR / CBOEIPCR),
 *    不是全美 OPRA 合计。
 * ⚠️ 没数据的日子(周末、假日、当天还没发布)载荷里是 `"optionsData":null`,照常 200;
 *    临时休市日(国葬日等)有数据但个股成交为 0,也当没数据。
 *    载荷里连 `optionsData` 这个键都没有 = 页面结构变了,抛错(别当成「今天没数」默默跳过)。
 * ⚠️ 历史起点:页面自报 `"minDate":"2019-10-07"`,更早的日子一律 null。
 */
import { fetchWithTimeout } from './http';

export type PcVolume = { call: number; put: number };
export type PutCallDay = { equity: PcVolume; index: PcVolume; total: PcVolume };

/** 页面自报的最早可查日 */
export const PUT_CALL_MIN_DATE = '2019-10-07';

// 直接用新地址:旧的 /us/options/market_statistics/daily/ 会 302 跳到这里,每次多一个来回
const URL_BASE = 'https://www.cboe.com/markets/us/options/market-statistics/daily';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

// 我们要的三类 → 载荷里的版块名(每个版块第一行是 VOLUME,第二行是 OPEN INTEREST)
const SECTIONS: Record<keyof PutCallDay, string> = {
  equity: 'EQUITY OPTIONS',
  index: 'INDEX OPTIONS',
  total: 'SUM OF ALL PRODUCTS',
};

function volumeOf(payload: string, section: string): PcVolume | null {
  const m = payload.match(new RegExp(`"${section}":\\[\\{"name":"VOLUME","call":(\\d+),"put":(\\d+)`));
  return m ? { call: Number(m[1]), put: Number(m[2]) } : null;
}

/** 页面 HTML → 当天三类成交量;那天没数据 → null;结构认不出 → 抛错 */
export function parsePutCallPage(html: string): PutCallDay | null {
  const payload = html.replaceAll('\\"', '"');
  if (!payload.includes('"optionsData":')) throw new Error('Cboe 日统计页里没有 optionsData(页面结构可能变了)');
  if (payload.includes('"optionsData":null')) return null;

  const entries = (Object.keys(SECTIONS) as (keyof PutCallDay)[]).map(
    (k) => [k, volumeOf(payload, SECTIONS[k])] as const,
  );
  // 美股休市、只有指数期权零星成交的日子(2025-01-09 卡特国葬日:指数 3.3 万张、个股 0):不算交易日,整天跳过
  const equity = entries.find(([k]) => k === 'equity')?.[1];
  if (equity && equity.call === 0 && equity.put === 0) return null;
  const missing = entries.filter(([, v]) => !v || v.call <= 0).map(([k]) => SECTIONS[k]);
  if (missing.length) throw new Error(`Cboe 日统计页缺版块或认购量为 0:${missing.join(', ')}(页面结构可能变了)`);

  return Object.fromEntries(entries) as PutCallDay;
}

export async function fetchPutCallDay(date: string): Promise<PutCallDay | null> {
  const res = await fetchWithTimeout(`${URL_BASE}?dt=${date}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Cboe 日统计 ${date} HTTP ${res.status}`);
  return parsePutCallPage(await res.text());
}
