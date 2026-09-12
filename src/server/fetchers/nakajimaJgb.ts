// 日本国债长端分解:期限溢价 / 预期短端(日频)+ 自然利率 r*(季频,带 95% 区间)。
// 源 = 中島上智(日银)公开的模型估计,GitHub 仓库 jouchinakajima/program 里的两个 CSV。
//
// ⚠️ **发布节奏是 2-4 个月不规律,不是季频**(实测 commit 间隔:27d / 57d / 62d / 71d / 77d / 110d / 111d)。
// 按「季频」设预期会误判成停更。两个文件**同日打包发**,所以只监控一个就够。
// 判停更**看 commit 时间不看数据末点** —— 数据末点天然滞后发布约一周,两者在图上长得一样:
//   curl -s "https://api.github.com/repos/jouchinakajima/program/commits?path=yield_D.csv&per_page=1"
// 超过 150 天没新 commit 才算停更(门槛 = 两文件的历史最大间隔 —— yield_D.csv 111d / rstar.csv 114d —— 再留余量)。
//
// ⚠️ **单模型,没有对照。** 美债那边是 Kim-Wright 与 ACM 两套并排、分歧带宽才是产品;日本这边只有这一套,
// 读到的就是点估计,没有第二个模型给它当置信度。别把它当成和美债那两条同等强度的证据。
//
// ✅ 与仓库已有的 MOF 曲线同尺:实测 6 个抽查日(2026-06-30 / 2026-03-31 / 2025-12-30 / 2025-09-01 /
// 2024-09-02 / 2022-09-01),`TermPremium-10Y + ExpectedRate-10Y − MOF 名义 10Y` 残差全是 0.00。
// 即这套分解**重构的就是同一条曲线**,不是第三方近似 —— 可以直接和 jgb10y 并排读。
import { fetchWithTimeout } from './http';
import { quarterEndIso } from './quarter';

const BASE = 'https://raw.githubusercontent.com/jouchinakajima/program/main';
const YIELD_URL = `${BASE}/yield_D.csv`; // 日频。同目录另有 yield_M.csv(月频,同列)
const RSTAR_URL = `${BASE}/rstar.csv`;

type Point = { date: string; value: number };

/**
 * 按**表头名**取列,不按列号:两个文件都是十几列的宽表,列序一变按列号会静默取到邻列
 * (`TermPremium-10Y` 旁边就是 15Y/20Y,量级只差零点几,画出来不报错也看不出)。
 *
 * ⚠️ 表头**不一定在第一行**:rstar.csv 第 1 行是 `Data as of 26-07-06,,,,,,` 这样的元数据。
 * 故按「首格等于 anchor」找表头行,而不是硬编码跳过几行 —— 官方多加一行说明就会错位。
 */
function parseCsv(text: string, anchor: string): { cols: string[]; rows: string[][] } | null {
  const lines = text.trim().split(/\r?\n/);
  const cell = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
  const head = lines.findIndex((l) => cell(l.split(',')[0] ?? '') === anchor);
  if (head < 0) return null;

  return {
    cols: lines[head].split(',').map(cell),
    rows: lines.slice(head + 1).map((l) => l.split(',').map(cell)),
  };
}

/** `20260630` → `2026-06-30`;日历上不存在的日期(如 0230)→ null,整行跳过。 */
export function yyyymmddToIso(s: string): string | null {
  if (!/^\d{8}$/.test(s)) return null;

  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** `20262` → `2026-06-30`(季末)。**5 位不是 6 位**:4 位年 + 1 位季号。 */
export function yyyyqToIso(s: string): string | null {
  const m = /^(\d{4})([1-4])$/.exec(s.trim());
  return m ? quarterEndIso(m[1], Number(m[2])) : null;
}

/**
 * CSV → 每个请求列一条 `{date,value}[]` 升序。
 * 日期解不出、或该格不是有限数 → 那一点不落(不补 0)。
 *
 * **任一目标列一行都没落出来 → 整体返回 null**(等同「缺列」)。只校验其中一两列是不够的:
 * 列名还在、内容变了(全空 / 变成文字)的话,那一列会静默成空序列 —— 对 95% 区间尤其致命,
 * 带没了图上只是少两条线,而带宽本身就是「这个点估计别当读数用」的提示。
 */
export function parseSeries(
  text: string,
  anchor: string,
  toIso: (s: string) => string | null,
  wanted: readonly string[],
  since: string,
): Record<string, Point[]> | null {
  const table = parseCsv(text, anchor);
  if (!table) return null;

  const idx = wanted.map((w) => table.cols.indexOf(w));
  if (idx.some((i) => i < 0)) return null; // 少了要的列 = 表结构改版,交给调用方抛错

  const out: Record<string, Point[]> = Object.fromEntries(wanted.map((w) => [w, [] as Point[]]));
  for (const row of table.rows) {
    const date = toIso(row[0] ?? '');
    if (!date || date < since) continue;

    wanted.forEach((w, k) => {
      const v = Number(row[idx[k]]);
      if (row[idx[k]]?.length && Number.isFinite(v)) out[w].push({ date, value: v });
    });
  }

  if (Object.values(out).some((rows) => !rows.length)) return null;

  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐其它 fetcher。
  for (const s of Object.values(out)) s.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

const TP_COL = 'TermPremium-10Y';
const EXP_COL = 'ExpectedRate-10Y';
/** r* 只取 10Y 那组:它是长端的自然利率锚,与上面的 10Y 分解同期限才能并排读。
 *  文件里另有 1Y 那组(政策利率空间的读法),要用再加一行 —— 现在没有对读的对象。 */
const RSTAR_COLS = ['10Y_Mean', '10Y_95%Low', '10Y_95%High'] as const;

export type NakajimaJgb = {
  termPremium10: Point[];
  expectedRate10: Point[];
  rstar10: Point[];
  rstar10Lo: Point[];
  rstar10Hi: Point[];
};

/** 两个 CSV 的文本 → 五条序列。任一侧解不出 → 抛错(表结构改版比「暂时没数据」更可能)。 */
export function parseNakajima(yieldCsv: string, rstarCsv: string, since: string): NakajimaJgb {
  const y = parseSeries(yieldCsv, 'YYYYMMDD', yyyymmddToIso, [TP_COL, EXP_COL], since);
  const r = parseSeries(rstarCsv, 'YYYYQ', yyyyqToIso, RSTAR_COLS, since);
  // parseSeries 已保证「返回非 null ⇒ 每条目标列都至少有一行」,故这里判两个对象就够,不必再逐条数长度。
  if (!y || !r) throw new Error('Nakajima JGB:表头缺列、或某列一行都没解析出(列名或表结构可能改版)');

  return {
    termPremium10: y[TP_COL],
    expectedRate10: y[EXP_COL],
    rstar10: r['10Y_Mean'],
    rstar10Lo: r['10Y_95%Low'],
    rstar10Hi: r['10Y_95%High'],
  };
}

/**
 * 下载两个 CSV(合计约 780 KB)→ 五条序列。默认取全历史(源 1995 起)。
 *
 * 不落库:一次 GET 给全历史,且模型每次重估会**改写整条历史**(和 HLW current 一样) ——
 * 攒增量只会把旧 vintage 和新 vintage 混在一条线里。
 */
export async function fetchNakajimaJgb(since = '1995-01-01'): Promise<NakajimaJgb> {
  const [yieldResp, rstarResp] = await Promise.all([fetchWithTimeout(YIELD_URL), fetchWithTimeout(RSTAR_URL)]);
  if (!yieldResp.ok || !rstarResp.ok) throw new Error(`Nakajima JGB ${yieldResp.status}/${rstarResp.status}`); // 非 2xx 抛错,别把错误页当空数据吞

  return parseNakajima(await yieldResp.text(), await rstarResp.text(), since);
}
