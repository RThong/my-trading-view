// S&P/JPX JGB VIX(日债隐含波动率)。主源是 JPX 官方 xlsx(=zip+XML):A 列=日期(共享字符串 YYYY.MM.DD),B 列=值。2008 起,每日更新。
// CBOE 镜像同一指数(SPJGBV),用来补 JPX 文件缺的天(2021-10 整月、2019 年几个月残缺,2018 起约 68 天),
// JPX 挂了时兼作备份。见 docs/data-sources-candidates.md §2.0′。
import { unzipSync, strFromU8 } from 'fflate';
import { fetchWithTimeout } from './http';
import { defaultCboeIndexClient } from './cboeIndex';

type Point = { date: string; value: number };

// ponytail: JPX 哈希 URL,改版会变。挂了 → 服务端日志一行「[jgbVix] JPX 失败」+ 面板标「沿用上次」
// (历史沿用上一份、新点由 CBOE 补,见 routes/regimePolicy 的 resolveJgbVix)—— 看到就去 JPX 页面重取链接。
// 例外:冷启动没有上一份时不标「沿用上次」,整页只标不完整;两边都挂则整条 unavailable(抛错里带两边原因)。
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
  const out = [...sheetXml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].flatMap(([, body]) => {
    const a = /<c r="A\d+"[^>]*t="s"[^>]*><v>(\d+)<\/v>/.exec(body);
    const b = /<c r="B\d+"[^>]*><v>([\d.]+)<\/v>/.exec(body);
    if (!a || !b) return [];
    const date = dotDateToIso(ss[Number(a[1])] ?? '');
    const value = Number(b[1]);
    return date && date >= since && Number.isFinite(value) ? [{ date, value }] : [];
  });
  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐 mofJgb,防源变序静默炸图。
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * JPX 为主,CBOE 只补 JPX 没有的天。CBOE 按美国日历出数:日本假日沿用前一天的值(那天日本没开市),
 * 所以补的点若和 CBOE 自己前一天的值相同就丢掉。美国假日 CBOE 没有值,不影响(JPX 有)。
 */
export function mergeJgbVix(jpx: Point[], cboe: Point[]): Point[] {
  const fill = cboe.filter((p, i) => p.value !== cboe[i - 1]?.value);
  // 按日期去重,JPX 排后面覆盖 CBOE(同一天以 JPX 为准;源里自身的重复日期取后出现的)
  const byDate = new Map([...fill, ...jpx].map((p) => [p.date, p]));

  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

async function fetchJpx(since: string): Promise<Point[]> {
  const resp = await fetchWithTimeout(XLSX_URL, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`JPX JGB VIX 下载失败:${resp.status}`);
  const files = unzipSync(new Uint8Array(await resp.arrayBuffer()));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  const shared = strFromU8(files['xl/sharedStrings.xml']);
  const points = parseJgbVixXlsx(sheet, shared, since);
  // 解析出 0 行 = 改版(工作表 / 列结构变了),当失败,别让 CBOE 悄悄顶上
  if (!points.length) throw new Error('JPX JGB VIX 解析出 0 行(xlsx 结构可能变了)');

  return points;
}

// 不按 since 截:窗口第一天要和它的前一天比,才认得出日本假日沿用的值;截在合并之后
async function fetchCboe(): Promise<Point[]> {
  const rows = await defaultCboeIndexClient().fetchHistory('SPJGBV');
  // 同 JPX:200 但解析出 0 行 = 改版,当失败(否则补缺悄悄失效,JPX 也挂时还会误报「改用 CBOE」)
  if (!rows.length) throw new Error('CBOE SPJGBV 解析出 0 行(CSV 结构可能变了)');

  return rows.map((r) => ({ date: r.tradeDate, value: r.close }));
}

/**
 * JPX + CBOE 合并;一边挂了用另一边,两边都挂才抛。默认 2018 起。
 * degraded = 只有一边可用:单源序列有缺陷(只 CBOE 缺美国假日、只 JPX 缺它整月缺的那几段),
 * 调用方别把它当完整结果长缓存(见 routes/regime 的 jgbVix)。
 */
export async function fetchJgbVix(since = '2018-01-01'): Promise<{ points: Point[]; degraded: boolean }> {
  const [jpx, cboe] = await Promise.allSettled([fetchJpx(since), fetchCboe()]);
  if (jpx.status === 'rejected' && cboe.status === 'rejected')
    throw new Error(`JGB VIX 两源都失败:JPX ${(jpx.reason as Error).message};CBOE ${(cboe.reason as Error).message}`);
  // 只说哪边失败;降级后怎么用(沿用上次 + 单源补新点)由路由层定,见 resolveJgbVix
  if (jpx.status === 'rejected') console.warn(`[jgbVix] JPX 失败(降级为单源): ${(jpx.reason as Error).message}`);
  if (cboe.status === 'rejected') console.warn(`[jgbVix] CBOE 失败(降级为单源): ${(cboe.reason as Error).message}`);

  const merged = mergeJgbVix(
    jpx.status === 'fulfilled' ? jpx.value : [],
    cboe.status === 'fulfilled' ? cboe.value : [],
  );
  return {
    points: merged.filter((p) => p.date >= since),
    degraded: jpx.status === 'rejected' || cboe.status === 'rejected',
  };
}
