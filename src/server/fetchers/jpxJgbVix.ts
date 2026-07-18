// S&P/JPX JGB VIX(日债隐含波动率)。唯一免费全历史源是 JPX 官方 xlsx(=zip+XML)。
// A 列=日期(共享字符串 YYYY.MM.DD),B 列=值。2008 起,每日更新。
import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';

// ponytail: JPX 哈希 URL,改版会变;挂了归 unavailable、手工去 JPX 页面重取链接。
const XLSX_URL =
  'https://www.jpx.co.jp/english/markets/derivatives-indices/sp-jpx-jgb-vix/b5b4pj000002y7jd-att/SP_JPX_JGB_VIX_Historical_Data.xlsx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** '2008.01.15' → '2008-01-15';非 YYYY.MM.DD(如表头 'Date')→ null。 */
export function dotDateToIso(s: string): string | null {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** sheet1.xml + sharedStrings.xml → [{date,value}]。A 列共享串索引=日期,B 列内联值;表头/空行/since 前自然过滤。 */
export function parseJgbVixXlsx(
  sheetXml: string,
  sharedStringsXml: string,
  since: string,
): { date: string; value: number }[] {
  // 按 <si> 分块取首个 <t>:一 <si> 一条目,索引才与 A 列对齐。全局扫 <t> 遇富文本(多 run)会错位成看似合理的错日期(静默污染)。
  const ss = [...sharedStringsXml.matchAll(/<si>(.*?)<\/si>/gs)].map(
    (m) => /<t[^>]*>([^<]*)<\/t>/.exec(m[1])?.[1] ?? '',
  );
  const out: { date: string; value: number }[] = [];

  for (const [, body] of sheetXml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const a = /<c r="A\d+"[^>]*t="s"[^>]*><v>(\d+)<\/v>/.exec(body);
    const b = /<c r="B\d+"[^>]*><v>([\d.]+)<\/v>/.exec(body);
    if (!a || !b) continue;
    const date = dotDateToIso(ss[Number(a[1])] ?? '');
    const value = Number(b[1]);
    if (date && date >= since && Number.isFinite(value)) out.push({ date, value });
  }
  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐 mofJgb,防源变序静默炸图。
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** 下载 JPX xlsx → 解 zip → 解析。默认 2018 起。 */
export async function fetchJgbVix(since = '2018-01-01'): Promise<{ date: string; value: number }[]> {
  const resp = await fetchWithTimeout(XLSX_URL, { headers: { 'User-Agent': UA } });
  const files = unzipSync(new Uint8Array(await resp.arrayBuffer()));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  const shared = strFromU8(files['xl/sharedStrings.xml']);
  return parseJgbVixXlsx(sheet, shared, since);
}
