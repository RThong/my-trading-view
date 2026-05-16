/**
 * CBOE VIX futures (VX) historical EOD settlement fetcher.
 *
 * The CBOE futures historical-data page is a JS SPA, but the data behind it
 * is served via two stable, unauthenticated endpoints we discovered by
 * inspecting the page's network traffic:
 *
 *   1. List of all VX contracts:
 *      GET https://www-api.cboe.com/us/futures/market_statistics/historical_data/product/list/VX/
 *      Returns JSON keyed by year, each value an array of contract metadata
 *      (expire_date, product_display, path to its CSV).
 *
 *   2. Per-contract daily settlement CSV:
 *      GET https://cdn.cboe.com/{path-from-API}
 *      Columns: Trade Date, Futures, Open, High, Low, Close, Settle, Change,
 *      Total Volume, EFP, Open Interest. Each CSV covers one contract's whole
 *      life (~6–9 months from listing to expiry).
 *
 * This fetcher computes the "front-month" VIX future for each trading day:
 * for every trade date present across all contracts' CSVs, pick the contract
 * with the earliest expire_date that is still in the future on that date.
 */

import type { QuoteRow } from '../storage/repository';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const API_URL =
  'https://www-api.cboe.com/us/futures/market_statistics/historical_data/product/list/VX/';
const CDN_BASE = 'https://cdn.cboe.com/';
const UA = 'Mozilla/5.0 (compatible; my-trading-view/0.1)';

export type CboeContract = {
  symbol: string;       // 'VX+VXT/F6'
  expireDate: string;   // 'YYYY-MM-DD'
  csvUrl: string;
};

export type CboeSettleRow = {
  tradeDate: string;
  settle: number;
};

export type CboeVxClient = {
  fetchContractList(): Promise<CboeContract[]>;
  fetchContractCsv(contract: CboeContract): Promise<CboeSettleRow[]>;
};

export function defaultCboeVxClient(opts?: { fetch?: FetchFn }): CboeVxClient {
  const doFetch = opts?.fetch ?? (globalThis.fetch as FetchFn);
  return {
    async fetchContractList() {
      const res = await doFetch(API_URL, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        throw new Error(`CBOE contract list failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as Record<
        string,
        Array<{ product_display: string; expire_date: string; path: string }>
      >;
      const out: CboeContract[] = [];
      for (const year of Object.keys(data)) {
        for (const c of data[year]) {
          out.push({
            symbol: c.product_display,
            expireDate: c.expire_date,
            csvUrl: CDN_BASE + c.path,
          });
        }
      }
      return out;
    },
    async fetchContractCsv(contract) {
      const res = await doFetch(contract.csvUrl, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        throw new Error(`CBOE CSV ${contract.symbol} failed: ${res.status}`);
      }
      return parseSettleCsv(await res.text());
    },
  };
}

export function parseSettleCsv(text: string): CboeSettleRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out: CboeSettleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    // Trade Date, Futures, Open, High, Low, Close, Settle, Change, Total Volume, EFP, OI
    const tradeDate = cols[0]?.trim();
    const settle = Number(cols[6]?.trim());
    if (!tradeDate || !Number.isFinite(settle) || settle <= 0) continue;
    out.push({ tradeDate, settle });
  }
  return out;
}

/**
 * For each trade date, pick the contract whose expire_date is the *earliest*
 * date strictly after the trade date — that's the conventional "front month".
 * Returns rows sorted ascending by trade date.
 */
export function computeFrontMonth(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
): Array<{ tradeDate: string; settle: number; expireDate: string }> {
  const byDate = new Map<string, { settle: number; expireDate: string }>();
  for (const c of contractRows) {
    for (const r of c.rows) {
      if (c.expireDate <= r.tradeDate) continue; // skip post-expiry rows defensively
      const existing = byDate.get(r.tradeDate);
      if (!existing || c.expireDate < existing.expireDate) {
        byDate.set(r.tradeDate, { settle: r.settle, expireDate: c.expireDate });
      }
    }
  }
  return Array.from(byDate.entries())
    .map(([tradeDate, v]) => ({ tradeDate, settle: v.settle, expireDate: v.expireDate }))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

type FetchAllOpts = {
  client?: CboeVxClient;
  /** Only fetch contracts that have not yet expired by this date (YYYY-MM-DD). Defaults to today. Set to '1900-01-01' to fetch everything (full backfill). */
  freshSince?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

/**
 * High-level entry: download contracts, parse, return front-month series as
 * QuoteRow[]. Pass `freshSince: '1900-01-01'` for a full backfill; for daily
 * refresh pass a recent date so we only touch live + recently-expired
 * contracts (most history doesn't change).
 */
export async function fetchVxFrontMonthSeries(opts: FetchAllOpts = {}): Promise<QuoteRow[]> {
  const client = opts.client ?? defaultCboeVxClient();
  const freshSince = opts.freshSince ?? new Date().toISOString().slice(0, 10);
  const concurrency = opts.concurrency ?? 12;

  const allContracts = await client.fetchContractList();
  const contracts = allContracts.filter((c) => c.expireDate >= freshSince);

  const contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }> = [];
  let done = 0;
  for (let i = 0; i < contracts.length; i += concurrency) {
    const batch = contracts.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((c) => client.fetchContractCsv(c)),
    );
    results.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        contractRows.push({ expireDate: batch[idx].expireDate, rows: res.value });
      }
      done++;
      opts.onProgress?.(done, contracts.length);
    });
  }

  const fm = computeFrontMonth(contractRows);
  return fm.map((r) => ({
    symbol: 'VX1',
    tradeDate: r.tradeDate,
    open: null,
    high: null,
    low: null,
    close: r.settle,
    volume: null,
  }));
}
