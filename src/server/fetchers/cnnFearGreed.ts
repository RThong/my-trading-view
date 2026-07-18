/**
 * CNN Fear & Greed Index 抓取。
 * 端点返回当前值 + 历史滚动窗口;这里只取历史序列 fear_and_greed_historical.data
 * ([{ x: 毫秒时间戳, y: 分值 }])。缺完整浏览器 header 会被反爬挡(实测 418),故带齐 UA/Referer/Origin。
 * ponytail: 现拉、不落库(见 regime spec);历史只有 CNN 给的滚动窗口,要长历史再上存储。
 */
import { fetchWithTimeout } from './http';

export type FngPoint = { date: string; value: number };

const FNG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
// bare 端点只给 ~1 年;URL 末尾带起始日期能拿全历史(CNN 数据约从 2021 起)。
// 注意:起始日早于 CNN 数据起点会返回空体,故此日期不能更早。
const FNG_START = '2021-01-01';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.cnn.com/',
  Origin: 'https://www.cnn.com',
};

type FngBody = { fear_and_greed_historical?: { data?: Array<{ x: number; y: number }> } };

export function parseFearGreed(body: FngBody): FngPoint[] {
  // CNN 常把当天的点重复(日内多点塌缩到同一天)→ 按日期去重保留最后一个,保证升序无重复
  // (图表库要求严格升序)。输入已升序,Map 保留首次位置 + 最新值。
  const byDate = new Map<string, number>();
  for (const d of body.fear_and_greed_historical?.data ?? []) {
    byDate.set(new Date(d.x).toISOString().slice(0, 10), d.y);
  }
  return [...byDate].map(([date, value]) => ({ date, value }));
}

async function fetchOne(url: string): Promise<FngPoint[]> {
  const res = await fetchWithTimeout(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`CNN Fear&Greed failed: ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return []; // 起始日超出 CNN 数据范围时返回空体
  return parseFearGreed(JSON.parse(text) as FngBody);
}

export async function fetchFearGreed(): Promise<FngPoint[]> {
  // 带起始日拿全历史(~2021 起);万一 CNN 对该起始日返空,降级到 bare 端点(至少 ~1 年)。
  const full = await fetchOne(`${FNG_URL}/${FNG_START}`);
  return full.length ? full : fetchOne(FNG_URL);
}
