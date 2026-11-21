/**
 * WSJ Markets Diary(市场日志):NYSE / NASDAQ 当天的涨跌家数、新高新低家数、上涨 / 下跌成交量。
 * `www.wsj.com/market-data/stocks/marketsdiary?type=mdc_marketsdiary&id={"application":"WSJ","marketsDiaryType":"overview"}`
 * (免 key,JSON)。
 *
 * ⚠️ **只给当天**:id 里加 `date` / `timestamp` 都被忽略(2026-11-21 实测),补不了历史 → 每天抓一次落库。
 * ⚠️ 口径是该交易所本场挂牌的全部证券,不是标普 500。WSJ 脚注没写类别(只写来源 FactSet / Dow Jones Market Data);
 *    按 NYSE 上市目录(`www.nyse.com/api/quotes/filter`,按 instrumentType 查、按 url 里的 XNYS 数)2026-11-21 数得
 *    XNYS 合计 2,754 只、对上 WSJ 当天 2,784 只交易的证券:普通股 1,563、优先股 363、封闭式基金 306、ADR 183、
 *    ETF 142、REIT 121、权证 47、有限合伙 + 信托 29。ETF 大头在 NYSE Arca(WSJ 单列,不在 NYSE 里)。
 * ⚠️ 盘中也有值:载荷里的 `timestamp`(形如 `4:15 PM EST 11/20/26`)只取日期,是不是收盘后的那份由 job 按**现在**几点判
 *    (同 MOVE 的 isCloseSnapshot:看时间戳的小时数会把 13:00 收盘的半日市整天判成盘中)。
 * 数字是带千分位的字符串。
 */
import { fetchWithTimeout } from './http';

export type DiaryExchange = {
  adv: number;
  dec: number;
  unch: number;
  newHighs: number;
  newLows: number;
  advVol: number;
  decVol: number;
};
export type MarketsDiary = { date: string; nyse: DiaryExchange; nasdaq: DiaryExchange };

const ID = JSON.stringify({ application: 'WSJ', marketsDiaryType: 'overview' });
const URL = `https://www.wsj.com/market-data/stocks/marketsdiary?type=mdc_marketsdiary&id=${encodeURIComponent(ID)}`;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

type Instrument = { name: string } & Record<string, string>;
type InstrumentSet = { headerFields: { label: string }[]; instruments: Instrument[] };

// 每天都不可能是 0 的字段:涨 / 跌家数与涨 / 跌成交量。平盘、新高、新低是 0 很正常
const NONZERO = new Set<keyof DiaryExchange>(['adv', 'dec', 'advVol', 'decVol']);

// 我们要的字段 → [版块标题, 行名]
const FIELDS: Record<keyof DiaryExchange, [string, string]> = {
  adv: ['Issues', 'Advancing'],
  dec: ['Issues', 'Declining'],
  unch: ['Issues', 'Unchanged'],
  newHighs: ['Issues At', 'New Highs'],
  newLows: ['Issues At', 'New Lows'],
  advVol: ['Share Volume', 'Advancing'],
  decVol: ['Share Volume', 'Declining'],
};

/** `4:15 PM EST 11/20/26` → `2026-11-20`。认不出 = 抛错 */
export function parseDiaryDate(ts: string): string {
  const m = ts.match(/^\d{1,2}:\d{2} [AP]M E[SD]T (\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) throw new Error(`WSJ 市场日志 timestamp 认不出:${ts}`);

  const date = `20${m[3]}-${m[1]}-${m[2]}`;
  // 13/40/26 这种格式对、日子不存在的也拦下(Date 会把它滚到别的月份)
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) {
    throw new Error(`WSJ 市场日志 timestamp 日期不存在:${ts}`);
  }

  return date;
}

/** JSON → 当天两个交易所的读数;版块 / 行缺了、数不是正常整数 = 抛错(版式变了,别悄悄写 0) */
export function parseMarketsDiary(json: unknown): MarketsDiary {
  const data = (json as { data?: { timestamp?: string; instrumentSets?: InstrumentSet[] } }).data;
  if (!data?.timestamp || !data.instrumentSets) throw new Error('WSJ 市场日志缺 data.timestamp / instrumentSets');

  const sets = data.instrumentSets;
  const cell = (exchange: string, field: keyof DiaryExchange) => {
    const [section, row] = FIELDS[field];
    const set = sets.find((s) => s.headerFields[0]?.label === section);
    const raw = set?.instruments.find((i) => i.name === row)?.[exchange];
    // 只认「整数 + 规范千分位」:空串、1e3、1,,000 这类 Number() 能转出数的也拦下
    const n = raw && /^\d{1,3}(,\d{3})*$/.test(raw) ? Number(raw.replaceAll(',', '')) : Number.NaN;
    if (Number.isNaN(n) || (n === 0 && NONZERO.has(field))) {
      throw new Error(`WSJ 市场日志 ${section} / ${row} / ${exchange} 缺失或异常(得到 ${raw})`);
    }
    return n;
  };
  const exchangeOf = (exchange: string) =>
    Object.fromEntries(
      (Object.keys(FIELDS) as (keyof DiaryExchange)[]).map((k) => [k, cell(exchange, k)]),
    ) as DiaryExchange;

  return { date: parseDiaryDate(data.timestamp), nyse: exchangeOf('NYSE'), nasdaq: exchangeOf('NASDAQ') };
}

export async function fetchMarketsDiary(): Promise<MarketsDiary> {
  const res = await fetchWithTimeout(URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`WSJ 市场日志 HTTP ${res.status}`);
  return parseMarketsDiary(await res.json());
}
