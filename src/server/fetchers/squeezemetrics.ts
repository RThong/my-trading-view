import { fetchWithTimeout } from './http';

// Squeezemetrics 的 GEX(做市商 Gamma 敞口,只算 SPX 指数期权):标普 500 每变动 1 点,做市商对冲要买卖多少美元(白皮书口径;公开 CSV 的 gex 不是 GEX+)。
// 正 = 做市商跌买涨卖(压住波动),负 = 追涨杀跌(放大波动,「伽马挤压」发生在这一侧)。
// 免 key CSV(约 220KB,2011-05 起日频,列 date,price,dix,gex),读时现拉、不落库。同文件 DIX(暗池买入占比)不接。
// ⚠️ 是模型估算:假设客户买 put、卖 call;个股 / ETF 期权都不算。是放大器不是触发器(2026-03-27 −72 亿没崩)。
const URL = 'https://squeezemetrics.com/monitor/static/DIX.csv';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const HEADER = 'date,price,dix,gex';

export type Point = { date: string; value: number };

// 一行 = 日期,SPX 收盘,DIX,GEX;GEX 是美元(可为负,可带小数)
const ROW = /^(\d{4}-\d{2}-\d{2}),[^,]*,[^,]*,(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/** CSV → GEX 序列,单位**亿美元**(源是美元,÷1e8)。表头逐字核对;坏行 / 不存在的日期 / 日期不升序都抛错。 */
export function parseGex(csv: string): Point[] {
  const [head, ...lines] = csv.replace(/\r?\n$/, '').split(/\r?\n/);
  if (head !== HEADER) throw new Error(`Squeezemetrics:表头变了「${head}」`);

  const points = lines.map((line): Point => {
    const m = ROW.exec(line);
    const t = m ? Date.parse(`${m[1]}T00:00:00Z`) : Number.NaN;
    const value = m ? Number(m[2]) : Number.NaN;
    // 非有限数(如 1e9999 → Infinity)序列化后变 null,会绕过 unavailable,一并当坏行
    if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== m[1] || !Number.isFinite(value)) {
      throw new Error(`Squeezemetrics:坏行「${line}」`);
    }
    return { date: m[1], value: value / 1e8 };
  });
  if (!points.length) throw new Error('Squeezemetrics:一行数据都没有');
  // 源本来就是升序;不是 = 版式变了(别悄悄重排,重复日期会被吞掉)
  const unordered = points.slice(1).find((p, i) => p.date <= points[i].date);
  if (unordered) throw new Error(`Squeezemetrics:日期不是严格升序(${unordered.date})`);

  return points;
}

export async function fetchGex(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<Point[]> {
  const res = await doFetch(URL, { headers: { 'User-Agent': UA } }, 30_000);
  if (!res.ok) throw new Error(`Squeezemetrics ${res.status}`);

  return parseGex(await res.text());
}
