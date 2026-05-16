/**
 * Generic CBOE index history fetcher.
 *
 * CBOE publishes daily EOD history for hundreds of indices as flat CSVs at:
 *   https://cdn.cboe.com/api/global/us_indices/daily_prices/{INDEX}_History.csv
 *
 * Two CSV header shapes are observed in the wild:
 *   - Single value: "DATE,{SYMBOL}"           e.g. "DATE,SKEW"
 *   - OHLC:         "DATE,OPEN,HIGH,LOW,CLOSE" e.g. VIX, VIX9D, VIX3M
 *
 * Dates are formatted as MM/DD/YYYY. We convert to ISO YYYY-MM-DD.
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

/** Parses both single-value and OHLC CBOE index CSVs. */
export function parseCboeIndexCsv(text: string): CboeIndexRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim().toUpperCase());
  const isOhlc =
    header.includes('OPEN') &&
    header.includes('HIGH') &&
    header.includes('LOW') &&
    header.includes('CLOSE');

  const out: CboeIndexRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const tradeDate = toIsoDate(cols[0]?.trim());
    if (!tradeDate) continue;
    if (isOhlc) {
      const open = parseNullable(cols[1]);
      const high = parseNullable(cols[2]);
      const low = parseNullable(cols[3]);
      const close = parseNullable(cols[4]);
      if (close === null) continue;
      out.push({ tradeDate, open, high, low, close });
    } else {
      const close = parseNullable(cols[1]);
      if (close === null) continue;
      out.push({ tradeDate, open: null, high: null, low: null, close });
    }
  }
  return out;
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
  /** Only rows STRICTLY after this date. Takes precedence over the default HISTORY_START_DATE floor. */
  afterDate?: string;
  client?: CboeIndexClient;
};

/**
 * Fetch a CBOE index and return QuoteRow[] ready to insert into quote_eod.
 * Always floored at HISTORY_START_DATE. For incremental updates, pass
 * `afterDate: latestStoredDate` to fetch only newer rows.
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
