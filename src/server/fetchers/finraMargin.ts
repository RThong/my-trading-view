import { fetchWithTimeout } from './http';
import { openXlsx } from './xlsx';

// FINRA 保证金统计(美股版「融资余额」):券商客户保证金账户的借方余额 = 借钱买证券的总额。
// 官方 xlsx(约 20KB,1997-01 起全历史,月频,单位百万美元),次月中旬更新(2026-11-14 已有 2026-10)。
// 2026-11 实测:页面 finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics 上的链接是这个 2021-03 路径,
// 但文件内容已到 2026-10 —— 原地覆盖更新,路径里的日期不代表数据时点。哪天 404 了先去页面上找新链接。
// 列按表头名取(不按列号):A 年月 · B 借方余额 · C 现金账户闲置现金 · D 保证金账户闲置现金(D 列 2010-02 才有)。
const URL = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const SHEET = 'Customer Margin Balances';
const HEAD = {
  month: 'Year-Month',
  debit: "Debit Balances in Customers' Securities Margin Accounts",
  cashCredit: "Free Credit Balances in Customers' Cash Accounts",
  marginCredit: "Free Credit Balances in Customers' Securities Margin Accounts",
} as const;

// 保证金账户闲置现金那列从这个月起才有;之后的月份缺它算源出错
const MARGIN_CREDIT_FROM = '2010-02';

/** 一个月(百万美元);date = 当月 1 日(同项目月频约定)。marginCredit 2010-02 前没有 → NaN。 */
export type MarginMonth = { date: string; debit: number; cashCredit: number; marginCredit: number };

type Cell = { col: string; value: string };

function readRows(xml: string, shared: string[]): Cell[][] {
  return [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((r) =>
    [...r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(?:<v>([^<]*)<\/v>)?/g)].map((c) => ({
      col: c[1],
      value: c[2].includes('t="s"') ? (shared[Number(c[3])] ?? '') : (c[3] ?? ''),
    })),
  );
}

export function parseFinraMargin(buf: ArrayBuffer): MarginMonth[] {
  const x = openXlsx(buf);
  const xml = x.sheet(SHEET);
  if (!xml) throw new Error(`FINRA 保证金:找不到工作表 ${SHEET}`);

  const [head, ...body] = readRows(xml, x.sharedStrings());
  const colOf = (name: string) => head?.find((c) => c.value.trim() === name)?.col;
  const ymCol = colOf(HEAD.month);
  const cols = { debit: colOf(HEAD.debit), cashCredit: colOf(HEAD.cashCredit), marginCredit: colOf(HEAD.marginCredit) };
  if (!ymCol || !cols.debit || !cols.cashCredit || !cols.marginCredit) {
    throw new Error('FINRA 保证金:表头对不上(版式可能变了)');
  }

  const num = (row: Cell[], col: string) => {
    const v = row.find((c) => c.col === col)?.value;
    return v ? Number(v) : Number.NaN;
  };
  const months = body.flatMap((row): MarginMonth[] => {
    const ym = (row.find((c) => c.col === ymCol)?.value ?? '').trim();
    // 只跳过三个数据列都空的行;有数据却认不出年月(如被存成 Excel 日期序列号)或缺数 = 源变了,整条抛错 ——
    // 别让最新一个月悄悄消失、也别让净杠杆算出 NaN(2026-11 实测真实文件没有需要跳过的空行 / 注释行)
    const hasData = [cols.debit, cols.cashCredit, cols.marginCredit].some((c) => Number.isFinite(num(row, c!)));
    if (!hasData) return [];
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`FINRA 保证金:认不出年月「${ym}」(版式可能变了)`);
    const m = {
      date: `${ym}-01`,
      debit: num(row, cols.debit!),
      cashCredit: num(row, cols.cashCredit!),
      marginCredit: num(row, cols.marginCredit!),
    };
    const required = [m.debit, m.cashCredit, ...(ym >= MARGIN_CREDIT_FROM ? [m.marginCredit] : [])];
    if (!required.every(Number.isFinite)) throw new Error(`FINRA 保证金:${ym} 缺值`);
    return [m];
  });
  if (!months.length) throw new Error('FINRA 保证金:一行数据都没解析出来');

  // 源是倒序(最新在上)
  return months.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchFinraMargin(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<MarginMonth[]> {
  const res = await doFetch(URL, { headers: { 'User-Agent': UA } }, 30_000);
  if (!res.ok) throw new Error(`FINRA 保证金 ${res.status}`);

  return parseFinraMargin(await res.arrayBuffer());
}
