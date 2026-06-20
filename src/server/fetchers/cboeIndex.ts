/**
 * 通用的 CBOE 指数历史数据抓取器。
 *
 * CBOE 以扁平 CSV 的形式发布数百个指数的每日 EOD 历史数据,地址为:
 *   https://cdn.cboe.com/api/global/us_indices/daily_prices/{INDEX}_History.csv
 *
 * 实际遇到的 CSV 表头有两种形态:
 *   - 单值:  "DATE,{SYMBOL}"           例如 "DATE,SKEW"
 *   - OHLC:  "DATE,OPEN,HIGH,LOW,CLOSE" 例如 VIX、VIX9D、VIX3M
 *
 * 日期格式为 MM/DD/YYYY,这里统一转换成 ISO 的 YYYY-MM-DD。
 */

import type { QuoteRow } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const CSV_BASE = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/';
const UA = 'Mozilla/5.0 (compatible; my-trading-view/0.1)';

export type CboeIndexRow = {
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
};

export type CboeIndexClient = {
  fetchHistory(cboeSymbol: string): Promise<CboeIndexRow[]>;
};

export function defaultCboeIndexClient(opts?: { fetch?: FetchFn }): CboeIndexClient {
  const doFetch = opts?.fetch ?? (globalThis.fetch as FetchFn);
  return {
    async fetchHistory(cboeSymbol) {
      const url = `${CSV_BASE}${cboeSymbol}_History.csv`;
      const res = await doFetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        throw new Error(`CBOE index ${cboeSymbol} failed: ${res.status}`);
      }

      return parseCboeIndexCsv(await res.text());
    },
  };
}

/** 同时解析单值和 OHLC 两种格式的 CBOE 指数 CSV。 */
export function parseCboeIndexCsv(text: string): CboeIndexRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((s) => s.trim().toUpperCase());
  const isOhlc =
    header.includes('OPEN') &&
    header.includes('HIGH') &&
    header.includes('LOW') &&
    header.includes('CLOSE');

  // 跳过表头行,逐行解析;flatMap 返回 [] 即丢弃该行(等价于原来的 continue)。
  return lines.slice(1).flatMap((line): CboeIndexRow[] => {
    const cols = line.split(',');
    const tradeDate = toIsoDate(cols[0]?.trim());
    if (!tradeDate) return [];

    if (isOhlc) {
      const close = parseNullable(cols[4]);
      if (close === null) return [];
      return [{ tradeDate, open: parseNullable(cols[1]), high: parseNullable(cols[2]), low: parseNullable(cols[3]), close }];
    }

    const close = parseNullable(cols[1]);
    if (close === null) return [];
    return [{ tradeDate, open: null, high: null, low: null, close }];
  });
}

function toIsoDate(s: string | undefined): string | null {
  if (!s) return null;
  // MM/DD/YYYY → YYYY-MM-DD
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function parseNullable(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

type FetchToRowsOpts = {
  cboeSymbol: string;
  storedSymbol: string;
  /** 只返回严格晚于该日期的行。优先级高于默认的 HISTORY_START_DATE 下限。 */
  afterDate?: string;
  client?: CboeIndexClient;
};

/**
 * 抓取一个 CBOE 指数,返回可直接插入 quote_eod 的 QuoteRow[]。
 * 起始日期始终以 HISTORY_START_DATE 为下限。做增量更新时,传入
 * `afterDate: latestStoredDate` 即可只抓取更新的行。
 */
export async function fetchCboeIndexAsQuotes(opts: FetchToRowsOpts): Promise<QuoteRow[]> {
  const client = opts.client ?? defaultCboeIndexClient();
  const all = await client.fetchHistory(opts.cboeSymbol);
  const cutoff = opts.afterDate && opts.afterDate > HISTORY_START_DATE ? opts.afterDate : HISTORY_START_DATE;
  const isStrict = opts.afterDate !== undefined;
  const filtered = all.filter((r) => isStrict ? r.tradeDate > cutoff : r.tradeDate >= cutoff);

  return filtered.map((r) => ({
    symbol: opts.storedSymbol,
    tradeDate: r.tradeDate,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: null,
  }));
}
