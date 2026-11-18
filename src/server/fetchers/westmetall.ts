import { fetchWithTimeout } from './http';

// LME 基本金属官方价(Westmetall 转载):现货结算价 + 3 个月价 + LME 库存,美元/吨,日频(LME 交易日,T+1),2008 起。
// 免 key 纯服务端 HTML,每年一页:`markdaten.php?action=table&field=LME_Cu_cash&year=YYYY`(field 换成 Al / Ni / Zn / Pb / Sn
// 就是别的金属,版式相同)。读时现拉、不落库(能整段重拉)。
// 为什么不用别家(2026-11-18 实测):LME 官网有 Cloudflare 挑战、免费数据要登录;stooq 要人机验证;Nasdaq Data Link 的 LME 库付费;
// 东方财富 / 新浪是 3 个月**电子盘收盘**(和官方价取价时点不同,单日差可到 1.4%),只能整条替换、不能拼。
// ⚠️ 非官方授权转载、个人小站无 SLA:请求之间留间隔,别并发打。
const BASE = 'https://www.westmetall.com/en/markdaten.php';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// 两年页之间的间隔:小站,别连珠炮
const GAP_MS = 300;

export type Point = { date: string; value: number };
/** Westmetall 的字段名:LME_Cu_cash 铜 · LME_Al_cash 铝 · LME_Ni_cash 镍 · LME_Zn_cash 锌 · LME_Pb_cash 铅 · LME_Sn_cash 锡 */
export type LmeField = `LME_${'Cu' | 'Al' | 'Ni' | 'Zn' | 'Pb' | 'Sn'}_cash`;

function cells(row: string): string[] {
  return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].trim());
}

/** 带千分位的数(13,225.50);别的写法(含「-」)→ NaN */
function num(s: string): number {
  return /^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) ? Number(s.replaceAll(',', '')) : Number.NaN;
}

/**
 * 一年那页 → 3 个月价(升序)。表头逐格核对(第 3 格必须是「… 3-month」,换版式就抛错);
 * 表头在每个月开头重复一遍(整年页 12 次),和表头一模一样的行跳过;其余每行恰好 4 格、日期是那一年的真实日期、3 个月价是带千分位的数,否则整页抛错(防缺段冒充完整)。
 * 当年页在 1 月初可能还一行都没有 → 空数组;往年页没数据 = 版式变了,抛错
 */
export function parseLme3m(html: string, year: number, current: boolean): Point[] {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  if (tables.length !== 1) throw new Error(`Westmetall ${year}:页面里有 ${tables.length} 张表,版式变了`);
  const [head = '', ...rows] = tables[0].match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  const h = cells(head);
  if (h.length !== 4 || h[0] !== 'date' || !/^LME \w+ 3-month$/.test(h[2])) {
    throw new Error(`Westmetall ${year}:表头变了「${h.join(' | ')}」`);
  }

  const key = h.join('|');
  const body = rows.map(cells).filter((c) => c.join('|') !== key);
  const points = body.map((c): Point => {
    const m = c.length === 4 ? /^(\d{1,2})\. (\w+) (\d{4})$/.exec(c[0]) : null;
    const month = m ? MONTHS.indexOf(m[2]) + 1 : 0;
    const date = m && month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
    const t = Date.parse(`${date}T00:00:00Z`);
    const value = c.length === 4 ? num(c[2]) : Number.NaN;
    if (!m || Number(m[3]) !== year || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) {
      throw new Error(`Westmetall ${year}:坏行「${c.join(' | ')}」`);
    }
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Westmetall ${year}:${date} 3 个月价不是数「${c[2]}」`);
    return { date, value };
  });
  if (!points.length && !current) throw new Error(`Westmetall ${year}:一行数据都没有`);
  // 源是新到旧;不是严格降序 = 版式变了(重复日期别悄悄吞掉)
  const unordered = points.slice(1).find((p, i) => p.date >= points[i].date);
  if (unordered) throw new Error(`Westmetall ${year}:日期不是严格降序(${unordered.date})`);

  return points.reverse();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 往年的页不会再变:进程内缓存,之后每次只现拉当年那一页(1 个请求)。
// ponytail: 只在内存里,重启后头一次照旧逐年拉(约 9 次请求、5 秒);要更省再落盘
const PAST = new Map<string, Point[]>();
// 整次拉取的总时限:/api/regime 要等所有源到齐才返回,小站挂住时别把整个接口拖住
const TOTAL_MS = 20_000;
// 新年头半个月,当年那页可能还没生成(404 / 没有表):这段时间当年页拉不到 = 还没有数据,不算失败;过了这段仍按坏处理
const EARLY_JAN_DAYS = 15;

async function fetchYear(field: LmeField, year: number, now: Date, doFetch: typeof fetchWithTimeout): Promise<Point[]> {
  const current = year === now.getUTCFullYear();
  const earlyJan = current && now.getUTCMonth() === 0 && now.getUTCDate() <= EARLY_JAN_DAYS;
  const res = await doFetch(
    `${BASE}?action=table&field=${field}&year=${year}`,
    { headers: { 'User-Agent': UA } },
    15_000,
  );
  if (!res.ok) {
    if (earlyJan && res.status === 404) return [];
    throw new Error(`Westmetall ${field} ${year}: HTTP ${res.status}`);
  }
  const html = await res.text();
  if (earlyJan && !html.includes('<table')) return [];

  return parseLme3m(html, year, current);
}

/** 超时就抛(底下的请求照常跑完,往年页照样进缓存,下次就快了) */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}:超过 ${ms / 1000} 秒没拉完`)), ms);
  });

  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** from 年起到今年,逐年拉 3 个月价拼成一条(升序)。任一年失败整条抛(不拿缺段冒充完整);往年页走进程内缓存 */
export async function fetchLme3m(
  field: LmeField,
  fromYear: number,
  doFetch: typeof fetchWithTimeout = fetchWithTimeout,
  gapMs = GAP_MS,
  now = new Date(),
): Promise<Point[]> {
  const thisYear = now.getUTCFullYear();
  const years = Array.from({ length: thisYear - fromYear + 1 }, (_, i) => fromYear + i);
  // 哪些年的页已定稿、能进缓存:数据 T+1 才发,新年头半个月里去年那页可能还缺 12-30 / 31,别把缺尾的页冻进缓存
  const earlyJan = now.getUTCMonth() === 0 && now.getUTCDate() <= EARLY_JAN_DAYS;
  const settled = (year: number) => year < thisYear - 1 || (year === thisYear - 1 && !earlyJan);
  // 逐年串行 + 间隔(接力:上一年拿到了才发下一年;间隔只隔真发了的请求):个人小站,并发打可能被封
  const run = years.reduce<Promise<{ pages: Point[][]; sent: boolean }>>(
    async (acc, year) => {
      const { pages, sent } = await acc;
      const cached = PAST.get(`${field}:${year}`);
      if (cached) return { pages: [...pages, cached], sent };
      if (sent) await sleep(gapMs);
      const page = await fetchYear(field, year, now, doFetch);
      if (settled(year)) PAST.set(`${field}:${year}`, page);

      return { pages: [...pages, page], sent: true };
    },
    Promise.resolve({ pages: [], sent: false }),
  );

  return (await withDeadline(run, TOTAL_MS, `Westmetall ${field}`)).pages.flat();
}
