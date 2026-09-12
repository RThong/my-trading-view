// 日银「需給ギャップ / 潜在成長率」(调查统计局试算,季度更新)。官方 xlsx = zip+XML,解包见 fetchers/xlsx。
//
// 产出缺口 = (实际 GDP − 潜在 GDP) / 潜在 GDP × 100%。正 = 需求超过产能(物价往上),负 = 有闲置。
// 潜在 GDP 是**估算量不是统计量**(资本存量 + 劳动投入 + TFP 的正常利用水平),日银自己在说明页
// 写明「因方法而异可能相差甚大」—— 故这两条只读方向与拐点,别当精确读数,更别拿去减别家的口径。
// (内阁府另发一套 GDPギャップ,两家水平常年差零点几个百分点、方向一般一致。)
//
// ⚠️ **末尾有「只有短观 DI、没有 gap」的行**:GDP 还没出的季度照样占一行(实测 2026.2Q / 2026.3Q)。
// 按行号取末行会拿到空值 —— 故一律按「总量列非空」过滤,见 readRows。
//
// ⚠️ **两张表的时间轴不是一套**:data1 是日历季度,data2 是**财年半期**(上期 = 4-9 月)。
// 不要 join,也不要拿半年度那条去对季度那条的拐点。
//
// ⚠️ 2026 年 3 月日银改过一次推计方法(论文 ron260326a.pdf,**未核原文**)。跨年份比水平前自己确认断点。
import { fetchWithTimeout } from './http';
import { openXlsx } from './xlsx';

const XLSX_URL = 'https://www.boj.or.jp/research/research_data/gap/gap.xlsx';

type Point = { date: string; value: number };

/** data1:日历季度。A 标签 + B 需給ギャップ。C/D 是资本/劳动投入分项,面板不发。 */
const QUARTERLY_SHEET = 'data1';
/** data2:财年半期。A 标签 + B 潜在成長率 + C-F 四项贡献度(TFP / 资本存量 / 劳动时间 / 就业者数)。 */
const SEMIANNUAL_SHEET = 'data2';
const CONTRIBUTION_COLS = ['C', 'D', 'E', 'F'] as const;

/** 季末日。季度值代表整个季度,落在季末比季初更贴「这一季的读数」。 */
const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'];

/**
 * 行标签 → ISO 日期。**取标签里最后一个 `YYYY.NQ`**,两张表因此共用一个解析器:
 *   data1 `2026.1Q`                  → 2026-03-31
 *   data2 `2025.2 : 2025.4Q-2026.1Q` → 2026-03-31(半期末,即那半年的最后一季)
 * 认不出(表头行、空行、说明文字)→ null,整行跳过。
 */
export function labelToIso(label: string): string | null {
  const last = [...label.matchAll(/(\d{4})\.([1-4])Q/g)].at(-1);
  return last ? `${last[1]}-${QUARTER_END[Number(last[2]) - 1]}` : null;
}

/**
 * 某列的内联数值。空单元格 `<c r="B9"/>` 无 `<v>`,自然不匹配。
 *
 * ⚠️ **`t` 缺省和 `t="n"` 都是数值**:Excel 自己写数值时省略 `t`,但别的写入器会显式写 `n`。
 * 只认「无 t」的话,哪天官方换个工具导出,表现是整列读不到 → 抛「一行都没解析出」,
 * 错误信息会把人指向「行标签格式改版」这个假因。其余 t(`s` 共享字符串 / `str` / `b` / `e`)不是数,照旧排掉。
 */
function cellNumber(rowXml: string, col: string): number | null {
  const m = new RegExp(`<c r="${col}\\d+"([^>]*)><v>(-?[\\d.eE+-]+)</v>`).exec(rowXml);
  if (!m) return null;

  const t = /\bt="([^"]*)"/.exec(m[1])?.[1];
  if (t !== undefined && t !== 'n') return null;

  const v = Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

/** A 列的共享字符串(行标签)。 */
function cellLabel(rowXml: string, shared: string[]): string | null {
  const m = /<c r="A\d+"[^>]*\bt="s"[^>]*><v>(\d+)<\/v>/.exec(rowXml);
  return m ? (shared[Number(m[1])] ?? null) : null;
}

/**
 * 工作表 XML → `[{ date, values }]` 升序。values 与 cols 同序。
 *
 * **cols[0] 是「总量列」,它空则整行丢弃** —— 那正是待发布行(短观 DI 已有、GDP 未出)的形状。
 * 贡献度列单独缺(早年几项没拆)不丢行,那几项返回 null 由调用方各自跳过。
 */
export function readRows(
  sheetXml: string,
  shared: string[],
  cols: readonly string[],
  since: string,
): { date: string; values: (number | null)[] }[] {
  const out: { date: string; values: (number | null)[] }[] = [];

  for (const [, body] of sheetXml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const label = cellLabel(body, shared);
    const date = label ? labelToIso(label) : null;
    if (!date || date < since) continue;

    const values = cols.map((c) => cellNumber(body, c));
    if (values[0] === null) continue; // 待发布行:有标签、没数

    out.push({ date, values });
  }

  // 源已升序,但 lightweight-charts 对乱序 setData 会抛;显式排序对齐其它 fetcher。
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 对外六条序列。贡献度四条与 potentialGrowth 同频同日,相加 ≈ 总量。 */
export type BojGap = {
  outputGap: Point[];
  potentialGrowth: Point[];
  potTfp: Point[];
  potCapital: Point[];
  potHours: Point[];
  potWorkers: Point[];
};

/** 两张表的 XML → 六条序列。任一表解不出数据 → 抛错(表结构改版比「暂时没数据」更可能)。 */
export function parseBojGap(quarterlyXml: string, semiannualXml: string, shared: string[], since: string): BojGap {
  const gapRows = readRows(quarterlyXml, shared, ['B'], since);
  const potRows = readRows(semiannualXml, shared, ['B', ...CONTRIBUTION_COLS], since);
  if (!gapRows.length || !potRows.length)
    throw new Error('日银产出缺口:两张表有一张一行都没解析出(行标签格式或表结构可能改版)');

  // 第 i 列 → 序列。贡献度那几列早年可能缺,缺则那一点不落(不补 0 —— 0 是「这项没贡献」的真值)。
  const col = (i: number): Point[] =>
    potRows.flatMap((r) => (r.values[i] === null ? [] : [{ date: r.date, value: r.values[i] as number }]));

  return {
    outputGap: gapRows.map((r) => ({ date: r.date, value: r.values[0] as number })),
    potentialGrowth: col(0),
    potTfp: col(1),
    potCapital: col(2),
    potHours: col(3),
    potWorkers: col(4),
  };
}

/**
 * 下载 gap.xlsx(约 52 KB,无鉴权)→ 六条序列。
 *
 * 默认 1994 起:这两条的读法是「缺口转正了没有、潜在增速被什么拖着」,要看到泡沫破灭后那段
 * 长期负缺口才有参照;面板其它日频线的 2018 起点对季频序列太短(只 30 来个点)。
 * 源自带 1983 起全历史,一次 GET 拿全 —— 故**不落库**,修订也就自然跟着回来。
 */
export async function fetchBojGap(since = '1994-01-01'): Promise<BojGap> {
  const resp = await fetchWithTimeout(XLSX_URL);
  if (!resp.ok) throw new Error(`BOJ gap ${resp.status}`); // 非 2xx 抛错,别把错误页当空数据吞

  const wb = openXlsx(await resp.arrayBuffer());
  const quarterly = wb.sheet(QUARTERLY_SHEET);
  const semiannual = wb.sheet(SEMIANNUAL_SHEET);
  if (!quarterly || !semiannual)
    throw new Error(`日银产出缺口:找不到工作表「${QUARTERLY_SHEET}」/「${SEMIANNUAL_SHEET}」(表结构可能改版)`);

  return parseBojGap(quarterly, semiannual, wb.sharedStrings(), since);
}
