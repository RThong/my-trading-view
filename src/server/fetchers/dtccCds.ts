import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';
import { AI_CDS } from '../../shared/rateCurveDefs';

// 单名 5Y CDS 的成交,来自 DTCC 按 SEC 规则(SBSR)公开披露的证券型掉期成交。免 key,每天一个 zip(CSV)。
// 两种用法:软银(ICE 不清算日本名字,只能走这里,每天落库)和 ICE 那几家美国公司(补 ICE 开始存数之前的历史)。
// 只有向美国 SDR 报告的成交(有美国人一方),不是全市场。
// 文件名日期 = 披露日;成交日取每行的 Execution Timestamp(晚报的成交会出现在后几天的文件里)。
// 历史:滚动约 2 年多(2026-11 实测 2024-09-02 起能下,中间偶有缺天),拿不到的天回 403。
function fileUrl(d: string) {
  return `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_CREDITS_${d.replaceAll('-', '_')}.zip`;
}

// 标识写法不统一:RED 码(前 6 位是发行人,后面可带 3 位债项后缀)、债券 ISIN(前 8 位 = US + 6 位 CUSIP 发行人)、
// 或只写名字(公司名字段常常是债券描述 NT / SR NT,另有一批只写通用标准参考债 XSSNRREFOBL0,只能靠名字认)。
// 前缀是 2026-11 从实际成交里归纳的(见 docs/data-sources-candidates.md §1.1);名字正则别写宽:
// INTEL 会撞上 Intelsat,SOFTBANK 会混进软银电信(SoftBank Corp.,另一家公司)。
// Apple 不在表里:成交太稀(80 天里 6 天),回填出来只是零星几个点。
const IDENTITY: Record<string, { ids: string[]; name: RegExp }> = {
  ORCLE: { ids: ['6EC42L', 'US68389X'], name: /\bORACLE\b/ },
  MSFT: { ids: ['US594918', '5EDDA9'], name: /\bMICROSOFT\b/ },
  ALPHINC: { ids: ['US02079K', '0C27GT'], name: /\bALPHABET\b/ },
  AMZN: { ids: ['0C5448', 'US023135'], name: /\bAMAZON\.?COM\b/ },
  NVIDIA: { ids: ['6D76CM', 'US67066G'], name: /\bNVIDIA\b/ },
  BROINC: { ids: ['1C248K', 'US11135F'], name: /\bBROADCOM\b/ },
  DELLN: { ids: ['26B72T', 'US247025'], name: /\bDELL INC\b/ },
  INTC: { ids: ['US458140', '49D954'], name: /\bINTEL CORP/ },
  METAPL: { ids: ['UZEAAG', 'US30303M'], name: /\bMETA PLATFORMS\b/ },
  COREWEI: { ids: ['239FAV', 'US21873S'], name: /\bCOREWEAVE\b/ },
  SPACEXP: { ids: ['8CA76V', 'US84615Q', 'USU8531H'], name: /\bSPACE EXPLORATION\b/ },
  SBG: { ids: ['JQCEFX', 'JP343610'], name: /\bSOFTBANK GROUP\b/ },
};

// 每名的计价币种 / 票息档跟着 AI_CDS 走(软银日元,CoreWeave 500bp,其余 100bp);Fixed rate-Leg 1 是小数。
const TERMS = new Map(
  AI_CDS.filter((c) => c.ticker in IDENTITY).map((c) => [
    c.ticker,
    { ccy: c.jpy ? 'JPY' : 'USD', coupon: String((c.coupon ?? 100) / 1e4) },
  ]),
);

export const DTCC_CDS_TICKERS = [...TERMS.keys()];

function identify(id: string, names: string): string | undefined {
  return Object.entries(IDENTITY).find(([, v]) => v.ids.some((p) => id.startsWith(p)) || v.name.test(names))?.[0];
}

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

// 同一组(时间 / 到期 / 本金 / 前端费)横跨这么多家不同发行人 = 指数拆出来的成分腿
const BASKET_MIN_ISSUERS = 3;
// 通用标准参考债:不带发行人信息,只能按名字区分
const GENERIC_IDS = new Set(['', 'XSSNRREFOBL0']);

// 发行人键:ISIN(12 位)取前 8 位(国家码 + 6 位 CUSIP 发行人),RED 码取前 6 位,通用 / 空标识取名字
function issuerKey(id: string, name: string): string {
  if (GENERIC_IDS.has(id)) return name;
  return id.length === 12 ? id.slice(0, 8) : id.slice(0, 6);
}

/** u = 前端费占名义本金的百分比(公开数据不带付款方向,只有绝对值;定价见 analytics/cdsTrades)。 */
export type DtccCdsTrade = { id: string; ticker: string; date: string; u: number };
export type DtccCdsDay = { trades: DtccCdsTrade[]; cancelled: string[] };

/**
 * 从一天的披露文件里挑出名单内各家 on-the-run 5Y 的**真实新成交**。
 * 另回 cancelled:这份文件里所有撤销行(EROR)指向的原成交 ID(不限名单)。撤销常出现在后几天的文件里,
 * 所以由调用方跨文件收齐后再剔(见 jobs/dtccCdsSnapshot)。
 */
export function parseDtccTrades(csv: string): DtccCdsDay {
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
    fisn: col('UPI FISN'),
    upiName: col('UPI Underlier Name'),
    assetName: col('Underlying Asset Name'),
  };

  const rows = lines.filter(Boolean).map(splitCsvLine);
  const cancelled = rows.filter((f) => f[c.action] === 'EROR').map((f) => f[c.origId]);

  // 指数成交拆成成分股报上来的「单名」:同一秒、同到期、同名义本金、同前端费,横跨一篮子公司
  // (实测 2025-11-18 15:54 一批约 125 家,各 200 万 / 前端费 41938)。带的是指数的价,不是这家公司的,整批剔掉。
  // 2026 年成交多、真实单能压过它们;2024~2025 年每家每天一两笔,混进一笔中位数就被拉走,图上像乱画。
  // 同一家公司的重复行是真实的多笔分配(同价拆给几个账户),按发行人去重计数,不受影响。
  const legKey = (f: string[]) => `${f[c.exec]}|${f[c.expiry]}|${f[c.notional]}|${f[c.payAmount]}`;
  const issuersByKey = Map.groupBy(
    rows.filter((f) => f[c.action] === 'NEWT'),
    legKey,
  );
  const basketKeys = new Set(
    [...issuersByKey]
      .filter(
        ([, fs]) =>
          new Set(fs.map((f) => issuerKey(f[c.id], (f[c.assetName] || f[c.upiName]).toUpperCase()))).size >=
          BASKET_MIN_ISSUERS,
      )
      .map(([k]) => k),
  );

  const trades = rows.flatMap((f) => {
    // 只要真实新成交:NEWT 里还混着更替(NOVA)/ 压缩(COMP),那两类的前端费是转让结算款,不是市场价;
    // MODI / CORR / TERM 是旧单的生命周期事件。只收公司优先级 / 无标注的单名(排除次级 / 篮子 / 主权)
    if (f[c.action] !== 'NEWT' || f[c.event] !== 'TRAD' || f[c.payType] !== 'UFRO') return [];
    if (basketKeys.has(legKey(f))) return [];
    if (f[c.fisn] !== 'NA/CDS Corp SN Sr' && f[c.fisn] !== 'NA/CDS Corp SN') return [];

    const ticker = identify(f[c.id], `${f[c.upiName]}|${f[c.assetName]}`.toUpperCase());
    const terms = ticker && TERMS.get(ticker);
    if (!ticker || !terms || f[c.ccy] !== terms.ccy || f[c.coupon] !== terms.coupon) return [];

    const date = f[c.exec].slice(0, 10);
    if (f[c.expiry] !== onTheRun5y(date)) return [];

    // 大单的名义本金会被截成上限并标 `+`(如 793,675,990+),实测前端费金额也按同一上限算,比值仍对
    const notional = Number(f[c.notional].replaceAll(',', '').replace(/\+$/, ''));
    const upfront = Number(f[c.payAmount].replaceAll(',', ''));
    // 0 = 漏填(实测 2026-11-05 一笔),当缺值丢掉
    if (!(notional > 0) || !(upfront > 0)) return [];

    return [{ id: f[c.dissId], ticker, date, u: (upfront / notional) * 100 }];
  });

  return { trades, cancelled };
}

// 披露日前超过这么多天成交的「新成交」不收:实测文件里混着几年前的补报(2020、2023 年的单出现在 2025 年的文件里),
// 价格对不上当时行情(2023-09 一笔折合 838bp),还会在图上画出一段并不存在的历史
const MAX_REPORT_LAG_DAYS = 7;

/** 某天的披露文件 → 名单内成交 + 撤销 ID;源已不保留那天(403/404)回 null,其它失败抛错。 */
export async function fetchDtccCdsDay(date: string, doFetch = fetchWithTimeout): Promise<DtccCdsDay | null> {
  const res = await doFetch(fileUrl(date), undefined, 60_000);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`DTCC ${date} 下载失败:${res.status}`);

  const files = Object.values(unzipSync(new Uint8Array(await res.arrayBuffer())));
  if (files.length !== 1) throw new Error(`DTCC ${date}:zip 里应只有一个 CSV,实际 ${files.length} 个`);

  const earliest = new Date(Date.parse(date) - MAX_REPORT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  const day = parseDtccTrades(strFromU8(files[0]));

  return { ...day, trades: day.trades.filter((t) => t.date >= earliest) };
}
