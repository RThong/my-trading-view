/**
 * CNN Fear & Greed Index 抓取。
 * 端点返回当前值 + 历史滚动窗口;这里只取历史序列 fear_and_greed_historical.data
 * ([{ x: 毫秒时间戳, y: 分值 }])。缺完整浏览器 header 会被反爬挡(实测 418),故带齐 UA/Referer/Origin。
 * ponytail: 现拉、不落库(见 regime spec);历史只有 CNN 给的滚动窗口,要长历史再上存储。
 */
import { fetchWithTimeout } from './http';

export type FngPoint = { date: string; value: number };

const FNG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.cnn.com/',
  Origin: 'https://www.cnn.com',
};

type FngBody = { fear_and_greed_historical?: { data?: Array<{ x: number; y: number }> } };

export function parseFearGreed(body: FngBody): FngPoint[] {
  return (body.fear_and_greed_historical?.data ?? []).map((d) => ({
    date: new Date(d.x).toISOString().slice(0, 10),
    value: d.y,
  }));
}

export async function fetchFearGreed(): Promise<FngPoint[]> {
  const res = await fetchWithTimeout(FNG_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`CNN Fear&Greed failed: ${res.status}`);
  return parseFearGreed(await res.json() as FngBody);
}
