import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';
import { splitCsvLine } from './dtccCds';

// 美元零息通胀掉期(ZCIS,CPI-U)的成交,来自 DTCC 按 CFTC 规则公开披露的利率掉期文件(同一份文件里还有 OIS 等,不用)。
// 只取 1Y / 2Y:BEI 从 5Y 起(TIPS 短端不流动),短端市场通胀定价只有掉期给得出。免 key,每天一个 zip
// (压缩约 1.4MB、解开约 13MB 全币种利率掉期)。历史:滚动约 2.0 年(2026-11 实测最早 2024-11-10),过期回 403。
function fileUrl(d: string) {
  return `https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_RATES_${d.replaceAll('-', '_')}.zip`;
}

export const ZCIS_TENORS = { '1Y': 1, '2Y': 2 } as const;
export type ZcisTenor = keyof typeof ZCIS_TENORS;
/** rate = 固定利率(%,年化通胀)。 */
export type ZcisTrade = { id: string; tenor: ZcisTenor; date: string; rate: number };
export type ZcisDay = { trades: ZcisTrade[]; cancelled: string[] };

const FISN = 'NA/Swap Infl Idx USD';
const DAY_MS = 86_400_000;
// 即期起息 = 起息日在成交日之后 0~6 天;期限 = 到期日离起息日整 N 年 ±5 天
const MAX_SPOT_LAG_DAYS = 6;
const TENOR_SLACK_DAYS = 5;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

function addYears(iso: string, n: number): string {
  return `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
}

/**
 * 一天的披露文件 → 1Y / 2Y 即期起息 ZCIS 的真实新成交 + 这份文件里所有撤销行指向的原 ID。
 * ⚠️ 成交里混着几个月前起息的「老化」合约(如 2026-01-01 起息、固定利率 3.5%),2026-11-12 的 1Y 不剔时
 * 中位数 2.658%、只收即期起息的 2.113% —— 必须按起息日筛,**下限也要卡**(起息日早于成交日的就是老合约)。
 * 打包成交(Package indicator)与非打包的中位数实测差 ≤ 4bp,不剔。
 */
export function parseDtccZcis(csv: string): ZcisDay {
  const [header, ...lines] = csv.split('\n').map((l) => l.replace(/\r$/, ''));
  const cols = splitCsvLine(header);
  const col = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`DTCC CFTC 利率 CSV 缺列「${name}」(表头可能改版)`);
    return i;
  };
  const c = {
    dissId: col('Dissemination Identifier'),
    origId: col('Original Dissemination Identifier'),
    action: col('Action type'),
    event: col('Event type'),
    exec: col('Execution Timestamp'),
    effective: col('Effective Date'),
    expiry: col('Expiration Date'),
    fixed1: col('Fixed rate-Leg 1'),
    fixed2: col('Fixed rate-Leg 2'),
    fisn: col('UPI FISN'),
    underlier: col('UPI Underlier Name'),
  };

  // 文件约 2.3 万行,先按子串粗筛再拆列(撤销行不限产品,要留着)
  const rows = lines.filter((l) => l.includes(FISN) || l.includes('EROR')).map(splitCsvLine);
  const cancelled = rows.filter((f) => f[c.action] === 'EROR').map((f) => f[c.origId]);

  const trades = rows.flatMap((f) => {
    if (f[c.action] !== 'NEWT' || f[c.event] !== 'TRAD' || f[c.fisn] !== FISN || f[c.underlier] !== 'USA-CPI-U')
      return [];
    const date = f[c.exec].slice(0, 10);
    const eff = f[c.effective];
    const lag = daysBetween(date, eff);
    if (!(lag >= 0 && lag <= MAX_SPOT_LAG_DAYS)) return [];

    const tenor = (Object.keys(ZCIS_TENORS) as ZcisTenor[]).find(
      (t) => Math.abs(daysBetween(addYears(eff, ZCIS_TENORS[t]), f[c.expiry])) <= TENOR_SLACK_DAYS,
    );
    // 固定利率可能填在哪条腿上(实测约 3% 的行在 Leg 2),小数
    const rate = Number(f[c.fixed1] || f[c.fixed2]) * 100;
    return tenor && Number.isFinite(rate) && f[c.fixed1] + f[c.fixed2] !== ''
      ? [{ id: f[c.dissId], tenor, date, rate }]
      : [];
  });

  return { trades, cancelled };
}

// 同单名 / CDX:文件里混着补报的旧单,只收披露前 7 天内成交的
const MAX_REPORT_LAG_DAYS = 7;

/** 某天的披露文件;源已不保留那天(403/404)回 null,其它失败抛错。 */
export async function fetchDtccZcisDay(date: string, doFetch = fetchWithTimeout): Promise<ZcisDay | null> {
  const res = await doFetch(fileUrl(date), undefined, 60_000);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`DTCC CFTC 利率 ${date} 下载失败:${res.status}`);

  const files = Object.values(unzipSync(new Uint8Array(await res.arrayBuffer())));
  if (files.length !== 1) throw new Error(`DTCC CFTC 利率 ${date}:zip 里应只有一个 CSV,实际 ${files.length} 个`);

  const earliest = new Date(Date.parse(date) - MAX_REPORT_LAG_DAYS * DAY_MS).toISOString().slice(0, 10);
  const day = parseDtccZcis(strFromU8(files[0]));

  return { ...day, trades: day.trades.filter((t) => t.date >= earliest) };
}
