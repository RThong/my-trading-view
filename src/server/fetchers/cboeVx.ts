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

      return Object.values(data).flat().map((c) => ({
        symbol: c.product_display,
        expireDate: c.expire_date,
        csvUrl: CDN_BASE + c.path,
      }));
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
  // 跳过表头行;flatMap 返回 [] 即丢弃该行(等价于原来的 continue)。
  // 列依次为:Trade Date, Futures, Open, High, Low, Close, Settle, Change, Total Volume, EFP, OI
  return lines.slice(1).flatMap((line): CboeSettleRow[] => {
    const cols = line.split(',');
    const tradeDate = cols[0]?.trim();
    const settle = Number(cols[6]?.trim());
    if (!tradeDate || !Number.isFinite(settle) || settle <= 0) return [];
    return [{ tradeDate, settle }];
  });
}

/**
 * 对每个交易日,在 expire_date 严格晚于该交易日的合约里,按到期日升序取**第 n 近**。
 * n=1 即约定俗成的 front month(近月)。合约数不足 n 的交易日被略过(不补零)。
 * 返回按交易日升序排列的数据行。
 */
export function computeNthMonth(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
  n: number,
): Array<{ tradeDate: string; settle: number; expireDate: string }> {
  // 按交易日分组所有未到期候选(同一交易日天然有近月/次月/三月多份合约)。
  const byDate = new Map<string, Array<{ settle: number; expireDate: string }>>();
  for (const c of contractRows) {
    for (const r of c.rows) {
      if (c.expireDate <= r.tradeDate) continue; // 跳过到期当天及之后
      const g = byDate.get(r.tradeDate) ?? [];
      g.push({ settle: r.settle, expireDate: c.expireDate });
      byDate.set(r.tradeDate, g);
    }
  }
  // 组内按到期日升序 → 取第 n 近(index n-1);不足则该日无结果。
  return Array.from(byDate.entries())
    .flatMap(([tradeDate, g]) => {
      const pick = g.sort((a, b) => a.expireDate.localeCompare(b.expireDate))[n - 1];
      return pick ? [{ tradeDate, settle: pick.settle, expireDate: pick.expireDate }] : [];
    })
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

type FetchAllOpts = {
  client?: CboeVxClient;
  /** 只抓取到该日期(YYYY-MM-DD)仍未到期的合约。默认为今天。设为 '1900-01-01' 可抓取全部合约(全量回填)。 */
  freshSince?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

/** 下载合约列表 + 各合约 CSV,返回 {expireDate, rows} 数组(供 computeNthMonth 消费)。 */
async function downloadContractRows(
  opts: FetchAllOpts,
  freshSince: string,
): Promise<Array<{ expireDate: string; rows: CboeSettleRow[] }>> {
  const client = opts.client ?? defaultCboeVxClient();
  const concurrency = opts.concurrency ?? 12;

  const allContracts = await client.fetchContractList();
  // 只保留标准月度 VX 合约(VX1/VX2/VX3 期限结构的口径);剔除周度合约
  // (symbol 形如 VX+VXT26/、VXT27/,VXT 后紧跟数字)。周度到期夹在月度之间、
  // 结算价常与近月相同,混进来会让"第 N 近"取到周度而非第 N 月 —— 实测使近年 VX1≡VX3、价差恒 0。
  // 标准月度 symbol 形如 VX+VXT/<月码><年>(VXT 后直接是 '/')。
  const isStandardMonthly = (symbol: string) => !/VXT\d/.test(symbol);
  const contracts = allContracts.filter((c) => isStandardMonthly(c.symbol) && c.expireDate >= freshSince);

  const contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }> = [];
  let done = 0;
  for (let i = 0; i < contracts.length; i += concurrency) {
    const batch = contracts.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((c) => client.fetchContractCsv(c)));
    results.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        contractRows.push({ expireDate: batch[idx].expireDate, rows: res.value });
      }
      done++;
      opts.onProgress?.(done, contracts.length);
    });
  }
  return contractRows;
}

/**
 * 把第 n 近合约序列映射成 QuoteRow[](symbol='VX{n}')。
 * 下界取 max(HISTORY_START_DATE, freshSince):增量时下载集只剩远月合约,
 * 对 freshSince 之前的交易日会把远月误算成近月 —— 故只产出 >= freshSince 的新行,
 * 旧日期保留全量回填时的正确值。全量回填(freshSince='1900-01-01')→ 退化为 HISTORY_START_DATE。
 */
function toQuoteRows(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
  n: number,
  freshSince: string,
): QuoteRow[] {
  const minDate = freshSince > HISTORY_START_DATE ? freshSince : HISTORY_START_DATE;
  return computeNthMonth(contractRows, n)
    .filter((r) => r.tradeDate >= minDate)
    .map((r) => ({
      symbol: `VX${n}`,
      tradeDate: r.tradeDate,
      open: null,
      high: null,
      low: null,
      close: r.settle,
      volume: null,
    }));
}

/**
 * 上层入口:一次下载,产出 VX1(近月)与 VX3(第三近)两条序列。
 * 全量回填传 `freshSince: '1900-01-01'`;日常刷新传较近日期(只处理仍在交易/近期到期的合约)。
 */
export async function fetchVxTermStructure(
  opts: FetchAllOpts = {},
): Promise<{ vx1: QuoteRow[]; vx3: QuoteRow[] }> {
  const freshSince = opts.freshSince ?? new Date().toISOString().slice(0, 10);
  const contractRows = await downloadContractRows(opts, freshSince);
  return { vx1: toQuoteRows(contractRows, 1, freshSince), vx3: toQuoteRows(contractRows, 3, freshSince) };
}

