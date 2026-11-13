import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';

// 软银集团(SoftBank Group Corp.)5Y 单名 CDS 的成交价,来自 DTCC 按 SEC 规则(SBSR)公开披露的证券型掉期成交。
// ICE Clear Credit 只清算 USD / EUR 计价的欧美名字,没有软银 → 只能走成交披露。免 key,每天一个 zip(CSV)。
// 软银的 CDS 几乎全是**日元计价**(100bp 票息 + 前端费);只有向美国 SDR 报告的成交(有美国人一方),不是全市场。
// 文件名日期 = 披露日;成交日取每行的 Execution Timestamp(晚报的成交会出现在后几天的文件里)。
// 历史:滚动约 2 年多(2026-11 实测 2024-09-10 能下、2024-06-11 回 403),拿不到的天回 403。
function fileUrl(d: string) {
  return `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_CREDITS_${d.replaceAll('-', '_')}.zip`;
}

export type SbgCdsTrade = { id: string; date: string; price: number };
export type SbgCdsDay = { trades: SbgCdsTrade[]; cancelled: string[] };

// 软银的标识写法不统一(实测四种):RED 码 JQCEFX(或带 3 位后缀的 JQCEFXAH4 等)、
// 债券 ISIN JP343610…(JP343610 = 软银集团的发行人前缀)、或只写名字。
// 不能只匹配 "SOFTBANK":会混进软银电信(SoftBank Corp.,另一家公司)。
const SBG_ID = /JQCEFX|JP343610|SOFTBANK GROUP/;

// 标准 CDS 每年 3/20、9/20 换新:3/20~9/19 的 on-the-run 5Y 到期在 5 年后的 6/20,9/20 起是 12/20。
// 只取这一个到期日,别按「4.5~5.5 年」框:相邻两档(如 2031-06 / 2031-12)价差约 0.5 个点,混着取中位数会跳。
export function onTheRun5y(date: string): string {
  const y = Number(date.slice(0, 4));
  const md = date.slice(5);
  if (md < '03-20') return `${y + 4}-12-20`;
  return md < '09-20' ? `${y + 5}-06-20` : `${y + 5}-12-20`;
}

// 引号可有可无:2025-11 起表头和数据全带引号,之前表头不带、数据带(名义本金 "500,000,000" 里有逗号)。
// 实测两版都没有转义引号("")。
// ponytail: 不处理转义引号;真出现了换成完整的 CSV 状态机。
function splitCsvLine(line: string): string[] {
  return [...line.matchAll(/(?:^|,)(?:"([^"]*)"|([^,"]*))/g)].map((m) => m[1] ?? m[2]);
}

/**
 * 从一天的披露文件里挑出软银 on-the-run 5Y 的**真实新成交**,每笔折成「价」(平价 100 = 100 − 前端费%),
 * 价与 ICE 结算价同一口径,读时用 cdsPriceToSpreadBp 换成 bp。
 * 另回 cancelled:这份文件里所有撤销行(EROR)指向的原成交 ID(不限软银)。撤销常出现在后几天的文件里,
 * 所以由调用方跨文件收齐后再剔(见 jobs/sbgCdsSnapshot)。
 */
export function parseSbgTrades(csv: string): SbgCdsDay {
  const [header, ...lines] = csv.split('\n').map((l) => l.replace(/\r$/, ''));
  const cols = splitCsvLine(header);
  const col = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`DTCC CSV 缺列「${name}」(表头可能改版)`);
    return i;
  };
  const c = {
    dissId: col('Dissemination Identifier'),
    origId: col('Original Dissemination Identifier'),
    action: col('Action type'),
    event: col('Event type'),
    exec: col('Execution Timestamp'),
    expiry: col('Expiration Date'),
    notional: col('Notional amount-Leg 1'),
    ccy: col('Notional currency-Leg 1'),
    coupon: col('Fixed rate-Leg 1'),
    payType: col('Other payment type'),
    payAmount: col('Other payment amount'),
    id: col('Underlier ID-Leg 1'),
    upiName: col('UPI Underlier Name'),
    assetName: col('Underlying Asset Name'),
  };

  const rows = lines.filter(Boolean).map(splitCsvLine);
  const cancelled = rows.filter((f) => f[c.action] === 'EROR').map((f) => f[c.origId]);

  const trades = rows.flatMap((f) => {
    // 只要真实新成交:NEWT 里还混着更替(NOVA)/ 压缩(COMP),那两类的前端费是转让结算款,不是市场价;
    // MODI / CORR / TERM 是旧单的生命周期事件。另须日元计价、标准 100bp 票息、带前端费
    if (f[c.action] !== 'NEWT' || f[c.event] !== 'TRAD') return [];
    if (f[c.ccy] !== 'JPY' || f[c.coupon] !== '0.01' || f[c.payType] !== 'UFRO') return [];
    if (!SBG_ID.test(`${f[c.id]}|${f[c.upiName]}|${f[c.assetName]}`.toUpperCase())) return [];

    const date = f[c.exec].slice(0, 10);
    if (f[c.expiry] !== onTheRun5y(date)) return [];

    // 大单的名义本金会被截成上限并标 `+`(如 793,675,990+),实测前端费金额也按同一上限算,比值仍对
    const notional = Number(f[c.notional].replaceAll(',', '').replace(/\+$/, ''));
    const upfront = Number(f[c.payAmount].replaceAll(',', ''));
    // 公开数据不带付款方向,前端费只给绝对值:票息 100bp 而软银利差远高于此,一律当买方付。
    // 0 = 漏填(实测 2026-11-05 一笔),当缺值丢掉
    if (!(notional > 0) || !(upfront > 0)) return [];

    return [{ id: f[c.dissId], date, price: 100 - (upfront / notional) * 100 }];
  });

  return { trades, cancelled };
}

// 披露日前超过这么多天成交的「新成交」不收:实测文件里混着几年前的补报(2020、2023 年的单出现在 2025 年的文件里),
// 价格对不上当时行情(2023-09 一笔折合 838bp),还会在图上画出一段并不存在的历史
const MAX_REPORT_LAG_DAYS = 7;

/** 某天的披露文件 → 软银成交 + 撤销 ID;源已不保留那天(403/404)回 null,其它失败抛错。 */
export async function fetchSbgCdsDay(date: string, doFetch = fetchWithTimeout): Promise<SbgCdsDay | null> {
  const res = await doFetch(fileUrl(date), undefined, 60_000);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`DTCC ${date} 下载失败:${res.status}`);

  const files = Object.values(unzipSync(new Uint8Array(await res.arrayBuffer())));
  if (files.length !== 1) throw new Error(`DTCC ${date}:zip 里应只有一个 CSV,实际 ${files.length} 个`);

  const earliest = new Date(Date.parse(date) - MAX_REPORT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  const day = parseSbgTrades(strFromU8(files[0]));

  return { ...day, trades: day.trades.filter((t) => t.date >= earliest) };
}
