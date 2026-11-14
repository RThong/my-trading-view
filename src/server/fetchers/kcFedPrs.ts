import { fetchWithTimeout } from './http';

// 堪萨斯城联储「政策利率偏度」KCPRS:一年期利率期权隐含的一年后短端利率分布的偏度(仿 CBOE SKEW 的构造)。
// 正 = 市场认为利率更可能落在预期之上(上行风险),负 = 下行风险,0 ≈ 两边均衡。2023 年起由欧洲美元期权改用 SOFR 期权。
// 同文件 KCPRU 是分布的宽度(不确定性),和 MOVE 水平相关约 0.90,不接。
// 免 key CSV(约 200KB,1989-04 起日频,列 Year,Month,Day,KCPRU,KCPRS),读时现拉、不落库。
// 说明页:kansascityfed.org/data-and-trends/kansas-city-fed-policy-rate-skew/
const URL = 'https://kcresearch-share.kansascityfed.org/kc-prs/KCPRU_KCPRS.csv';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const HEADER = 'Year,Month,Day,KCPRU,KCPRS';

export type Point = { date: string; value: number };

// 一行 = 年,月,日,KCPRU,KCPRS,五格都必须有且是十进制数
const ROW = /^(\d{4}),(\d{1,2}),(\d{1,2}),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

export function parseKcPrs(csv: string): Point[] {
  // 只去掉文件末尾的换行;表头逐字比较(不 trim,BOM / 多空格都算版式变了)
  const [head, ...lines] = csv.replace(/\r?\n$/, '').split(/\r?\n/);
  if (head !== HEADER) throw new Error(`KC Fed 政策利率偏度:表头变了「${head}」`);

  const points = lines.map((line) => {
    const m = ROW.exec(line);
    const date = m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    // 缺值 / 多列 / 非数字 / 不存在的日期(如 13 月 99 日)= 源变了,整条抛错(别画出缺一段或错位的线)
    const t = date ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
    if (!m || !date || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) {
      throw new Error(`KC Fed 政策利率偏度:坏行「${line}」`);
    }
    return { date, value: Number(m[5]) };
  });
  if (!points.length) throw new Error('KC Fed 政策利率偏度:一行数据都没有');

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchKcPrs(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<Point[]> {
  const res = await doFetch(URL, { headers: { 'User-Agent': UA } }, 30_000);
  if (!res.ok) throw new Error(`KC Fed 政策利率偏度 ${res.status}`);

  return parseKcPrs(await res.text());
}
