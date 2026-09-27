// 日本银行「時系列統計データ検索サイト」公开 API(免 key、零依赖)。手册:
// https://www.stat-search.boj.or.jp/info/api_manual.pdf(第 7 页有 DB 名对照)。
//
// 响应形状(lang=en,ASCII):先是若干行 `STATUS / MESSAGEID / MESSAGE / DATE / PARAMETER / NEXTPOSITION` 元数据,
// 再一行表头 `SERIES_CODE,...,SURVEY_DATES,VALUES`,之后每行一个观测。**按「首格是请求的代码」认数据行**,
// 不按行号跳过 —— 元数据行数随参数个数变。名称列会带逗号(`"Call Rate, Uncollateralized ..."`),
// 所以只取首格与**末两格**(日期、值),不按列号取中间那几格。
//
// ⚠️ 代码写错时回的是 **JSON 形式的 400**(`{"STATUS":400,"MESSAGE":"Nonexistent series code：1"}`),不是 CSV。
// ⚠️ 缺值写字面量 `null`(日频序列的周末/假日、月频的未发布月),跳过不补 0。
// ⚠️ 日期 = **数据所属期间**:月频 `YYYYMM`(记为当月 1 日,与 FRED 月频同轴),日频 `YYYYMMDD`。
// 分页:`NEXTPOSITION` 非空才要翻页;实测日频 1998 起 10500 行一次返回、NEXTPOSITION 为空,故不实现翻页 ——
// 真撞上时抛错(静默截断比失败更糟)。
import { fetchWithTimeout } from './http';

const BASE = 'https://www.stat-search.boj.or.jp/api/v1/getDataCode';

export type Point = { date: string; value: number };

/** `202609` → `2026-09-01`;`20260918` → `2026-09-18`;别的形状 → null。 */
export function bojDateToIso(s: string): string | null {
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4)}-01`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return null;
}

/** CSV 正文 → 每个请求代码一条升序序列。任一代码一行都没解析出 → 抛错(响应结构变了,别静默成空格)。 */
export function parseBojCsv(text: string, codes: readonly string[]): Record<string, Point[]> {
  const lines = text.split(/\r?\n/);
  const next = lines.find((l) => l.startsWith('NEXTPOSITION,'));
  if (next?.split(',')[1]?.trim()) throw new Error('BOJ API 返回了分页(NEXTPOSITION 非空),未实现翻页');

  const out: Record<string, Point[]> = Object.fromEntries(codes.map((c) => [c, [] as Point[]]));
  lines.forEach((l) => {
    const cells = l.split(',');
    const rows = out[cells[0]];
    const date = bojDateToIso(cells.at(-2) ?? '');
    const value = Number(cells.at(-1));
    if (!rows || !date || cells.at(-1) === 'null' || !Number.isFinite(value)) return;

    rows.push({ date, value });
  });

  const empty = codes.filter((c) => !out[c].length);
  if (empty.length) throw new Error(`BOJ API 未解析出数据: ${empty.join(', ')}`);

  Object.values(out).forEach((rows) => {
    rows.sort((a, b) => a.date.localeCompare(b.date));
  });
  return out;
}

/**
 * 拉同一 DB 下的几条序列(一个请求可带多个 code,**跨 DB 要分开请求**)。
 * `startMonth` 形如 `YYYYMM`;日频 DB 也收月份形状,API 会展开成整月。
 */
export async function fetchBojSeries(
  db: string,
  codes: readonly string[],
  startMonth: string,
): Promise<Record<string, Point[]>> {
  const now = new Date();
  const endMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const url = `${BASE}?format=csv&lang=en&db=${db}&startDate=${startMonth}&endDate=${endMonth}&code=${codes.join(',')}`;
  const r = await fetchWithTimeout(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`BOJ API ${db} HTTP ${r.status}: ${text.slice(0, 200)}`);

  return parseBojCsv(text, codes);
}
