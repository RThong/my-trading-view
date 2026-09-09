// HLW 自然利率 r*(纽约联储 Holston-Laubach-Williams,季频)。官方 xlsx(=zip+XML),同 jpxJgbVix 的解法。
//
// **只取 current estimates 那一套,不取 real-time。** real-time 的价值只在回测时兑现(避免前视偏差),
// 现在没有回测需求;那份 1.8 MB、每个 vintage 一张 sheet,为不存在的需求付解析成本不值。
// 将来真要回测,另写一个 fetcher 并把序列名带上 `RealTime` —— 不要复用本文件的字段名。
//
// ⚠️ **接这条的理由是「补 L」,不是「填 R* 那个空格」。** 分解式里:
//     A(10Y 名义预期短端均值) = THREEFY10 − THREEFYTP10   ← 已有
//     L(名义长期中枢)         = HLW r* + T5YIFR           ← 本文件补的是 r* 这一半
//   两块齐了,偏差项才从「只能写方向」变成可定量。
//
// ⚠️ **r* 是 L 的一半,不是减数。** 别拿 `10Y实际 − r*` 当实际期限溢价:
//     10Y实际 − r* = (A_real − r*) + 实际期限溢价
//   第一项是政策周期残留(当前短端远在中性之上时显著为正),不是溢价。直接相减会高估期限溢价。
import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';

const XLSX_URL =
  'https://www.newyorkfed.org/medialibrary/media/research/economists/williams/data/Holston_Laubach_Williams_current_estimates.xlsx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 'HLW Estimates' 工作表。四个指标块 × 三国(US / Canada / Euro Area):
// C-E 趋势增长 g、G-I 其他决定项 z、**K-M 自然利率 r***、O-Q 产出缺口。US 是各块首列 → r* = K。
const SHEET = 'xl/worksheets/sheet2.xml';
const RSTAR_COL = 'K';

// Excel 序列日 → ISO。纪元 1899-12-30(Excel 的 1900 闰年 bug 已含在这个偏移里)。
// 表内日期是**季度首日**(46113 → 2026-04-01,即官方标的 2026Q2)。
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  return new Date(EXCEL_EPOCH_MS + serial * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 'HLW Estimates' sheet XML → 美国 r* 的 [{date,value}] 升序。
 *
 * 只认 A 列为**内联数值**(无 `t=` 属性)的行:表头那几行 A 列是共享字符串('Date' 等),
 * 靠这一条就把它们过滤掉了,不必按行号硬编码数据起始行(官方加一行说明就会错位)。
 */
export function parseHlwSheet(sheetXml: string, since: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];

  for (const [, body] of sheetXml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const a = /<c r="A\d+"(?![^>]*\bt=)[^>]*><v>([\d.]+)<\/v>/.exec(body);
    const k = new RegExp(`<c r="${RSTAR_COL}\\d+"(?![^>]*\\bt=)[^>]*><v>(-?[\\d.eE+-]+)</v>`).exec(body);
    if (!a || !k) continue;

    const date = excelSerialToIso(Number(a[1]));
    const value = Number(k[1]);
    if (date && date >= since && Number.isFinite(value)) out.push({ date, value });
  }

  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐其它 fetcher。
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** 下载 HLW current xlsx → 解 zip → 取美国 r*。默认 2018 起。 */
export async function fetchHlwRstar(since = '2018-01-01'): Promise<{ date: string; value: number }[]> {
  const resp = await fetchWithTimeout(XLSX_URL, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`NY Fed HLW ${resp.status}`); // 非 2xx 抛错 → 上层归 unavailable,别把错误页当空数据吞

  const files = unzipSync(new Uint8Array(await resp.arrayBuffer()));
  const sheet = files[SHEET];
  if (!sheet) throw new Error(`NY Fed HLW: ${SHEET} 缺失(表结构可能改版)`);

  return parseHlwSheet(strFromU8(sheet), since);
}
