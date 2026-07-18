// 席勒 CAPE(PE10 周期调整市盈率)。免费源:multpl.com 月度表(1871 起,含当前值)。
// 无干净 API,抓 HTML;值前带 &#x2002; 实体须跳过。远期/滚动 PE 无免费 feed,不做。
import { fetchWithTimeout } from './http';

const URL = 'https://www.multpl.com/shiller-pe/table/by-month';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/** multpl CAPE 月度表 HTML → [{date,value}] 升序。值前的 &#x...; 实体跳过再取数字。 */
export function parseCapeTable(html: string): { date: string; value: number }[] {
  const re = /<td>([A-Z][a-z]{2}) (\d{1,2}), (\d{4})<\/td>\s*<td>\s*(?:&#x[0-9a-fA-F]+;)?\s*(\d+\.\d+)/g;

  return [...html.matchAll(re)]
    .filter((m) => MONTHS[m[1]]) // 未知月名跳过
    .map((m) => ({ date: `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`, value: Number(m[4]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 抓 multpl by-month 页并解析。 */
export async function fetchShillerCape(): Promise<{ date: string; value: number }[]> {
  const resp = await fetchWithTimeout(URL, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`multpl CAPE ${resp.status}`); // 非2xx抛错→上层归 unavailable,别把错误页当空数据吞
  return parseCapeTable(await resp.text());
}
