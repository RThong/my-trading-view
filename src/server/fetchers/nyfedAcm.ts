// ACM 期限溢价(纽约联储 Adrian-Crump-Moench,10Y,月频)。**它的用途是给 Kim-Wright 当独立对照。**
//
// ⚠️ 单独读这条没有意义 —— 它和 `tp10Kw` 并排,**分歧带宽本身才是产品**。实测 440 个月重叠:
// ACM 与 KW 的期限溢价平均差 57 bp、中位 47、P90 124、最大 222。只报其中一条的点估计是误用。
// (对照:Fed 理事会的 DKW 与 KW 只差 8.5 bp —— 同一个 Don Kim,同族精化,不构成对照。)
//
// ⚠️ **这个 CSV 是无文档端点。** 官方公开发布的是同目录下 10.1 MB 的 `ACMTermPremium.xls`
// (BIFF8/OLE,要 SheetJS);而这个 49 KB 的 CSV 是 NY Fed 自家 term-premia 交互图表的取数源,
// 从它的 Angular bundle 里挖出来的。已逐字对账确认**内容就是官方 xls 的 `ACM Monthly` 表**
// (15 位有效数字相同、行数同为 784、末点同日),但官方随时可能改版图表把它挪走。
// 故:拿不到就归 unavailable,别当稳定接口,也别为它加重试。
//
// ⚠️ 相对那个 xls 的取舍:**月频**(xls 有日频)、**只有 10Y**(xls 有 1–10Y)。
// 面板只需要 10Y 的对照,换来零依赖 + 49 KB,值。要日频或其它期限就只能回去啃 BIFF8。
import { fetchWithTimeout } from './http';

const CSV_URL = 'https://www.newyorkfed.org/medialibrary/media/research/data_indicators/acmPlot_data.csv';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const DATE_COL = 'RunDates';
const TP_COL = 'TERMYld'; // 10Y 期限溢价。同文件另有 ACMFITYld(拟合 10Y)、GSWYld(市场 10Y)

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/**
 * '31-Aug-2026' → '2026-08-31'。其它形状 → null(整行跳过)。
 *
 * ⚠️ 光校验月名和年份不够 —— 日号那段也得验形状**和这一天真的存在**。
 * 只做前者的话,`xx-Aug-2026` / `31-Feb-2026` 会原样拼成 `2026-08-xx` / `2026-02-31`:
 * 它们「解析成功」了,于是绕过下面「一行都没解析出就抛错」那道保护,把非法日期交给图表。
 */
function toIso(s: string): string | null {
  const m = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/.exec(s.trim());
  if (!m || !MONTHS[m[2]]) return null;

  const iso = `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
  // 回一趟 Date 再比对:2 月 31 日这种「格式合法但日历上不存在」的只有这样才拦得住。
  // ⚠️ 先判 Invalid —— `0-Aug` 会拼成 `2026-08-00`,那是 Invalid Date,而 toISOString 对它**抛 RangeError**
  // 而不是返回值;少这一步,一个脏日期就能把整条 fetcher 炸掉,而不是让那一行安静跳过。
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** 期限溢价数值;空单元格 → null(跳过)。`Number('')` 是 **0** 且通过 isFinite,直接用会落成假的零溢价。 */
function toValue(v: string | undefined): number | null {
  const s = v?.trim() ?? '';
  return s && Number.isFinite(Number(s)) ? Number(s) : null;
}

/**
 * acmPlot_data.csv → 10Y 期限溢价的 [{date,value}] 升序。
 *
 * ⚠️ **按表头名定位列,不按列号。** 同文件里 `ACMFITYld` 是拟合收益率(量级 4.8),
 * 与溢价(量级 0.8)差十倍 —— 列序一变,按列号取会画出一条高得离谱但不报错的线。
 *
 * 表头行与非法日期行靠 toIso 自然滤掉;**一行都没解析出 → 抛错**,
 * 因为那说明日期格式或表结构变了,静默返回空会被上层当成「源暂时没数据」。
 */
export function parseAcmPlot(csv: string, since: string): { date: string; value: number }[] {
  const [head, ...body] = csv.trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.trim());
  const iDate = cols.indexOf(DATE_COL);
  const iTp = cols.indexOf(TP_COL);
  if (iDate < 0 || iTp < 0) throw new Error(`NY Fed ACM: 表头缺 ${DATE_COL} / ${TP_COL}(表结构可能改版)`);

  const out = body.flatMap((line) => {
    const c = line.split(',');
    const date = toIso(c[iDate] ?? '');
    const value = toValue(c[iTp]);

    return date && date >= since && value !== null ? [{ date, value }] : [];
  });
  if (!out.length) throw new Error(`NY Fed ACM: ${TP_COL} 一行都没解析出(日期格式或表结构可能改版)`);

  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐其它 fetcher。
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 下载 ACM 图表数据 → 10Y 期限溢价。默认 2018 起(对齐面板其它序列)。 */
export async function fetchAcmTermPremium(since = '2018-01-01'): Promise<{ date: string; value: number }[]> {
  const resp = await fetchWithTimeout(CSV_URL, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`NY Fed ACM ${resp.status}`); // 非 2xx 抛错,别把错误页当空数据吞

  return parseAcmPlot(await resp.text(), since);
}
