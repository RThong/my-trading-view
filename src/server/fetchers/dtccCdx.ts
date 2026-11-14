import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';
import { onTheRun5y, splitCsvLine } from './dtccCds';
import { cdsSpreadToPrice } from '../analytics/rateCurves';

// CDX 北美指数的成交,来自 DTCC 按 CFTC 规则公开披露的信用掉期(指数归 CFTC 管,单名归 SEC → 见 dtccCds)。
// 免 key,每天一个 zip(CSV,约 100KB)。只用来补 ICE 开始存结算价之前的历史(ICE 只给当天快照)。
// 历史:滚动约 2.2 年(2026-11 实测 2024-09-03 能下、2024-08-01 回 403)。
function fileUrl(d: string) {
  return `https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_CREDITS_${d.replaceAll('-', '_')}.zip`;
}

// 指数 → UPI 里的名字 + 票息(Fixed rate-Leg 1 是小数)
const INDEX = { IG: { name: 'CDX.NA.IG', coupon: '0.01' }, HY: { name: 'CDX.NA.HY', coupon: '0.05' } } as const;
export type CdxKey = keyof typeof INDEX;

/** 价 = 平价 100 口径(与 ICE 结算价同),IG / HY 各自从不同写法换算而来,见 tradePrice。 */
export type DtccCdxTrade = { id: string; index: CdxKey; date: string; price: number };
export type DtccCdxDay = { trades: DtccCdxTrade[]; cancelled: string[] };

// 报价写法(Spread notation-Leg 1)按指数惯例不同,2026-11 实测:
// IG 按利差报,notation 3 = 小数利差(0.00585 = 58.5bp)→ 用同一定价模型换成价;
// HY 按价报,notation 1 = 价(106.095),notation 3 = 价 ÷ 10000(0.0106 = 106.2,不是利差 —— HY 利差 ~350bp,
// 小数应是 0.035)。别的组合不认,丢掉。
function tradePrice(index: CdxKey, notation: string, raw: number): number | null {
  if (index === 'IG') return notation === '3' ? cdsSpreadToPrice(raw * 1e4, 100) : null;
  if (notation === '1') return raw;
  return notation === '3' ? raw * 1e4 : null;
}

// IG 与单名同一套 3/20、9/20 换新;**HY 晚一周换(3/27、9/27)** —— 那一周 HY 主力还是旧系列。
// 2026-11 回填实测:按 IG 的日子认时,HY 每次换新后头一周(共 24 天)整周零成交被滤光。
export function onTheRunExpiry(index: CdxKey, date: string): string {
  return onTheRun5y(index === 'HY' ? new Date(Date.parse(date) - 7 * 86_400_000).toISOString().slice(0, 10) : date);
}

/** 一天的披露文件 → CDX IG / HY 当前主力 5Y 的真实新成交 + 这份文件里所有撤销行指向的原 ID。 */
export function parseDtccCdxTrades(csv: string): DtccCdxDay {
  const [header, ...lines] = csv.split('\n').map((l) => l.replace(/\r$/, ''));
  const cols = splitCsvLine(header);
  const col = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`DTCC CFTC CSV 缺列「${name}」(表头可能改版)`);
    return i;
  };
  const c = {
    dissId: col('Dissemination Identifier'),
    origId: col('Original Dissemination Identifier'),
    action: col('Action type'),
    event: col('Event type'),
    exec: col('Execution Timestamp'),
    expiry: col('Expiration Date'),
    coupon: col('Fixed rate-Leg 1'),
    spread: col('Spread-Leg 1'),
    notation: col('Spread notation-Leg 1'),
    fisn: col('UPI FISN'),
    upiName: col('UPI Underlier Name'),
  };

  const rows = lines.filter(Boolean).map(splitCsvLine);
  const cancelled = rows.filter((f) => f[c.action] === 'EROR').map((f) => f[c.origId]);
  const byName = new Map<string, CdxKey>(Object.entries(INDEX).map(([k, v]) => [v.name, k as CdxKey]));

  const trades = rows.flatMap((f) => {
    // 只要真实新成交;FISN `NA/CDS Corp Idx` = 指数本身(带 Tra 的是分层,Swt 是指数期权)
    if (f[c.action] !== 'NEWT' || f[c.event] !== 'TRAD' || f[c.fisn] !== 'NA/CDS Corp Idx') return [];
    const index = byName.get(f[c.upiName]);
    if (!index || f[c.coupon] !== INDEX[index].coupon) return [];

    // 成交里不带系列号:按到期日认当前主力 5Y
    const date = f[c.exec].slice(0, 10);
    if (f[c.expiry] !== onTheRunExpiry(index, date)) return [];

    const raw = Number(f[c.spread]);
    const price = Number.isFinite(raw) && raw > 0 ? tradePrice(index, f[c.notation], raw) : null;
    return price !== null && Number.isFinite(price) ? [{ id: f[c.dissId], index, date, price }] : [];
  });

  return { trades, cancelled };
}

// 同单名:文件里混着几年前的补报,只收披露前 7 天内成交的
const MAX_REPORT_LAG_DAYS = 7;

/** 某天的披露文件;源已不保留那天(403/404)回 null,其它失败抛错。 */
export async function fetchDtccCdxDay(date: string, doFetch = fetchWithTimeout): Promise<DtccCdxDay | null> {
  const res = await doFetch(fileUrl(date), undefined, 60_000);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`DTCC CFTC ${date} 下载失败:${res.status}`);

  const files = Object.values(unzipSync(new Uint8Array(await res.arrayBuffer())));
  if (files.length !== 1) throw new Error(`DTCC CFTC ${date}:zip 里应只有一个 CSV,实际 ${files.length} 个`);

  const earliest = new Date(Date.parse(date) - MAX_REPORT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  const day = parseDtccCdxTrades(strFromU8(files[0]));

  return { ...day, trades: day.trades.filter((t) => t.date >= earliest) };
}
