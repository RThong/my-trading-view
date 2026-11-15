import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';
import { splitCsvLine } from './dtccCds';

// 美元/日元普通期权的成交,来自 DTCC 按 CFTC 规则公开披露的外汇文件(同一份里大头是 NDF 远期,不用)。
// 免 key,每天一个 zip(约 1~2MB)。历史:滚动约 2 年(2026-11 实测最早 2024-11-02,之后零星缺天回 403)。
// 文件**不带成交时刻的即期汇率**,隐含波动率要拿日线收盘去反推(见 analytics/fxImpliedVol)。
function fileUrl(d: string) {
  return `https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_FOREX_${d.replaceAll('-', '_')}.zip`;
}

// 普通(vanilla)美元/日元期权;Bar / Dig / Targ 是障碍、数字、目标累计期权,定价不同,不收
const FISNS = new Set(['NA/O Van Call JPY USD', 'NA/O Van Put JPY USD']);
const DAY_MS = 86_400_000;

/**
 * call = 美元看涨 / 日元看跌(即 USD/JPY 的看涨);strike = 日元 / 美元;usdNotional = 美元名义本金;
 * premium + premiumCcy = 期权费(USD 或 JPY 计)。
 */
export type FxOptionTrade = {
  id: string;
  date: string;
  expiry: string;
  call: boolean;
  strike: number;
  usdNotional: number;
  premium: number;
  premiumCcy: 'USD' | 'JPY';
};
export type FxOptionDay = { trades: FxOptionTrade[]; cancelled: string[] };

// 「22,220」带千分位;名义本金封顶披露写成「150000000+」(大单不报真值)→ 期权费与本金对不上,当缺值
function num(s: string): number | null {
  const t = s.replaceAll(',', '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 一天的披露文件 → 美元/日元普通期权的真实新成交 + 这份文件里所有撤销行指向的原 ID。
 * 只收 NEWT / TRAD(更替、行权、提前终止的期权费不是市场价);打包成交(价差、跨式的单腿)实测和非打包同水平,不剔。
 */
export function parseDtccFxOptions(csv: string): FxOptionDay {
  const [header, ...lines] = csv.split('\n').map((l) => l.replace(/\r$/, ''));
  const cols = splitCsvLine(header);
  const col = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`DTCC CFTC 外汇 CSV 缺列「${name}」(表头可能改版)`);
    return i;
  };
  const c = {
    dissId: col('Dissemination Identifier'),
    origId: col('Original Dissemination Identifier'),
    action: col('Action type'),
    event: col('Event type'),
    exec: col('Execution Timestamp'),
    expiry: col('Expiration Date'),
    callCcy: col('Call currency'),
    callAmt: col('Call amount'),
    putCcy: col('Put currency'),
    putAmt: col('Put amount'),
    premium: col('Option Premium Amount'),
    premiumCcy: col('Option Premium Currency'),
    strike: col('Strike Price'),
    pair: col('Strike price currency/currency pair'),
    fisn: col('UPI FISN'),
  };

  // 文件约 5 万行,先按子串粗筛再拆列(撤销行不限产品,要留着)
  const rows = lines.filter((l) => l.includes('NA/O Van') || l.includes('EROR')).map(splitCsvLine);
  const cancelled = rows.filter((f) => f[c.action] === 'EROR').map((f) => f[c.origId]);

  const trades = rows.flatMap((f): FxOptionTrade[] => {
    if (f[c.action] !== 'NEWT' || f[c.event] !== 'TRAD' || !FISNS.has(f[c.fisn]) || f[c.pair] !== 'USD/JPY') return [];
    const call = f[c.callCcy] === 'USD' && f[c.putCcy] === 'JPY';
    const put = f[c.callCcy] === 'JPY' && f[c.putCcy] === 'USD';
    const strike = num(f[c.strike]);
    const usdNotional = num(call ? f[c.callAmt] : f[c.putAmt]);
    const premium = num(f[c.premium]);
    const premiumCcy = f[c.premiumCcy];
    const date = f[c.exec].slice(0, 10);
    const expiry = f[c.expiry].slice(0, 10);
    const ok =
      (call || put) &&
      strike &&
      usdNotional &&
      premium &&
      (premiumCcy === 'USD' || premiumCcy === 'JPY') &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      /^\d{4}-\d{2}-\d{2}$/.test(expiry);

    return ok ? [{ id: f[c.dissId], date, expiry, call, strike, usdNotional, premium, premiumCcy }] : [];
  });

  return { trades, cancelled };
}

// 同单名 / CDX / ZCIS:文件里混着补报的旧单,只收披露前 7 天内成交的
const MAX_REPORT_LAG_DAYS = 7;

/** 某天的披露文件;源已不保留那天(403/404)回 null,其它失败抛错。 */
export async function fetchDtccFxOptionsDay(date: string, doFetch = fetchWithTimeout): Promise<FxOptionDay | null> {
  const res = await doFetch(fileUrl(date), undefined, 60_000);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`DTCC CFTC 外汇 ${date} 下载失败:${res.status}`);

  const files = Object.values(unzipSync(new Uint8Array(await res.arrayBuffer())));
  if (files.length !== 1) throw new Error(`DTCC CFTC 外汇 ${date}:zip 里应只有一个 CSV,实际 ${files.length} 个`);

  const earliest = new Date(Date.parse(date) - MAX_REPORT_LAG_DAYS * DAY_MS).toISOString().slice(0, 10);
  const day = parseDtccFxOptions(strFromU8(files[0]));

  return { ...day, trades: day.trades.filter((t) => t.date >= earliest) };
}
