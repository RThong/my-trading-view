import { fetchWithTimeout } from './http';

export const defaultFetch = fetchWithTimeout;
import type { CompanyFacts, FactRow } from '../analytics/secFundamentals';

/**
 * 外国私人发行人(FPI)的季报走 6-K 这一路的**公共部分**。
 *
 * 为什么必须有这条路:FPI **豁免 10-Q**,只欠一份年度 20-F(4 个月内)+ 若干 6-K,
 * 而 6-K 的定义就是「把本国已公开的东西转交 SEC」—— 没有强制格式、**不强制 XBRL 标记**。
 * 实测:ASML 近十年 46 份季报 6-K 里带 XBRL 的是 0(只有 2017 年试过两份),TSM 是 0。
 * 所以 companyfacts 对这两家只有年频 —— 季度数据存在,但只以 HTML 形式存在。
 *
 * 各家的**文档命名与报表措辞都不同**,故解析器一家一个(见 tsmcReports / asmlReports);
 * 这里只放三件共用的事:找申报、挑正文、把抽出的数字装成 CompanyFacts。
 */

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

// 合并报表可达 4MB(TSM),默认 15s 在慢网下会临界超时。
export const REPORT_TIMEOUT_MS = 60_000;

export type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

function userAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT is required (格式:「应用名 邮箱」,见 .env.example)');

  return ua;
}

export async function get(url: string, doFetch: FetchFn, timeoutMs?: number): Promise<Response> {
  const res = await doFetch(url, { headers: { 'User-Agent': userAgent(), Accept: '*/*' } }, timeoutMs);
  if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${url}`);

  return res;
}

type Submissions = {
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      reportDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
    };
  };
};

/** 一份季报 6-K 的定位信息。periodEnd 直接取 submissions 的 reportDate —— 不用从正文猜期间。 */
export type FsFiling = { accn: string; filed: string; periodEnd: string };

/**
 * 按 primaryDocument 的命名模式挑出季报 6-K,按期末升序。
 *
 * ⚠️ **reportDate 等于 filingDate 的一律丢掉**。老申报里 SEC 的 reportDate 有时填的就是
 * 申报日本身,而不是所属期末 —— 那种「期末」是假的。实测 TSM 的 2023-07-20 / 2023-10-19 /
 * 2024-01-18 三份财报稿就是这样,它们带着相邻季度的值以假季末落库,把 TTM 的四季跨度判据
 * 打乱,静默吃掉了两个毛利率点。期间报告必然有一个早于申报日的期末,这条判据不会误伤。
 */
export async function listQuarterly6K(cik: string, docPattern: RegExp, doFetch: FetchFn): Promise<FsFiling[]> {
  const body = (await (
    await get(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, doFetch)
  ).json()) as Submissions;
  const {
    form = [],
    filingDate = [],
    reportDate = [],
    accessionNumber = [],
    primaryDocument = [],
  } = body.filings?.recent ?? {};

  return primaryDocument
    .flatMap((doc, i) =>
      form[i] === '6-K' &&
      docPattern.test(doc ?? '') &&
      reportDate[i] &&
      accessionNumber[i] &&
      filingDate[i] &&
      reportDate[i] !== filingDate[i] // 见上:reportDate 撞上 filingDate = 那不是一个期末
        ? [{ accn: accessionNumber[i]!, filed: filingDate[i]!, periodEnd: reportDate[i]! }]
        : [],
    )
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

type DirIndex = { directory?: { item?: Array<{ name?: string; size?: number | string }> } };

/**
 * 取一份申报里的报表正文。**不按名字认**,按「排除已知的非报表文件后取最大那份」——
 * 命名不稳定是实测出来的:TSM 出现过 `tsmc2023q1.htm` / `a0515.htm` / 拼错的 `consolidatd`;
 * ASML 从 `financialstatementsusgaapq.htm` 改成过 `financialstatementsusgaa.htm`。
 * 而报表正文和封面/新闻稿的体积差一个数量级以上,按大小挑稳得多。
 */
export async function fetchReportDoc(
  cik: string,
  accn: string,
  exclude: RegExp,
  doFetch: FetchFn,
): Promise<{ name: string; html: string }> {
  const dir = `${ARCHIVES}/${Number(cik)}/${accn.replace(/-/g, '')}`;
  const idx = (await (await get(`${dir}/index.json`, doFetch)).json()) as DirIndex;

  const doc = (idx.directory?.item ?? [])
    .filter((i) => /\.htm$/i.test(i.name ?? '') && !/index/i.test(i.name ?? '') && !exclude.test(i.name ?? ''))
    .sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
  if (!doc?.name) throw new Error(`6-K ${accn}: 目录里没有报表正文(排除规则可能把它滤掉了)`);

  return { name: doc.name, html: await (await get(`${dir}/${doc.name}`, doFetch, REPORT_TIMEOUT_MS)).text() };
}

// ── 解析原语 ──────────────────────────────────────────────────────────────────

/** HTML → 以 `|` 保留单元格边界的扁平文本。表格结构全靠这些竖线定位。 */
export const flattenHtml = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\|+/g, '|')
    .replace(/[ \t\r\n]+/g, ' ');

/**
 * 一个行标签和它的第一个数字之间最多隔几个单元格。表格里通常是 `标签|$|数字`(隔 1~2 格)。
 * **这个上限是必需的守卫**:没有它,标签匹配到散文时会一路扫到下一张表,把别人的数字当成
 * 自己的 —— 实测踩过:「Gross profit」先命中指引句「Gross profit margin is expected to be
 * between 65% and 67%」,然后扫到表格里 Net sales 的 1,270,381,算出 cogs = 0。
 */
const MAX_CELLS_TO_FIRST_NUMBER = 8;

/**
 * 从某个行标签起,顺序取前 n 个「数字单元格」的值。
 * 负号有**两种写法**,都得吃:`(350,762,799)` 与 `(628,052,531|)`(右括号被拆到下一格)。
 * 小数点也要吃:ASML 的报表是 `9,326.5` 这种一位小数。
 */
export function numsAfter(txt: string, label: string, n: number, from = 0): number[] {
  const i = txt.indexOf(label, from);
  if (i < 0) return [];

  const cells = txt.slice(i + label.length, i + label.length + 1500).split('|');
  const out: number[] = [];
  for (let k = 0; k < cells.length && out.length < n; k++) {
    const c = cells[k]!.trim();
    if (!/^\(?[\d,]+(\.\d+)?\)?$/.test(c) || !/\d/.test(c)) continue;
    // 第一个数字离标签太远 = 这不是那一行,是标签撞进了散文里。宁可空着让上层抛。
    if (out.length === 0 && k > MAX_CELLS_TO_FIRST_NUMBER) return [];

    const neg = c.startsWith('(') || cells[k + 1]?.trim() === ')';
    out.push((neg ? -1 : 1) * Number(c.replace(/[(),]/g, '')));
  }
  return out;
}

/**
 * `numsAfter` 的**另一种表格编码**版本:数字和标签在**同一个文本块**里,靠空格分隔而不是
 * 单元格分隔。实测 ASML 2025Q2 起的报表就是这样(整份文档 `<table>` 数为 0),而 2025Q1
 * 及更早是单元格式的 —— 同一家公司换过编码,所以两种都得吃。
 *
 * 规则:标签后连续吃数字,**遇到第一个带字母的词就停**(那是下一行的标签)。
 * 允许 `$` `€` `%` 这类符号夹在中间。标签后连着 3 个以上非数字词还没见到数字 → 判定
 * 「标签撞进散文」,返回空。
 *
 * ⚠️ 不能拿它去解析 TSM 那种:那边行标签后跟着 `(Notes 20, 31 and 37)`,
 * 拆词后 `20,` `31` `37)` 全是数字样,会被当成数值。那边必须用整格判定的 numsAfter。
 */
export function numsInRow(txt: string, label: string, n: number, from = 0): number[] {
  const i = txt.indexOf(label, from);
  if (i < 0) return [];

  const out: number[] = [];
  let skipped = 0;
  for (const raw of txt.slice(i + label.length, i + label.length + 800).split(/[\s|]+/)) {
    const t = raw.trim();
    if (!t || t === '$' || t === '€' || t === '%' || t === ')') continue;

    if (/^\(?-?[\d,]+(\.\d+)?\)?$/.test(t) && /\d/.test(t)) {
      out.push((t.startsWith('(') ? -1 : 1) * Number(t.replace(/[(),]/g, '')));
      if (out.length >= n) break;
      continue;
    }
    if (out.length > 0) break; // 数字串结束 = 这一行读完了
    if (++skipped > 3) return []; // 标签后一直没数字 → 不是那一行
  }
  return out;
}

// ── CompanyFacts 合成 ─────────────────────────────────────────────────────────

/** 一份报告里抽出的四科目(报表原文单位)。capex 存正值。 */
export type Sec6kValues = { revenue: number; cogs: number; ocf: number; capex: number };

/**
 * 借用 us-gaap 的 tag 名,让这些行能走 extractFundamentals 那条链。
 * **不代表这几家报的是 us-gaap**(TSM 是 IFRS;ASML 恰好真的是 US GAAP)。
 * 落库后 `tag_used` 显示这几个名字,真溯源看同行的 accn(指向那份 6-K)。
 */
export const AS_TAG = {
  revenue: 'Revenues',
  cogs: 'CostOfRevenue',
  ocf: 'NetCashProvidedByUsedInOperatingActivities',
  capex: 'PaymentsToAcquirePropertyPlantAndEquipment',
} as const;

/**
 * 期间语义。**决定 start 怎么填,进而决定下游差不差分**:
 *  · 'quarter' —— 报表直接给单季(ASML)。start = 本季初,走「直接单季行」那条,不差分。
 *  · 'ytd'     —— 报表只给年初至今累计(TSM)。start = 当年 1-1,由 toQuarters 相邻相减还原。
 * 填错方向的后果是静默的:把累计当单季 = 数值虚高数倍;把单季当累计 = 差分出负数。
 */
export type PeriodBasis = 'quarter' | 'ytd';

const DAY_MS = 86_400_000;
/** 单季起始日与上一期末的最大间隔。超过说明中间缺了季度,不能拿上一期末当起点。 */
const MAX_QUARTER_DAYS = 120;
const NOMINAL_QUARTER_DAYS = 91;

const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * 单季行的起始日 = **上一期期末的次日**。
 *
 * ⚠️ 不能按「季末月 − 2 的 1 号」硬算:**13 周财季的季末不落在月末**——
 * ASML 的季末是 2021-07-04 / 2025-09-28 / 2026-03-29 这种。硬算出的
 * 2021-05-01→2021-07-04 只有 64 天,会被 toQuarters 的季度长度判据丢掉。
 * 实测这个 bug 吃掉了 22 个季度里的 9 个,而且是静默的(线短了但不报错)。
 *
 * 上一期缺失(首期、或中间断档)时退回「期末 − 91 天」——只用来表达「这是一个季度」,
 * 不参与取值。
 */
function quarterStarts(ends: string[]): Map<string, string> {
  const sorted = [...ends].sort();

  return new Map(
    sorted.map((end, i) => {
      const prev = i > 0 ? sorted[i - 1]! : undefined;
      const usable = prev && (Date.parse(end) - Date.parse(prev)) / DAY_MS <= MAX_QUARTER_DAYS;
      return [end, usable ? shiftDays(prev!, 1) : shiftDays(end, -NOMINAL_QUARTER_DAYS)];
    }),
  );
}

export function toCompanyFacts(
  rows: Array<{ filing: FsFiling; values: Sec6kValues }>,
  basis: PeriodBasis,
  /** 报表单位 → 基础货币单位的乘数(千元 → 1e3,百万 → 1e6)。 */
  scale: number,
): CompanyFacts {
  const starts = basis === 'quarter' ? quarterStarts(rows.map((r) => r.filing.periodEnd)) : null;

  const entries = Object.entries(AS_TAG).map(([concept, tag]) => {
    const usd: FactRow[] = rows.map(({ filing, values }) => ({
      start: starts ? starts.get(filing.periodEnd)! : `${filing.periodEnd.slice(0, 4)}-01-01`,
      end: filing.periodEnd,
      val: values[concept as keyof Sec6kValues] * scale,
      accn: filing.accn,
      // 6-K 不是定期报告,而 periodsForTag 只收 10-Q/10-K —— 标成 10-Q 让它进得去。
      // 这是**刻意的伪装**:这几家的季报在功能上等同 10-Q,只是 FPI 用 6-K 交。
      form: '10-Q',
      filed: filing.filed,
    }));

    return [tag, { units: { USD: usd } }] as const;
  });

  return { facts: { 'us-gaap': Object.fromEntries(entries) } };
}
