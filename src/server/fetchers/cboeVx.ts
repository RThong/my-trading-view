/**
 * CBOE VIX 期货(VX)历史每日结算价(EOD settlement)抓取器。
 *
 * CBOE 的期货历史数据页面是一个 JS SPA,但页面背后的数据是通过两个稳定、
 * 无需鉴权的接口提供的——这两个接口是我们查看页面网络请求时发现的:
 *
 *   1. 所有 VX 合约列表:
 *      GET https://www-api.cboe.com/us/futures/market_statistics/historical_data/product/list/VX/
 *      返回按年份分组的 JSON,每个值是一组合约元数据
 *      (expire_date、product_display、CSV 文件的 path)。
 *
 *   2. 单个合约的每日结算价 CSV:
 *      GET https://cdn.cboe.com/{path-from-API}
 *      列依次为:Trade Date、Futures、Open、High、Low、Close、Settle、Change、
 *      Total Volume、EFP、Open Interest。每个 CSV 覆盖一份合约的完整生命周期
 *      (从挂牌到到期约 6–9 个月)。
 *
 * 本抓取器为每个交易日计算 front-month(近月)VIX 期货:对所有合约 CSV 中
 * 出现过的每个交易日,选取那份 expire_date 最早、且当天尚未到期的合约。
 */

import type { QuoteRow } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const API_URL =
  'https://www-api.cboe.com/us/futures/market_statistics/historical_data/product/list/VX/';
const CDN_BASE = 'https://cdn.cboe.com/';
const UA = 'Mozilla/5.0 (compatible; my-trading-view/0.1)';

export type CboeContract = {
  symbol: string;       // 形如 'VX+VXT/F6'
  expireDate: string;   // 形如 'YYYY-MM-DD'
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
    // 列依次为:Trade Date, Futures, Open, High, Low, Close, Settle, Change, Total Volume, EFP, OI
    const tradeDate = cols[0]?.trim();
    const settle = Number(cols[6]?.trim());
    if (!tradeDate || !Number.isFinite(settle) || settle <= 0) continue;
    out.push({ tradeDate, settle });
  }
  return out;
}

/**
 * 对每个交易日,选取 expire_date 严格晚于该交易日、且日期*最早*的合约——
 * 这就是约定俗成的 front month(近月合约)。
 * 返回按交易日升序排列的数据行。
 */
export function computeFrontMonth(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
): Array<{ tradeDate: string; settle: number; expireDate: string }> {
  const byDate = new Map<string, { settle: number; expireDate: string }>();
  for (const c of contractRows) {
    for (const r of c.rows) {
      if (c.expireDate <= r.tradeDate) continue; // 防御性地跳过到期之后的数据行
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
  /** 只抓取到该日期(YYYY-MM-DD)仍未到期的合约。默认为今天。设为 '1900-01-01' 可抓取全部合约(全量回填)。 */
  freshSince?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

/**
 * 上层入口:下载合约、解析,并以 QuoteRow[] 形式返回 front-month 序列。
 * 全量回填时传 `freshSince: '1900-01-01'`;日常刷新时传一个较近的日期,
 * 这样就只处理仍在交易的合约和近期刚到期的合约(绝大部分历史数据不会变)。
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
  return fm
    .filter((r) => r.tradeDate >= HISTORY_START_DATE)
    .map((r) => ({
      symbol: 'VX1',
      tradeDate: r.tradeDate,
      open: null,
      high: null,
      low: null,
      close: r.settle,
      volume: null,
    }));
}
