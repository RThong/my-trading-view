import * as XLSX from 'xlsx';
import { fetchWithTimeout } from './http';

// JPX「信用取引現在高」:东京 + 名古屋二市场的信用买入余额合计(制度 + 一般,自己 + 委託),金额(百万円),周频(申込日基准,周五)。
// 日本版「融资余额」。三种官方文件拼起来,读时现拉、不落库:
//   ① 05.html「過去推移表」的 BIFF8 `.xls`(`{日期}_mtsk.xls`):2002-08-02 起全历史,但不常更新(2026-11-14 挂的版本只到 09-18)
//   ② 同页的 `.xlsx`:最近约 6 周
//   ③ 04.html 每周的 `{日期}_mtcurrent.xlsx`:最近约 5 周(更早的 404)
// 文件名带更新日、旧版会被删,所以先抓页面找当前链接,不拼 URL。三者重叠周 2026-11 实测逐周完全一致。
// ⚠️ 2013-07-12 申込分之前是东京 + 大阪 + 名古屋三市场,之后是东京 + 名古屋(大阪现货并入东京),覆盖范围实际连续。
// ⚠️ `.xls` 是 BIFF8,fflate 解不了 → 用 SheetJS(官方 CDN 版,见 AGENTS.md 依赖档位);`.xlsx` 也一并用它读,省得两套解析。
const BASE = 'https://www.jpx.co.jp';
const PAGE_HISTORY = `${BASE}/markets/statistics-equities/margin/05.html`;
const PAGE_WEEKLY = `${BASE}/markets/statistics-equities/margin/04.html`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export type MarginWeek = { date: string; value: number };
type Row = unknown[];

function sheetRows(buf: ArrayBuffer): Row[] {
  const wb = XLSX.read(buf);
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
}

function iso(serial: number): string {
  return new Date(EXCEL_EPOCH + serial * DAY_MS).toISOString().slice(0, 10);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, '') : '';
}

/** 表头那几格逐个核对(去空白后包含即可),对不上 = 版式变了,整条抛错。 */
function checkHeader(rows: Row[], expects: [row: number, col: number, label: string][], name: string) {
  const bad = expects.filter(([r, c, label]) => !text(rows[r]?.[c]).includes(label));
  if (bad.length)
    throw new Error(`JPX 信用残 ${name}:表头对不上(${bad.map(([r, c, l]) => `${r},${c}≠${l}`).join(' ')})`);
}

/** 推移表(.xls 全历史 / .xlsx 最近几周):首列是 Excel 日期序列号的行就是数据行,取 valueCol。 */
function parseHistory(rows: Row[], valueCol: number, name: string): MarginWeek[] {
  const weeks = rows.flatMap((r): MarginWeek[] => {
    if (typeof r[0] !== 'number') return [];
    const value = r[valueCol];
    if (typeof value !== 'number') throw new Error(`JPX 信用残 ${name}:${iso(r[0])} 买残金额不是数字`);
    return [{ date: iso(r[0]), value }];
  });
  if (!weeks.length) throw new Error(`JPX 信用残 ${name}:一行数据都没解析出来`);
  return weeks;
}

// .xls(`_mtsk`):委託 4 列 + 自己 4 列 + 合計(売株数, 売金額, 買株数, 買金額)→ 合計买残金额在第 12 列
export function parseMtskXls(buf: ArrayBuffer): MarginWeek[] {
  const rows = sheetRows(buf);
  checkHeader(
    rows,
    [
      [3, 9, '合計'],
      [4, 11, '買残高'],
      [6, 12, '金額'],
    ],
    '.xls',
  );
  return parseHistory(rows, 12, '.xls');
}

// 推移表 .xlsx:制度 8 列 + 一般 4 列 + 合計(売株数, 売金額, 買株数, 買金額)→ 合計买残金额在第 16 列(Q 列)
export function parseRecentXlsx(buf: ArrayBuffer): MarginWeek[] {
  const rows = sheetRows(buf);
  checkHeader(
    rows,
    [
      [3, 13, '合計'],
      [4, 15, '買残高'],
      [6, 16, '金額'],
    ],
    '推移表 .xlsx',
  );
  return parseHistory(rows, 16, '推移表 .xlsx');
}

// 每周 .xlsx:竖排版式。日期在第 1 行第 1 列;「信用取引残高合計」那行是株数、下一行是金額;第 6 列 = 二市场买残高
export function parseWeeklyXlsx(buf: ArrayBuffer): MarginWeek {
  const rows = sheetRows(buf);
  checkHeader(
    rows,
    [
      [5, 4, '二市場'],
      [6, 6, '買残高'],
    ],
    '每周 .xlsx',
  );
  const i = rows.findIndex((r) => text(r[1]).startsWith('信用取引残高合計'));
  const date = rows[1]?.[1];
  const value = rows[i + 1]?.[6];
  if (i < 0 || !text(rows[i + 1]?.[3]).startsWith('金額') || typeof date !== 'number' || typeof value !== 'number') {
    throw new Error('JPX 信用残 每周 .xlsx:找不到合計金额行(版式可能变了)');
  }
  return { date: iso(date), value };
}

// 相邻两份文件交接处允许的最大间隔:正常 7 天,黄金周那周不发时 14 天;超过 = 中间漏了周
const MAX_SEAM_DAYS = 15;

/**
 * sources 按时间先后给(全历史 → 最近几周 → 每周文件)。
 * 同一周出现多次:值必须一致(.xls 里 2010-01-29 整行重复过),不一致说明拼接口径出了问题,抛错。
 * 交接处:后一份的首周与前一份的末周相隔超过 MAX_SEAM_DAYS 就抛错 —— 全历史 .xls 不常更新、
 * 6 周推移表在往前滚,两者哪天接不上,中间的周会悄悄消失。
 */
export function mergeWeeks(sources: MarginWeek[][]): MarginWeek[] {
  const span = (ws: MarginWeek[]) => ws.map((w) => w.date).sort();
  const seams = sources.slice(1).map((ws, i) => [span(sources[i]).at(-1)!, span(ws)[0]] as const);
  const broken = seams.find(([end, start]) => (Date.parse(start) - Date.parse(end)) / DAY_MS > MAX_SEAM_DAYS);
  if (broken) throw new Error(`JPX 信用残:文件交接处断档 ${broken[0]} → ${broken[1]}`);

  const byDate = Map.groupBy(sources.flat(), (w) => w.date);
  const conflict = [...byDate].find(([, ws]) => new Set(ws.map((w) => w.value)).size > 1);
  if (conflict)
    throw new Error(`JPX 信用残:${conflict[0]} 各文件数值不一致(${conflict[1].map((w) => w.value).join(' / ')})`);

  return [...byDate.values()].map((ws) => ws[0]).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchJpxMarginBuy(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<MarginWeek[]> {
  const get = async (url: string) => {
    const res = await doFetch(url, { headers: { 'User-Agent': UA } }, 30_000);
    if (!res.ok) throw new Error(`JPX 信用残 ${res.status}: ${url}`);
    return res;
  };
  // 页面上所有 Excel 链接(相对路径)
  const links = async (page: string) =>
    [...(await (await get(page)).text()).matchAll(/href="([^"]+\.xlsx?)"/g)].map((m) => m[1]);
  const file = async (path: string) => (await get(`${BASE}${path}`)).arrayBuffer();

  const [historyLinks, weeklyLinks] = await Promise.all([links(PAGE_HISTORY), links(PAGE_WEEKLY)]);
  // 05 页:`_mtsk.xls` = 全历史;唯一的 .xlsx = 最近几周(`_mtgk.xls` 是制度 / 一般分开的另一张,不用)
  const xls = historyLinks.find((l) => l.endsWith('_mtsk.xls'));
  const recent = historyLinks.find((l) => l.endsWith('.xlsx'));
  const weekly = weeklyLinks.filter((l) => l.endsWith('_mtcurrent.xlsx'));
  if (!xls || !recent || !weekly.length) throw new Error('JPX 信用残:页面上找不到文件链接(改版了?)');

  const [all, last6, ...weeks] = await Promise.all([file(xls), file(recent), ...weekly.map(file)]);
  return mergeWeeks([parseMtskXls(all), parseRecentXlsx(last6), weeks.map(parseWeeklyXlsx)]);
}
