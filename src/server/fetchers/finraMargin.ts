import { fetchWithTimeout } from './http';
import { openXlsx } from './xlsx';

// FINRA 保证金统计(美股版「融资余额」):券商客户保证金账户的借方余额 = 借钱买证券的总额。
// 官方 xlsx(约 20KB,1997-01 起全历史,月频,单位百万美元),次月中旬更新(2026-11-14 已有 2026-10)。
// 2026-11 实测:页面 finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics 上的链接是这个 2021-03 路径,
// 但文件内容已到 2026-10 —— 原地覆盖更新,路径里的日期不代表数据时点。哪天 404 了先去页面上找新链接。
// 表里另有两列客户闲置现金(可算「净杠杆」= 借方 − 闲置现金),试过一格,随市值单边上行、拐点与同比同步,用户定删掉,只读借方。
// 列按表头名取(不按列号)。
const URL = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const SHEET = 'Customer Margin Balances';
const HEAD = { month: 'Year-Month', debit: "Debit Balances in Customers' Securities Margin Accounts" } as const;

/** 一个月的借方余额(百万美元);date = 当月 1 日(同项目月频约定)。 */
export type MarginMonth = { date: string; debit: number };

type Cell = { col: string; value: string };

// 单元格三种取值:共享字符串(t="s",<v> 是下标)、行内字符串(t="inlineStr",<is><t>…</t></is>)、其余取 <v>(数字 / 公式结果)。
// 行内字符串不认的话,借方哪天变成文本会被当成空格子悄悄跳过
function cellValue(attrs: string, inner: string, shared: string[]): string {
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  if (attrs.includes('t="s"')) return shared[Number(v)] ?? '';
  if (attrs.includes('t="inlineStr"')) return [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join('');
  return v ?? '';
}

function readRows(xml: string, shared: string[]): Cell[][] {
  return [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((r) =>
    [...r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)].map((c) => ({
      col: c[1],
      value: cellValue(c[2], c[3] ?? '', shared),
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
  const debitCol = colOf(HEAD.debit);
  if (!ymCol || !debitCol) throw new Error('FINRA 保证金:表头对不上(版式可能变了)');

  const cell = (row: Cell[], col: string) => (row.find((c) => c.col === col)?.value ?? '').trim();
  const months = body.flatMap((row): MarginMonth[] => {
    const raw = cell(row, debitCol);
    // 只跳过借方为空的行;有数却认不出年月(如被存成 Excel 日期序列号)= 源变了,整条抛错 ——
    // 别让最新一个月悄悄消失(2026-11 实测真实文件没有需要跳过的空行 / 注释行)
    if (!raw) return [];
    const ym = cell(row, ymCol);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`FINRA 保证金:认不出年月「${ym}」(版式可能变了)`);
    const debit = Number(raw);
    if (!Number.isFinite(debit)) throw new Error(`FINRA 保证金:${ym} 借方不是数字「${raw}」`);
    return [{ date: `${ym}-01`, debit }];
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
