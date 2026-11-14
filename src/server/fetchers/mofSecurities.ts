import { fetchWithTimeout } from './http';
import { splitCsvLine } from './dtccCds';

// 日本财务省「対外及び対内証券売買契約等の状況」周次(指定報告機関ベース):免 key、Shift-JIS CSV(约 250KB),
// 一个文件 2005-01 起全历史 → 读时现拉、不落库。每周四前后发上一周(周日~周六),单位億円。
// 布局:第 0 列期间,1~11 列 = 居民买卖外国证券(対外),12~22 列 = 非居民买卖日本证券(対内);
// 两半各是 株式・投資ファンド持分 / 中長期債 / 小計 / 短期債 / 合計,每类 取得・処分・ネット。
// 表头是多行合并单元格,按列名定位不可行 → 改为核对英文那行子表头逐字一致,版式一变就整条抛错。
// 正负号:本文件全段(含 2014 前)净额 = 取得 − 処分,正 = 买超(2026-11 逐行核对 1140 周四组全部成立)。
// 财务省旧版报表 2014 前对外投资是「负 = 买超」,那是旧口径的发布物,这份 CSV 已统一,别照那段说明翻符号。
// ⚠️ 2014-01 起投资信托(契約型)从「中長期債」挪进「株式・投資ファンド持分」,那之前的股 / 债口径不同(源注 ①)。
const URL = 'https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv';
const UA = 'Mozilla/5.0 (compatible; my-trading-view/0.1)';
// 三行英文表头逐字核对(整行,不是前缀):子表头只有 取得 / 処分 / ネット,股债两块、对外对内两半长得一样,
// 光核它的话两块或两半对调了也查不出 → 再核分类那行(股 / 债 / 小计…)和两半那行(Assets / Liabilities)
const SUB_HALF = 'Acquisition,Disposition,Net,Acquisition,Disposition,Net,Net,Acquisition,Disposition,Net,Net';
const CAT_HALF =
  'Equity and investment fund shares,,, Long-term debt securities,,,Subtotal,Short-term debt securities,,,Total';
const HEADER_LINES = [
  `,1. Portfolio Investment Assets${','.repeat(11)}2. Portfolio Investment Liabilities${','.repeat(10)}`,
  `,${CAT_HALF},${CAT_HALF}`,
  `,${SUB_HALF},${SUB_HALF}`,
];
// 各净额所在列(见上方布局)
const COL = { outEquity: 3, outBonds: 6, inEquity: 14, inBonds: 17 } as const;
const DAY_MS = 86_400_000;

/**
 * 一周的四个净额(億円,正 = 买超;空格子为 NaN);date = 该周周五(源的周截止日是周六,图表默认去周末,标周六会被剔掉)。
 */
export type MofFlowWeek = { date: string } & Record<keyof typeof COL, number>;

// 「2026．11．1～11．7」「2006．12．31～ 2007．1．6」:年份只在起点写,跨年时终点另写年份
const PERIOD = /^(\d{4})．(\d{1,2})．(\d{1,2})～\s*(?:(\d{4})．)?(\d{1,2})．(\d{1,2})\s*$/;

function weekFriday(period: string): string | null {
  const m = PERIOD.exec(period);
  if (!m) return null;
  const sat = Date.UTC(Number(m[4] ?? m[1]), Number(m[5]) - 1, Number(m[6]));

  return new Date(sat - DAY_MS).toISOString().slice(0, 10);
}

// 「"1,689 "」「-818 」→ 数字;空格子记 NaN(Number('') 是 0,会把缺值伪装成「净额 0」)
function num(s: string | undefined): number {
  const t = (s ?? '').replace(/,/g, '').trim();
  return t ? Number(t) : Number.NaN;
}

export function parseMofWeeklyFlows(text: string): MofFlowWeek[] {
  const lines = text.split(/\r?\n/);
  const have = new Set(lines.map((l) => l.trim()));
  if (!HEADER_LINES.every((h) => have.has(h))) throw new Error('MOF 证券流:表头对不上(版式可能变了)');

  const weeks = lines.flatMap((line): MofFlowWeek[] => {
    const cols = splitCsvLine(line);
    const date = weekFriday(cols[0] ?? '');
    if (!date) return [];
    const vals = Object.fromEntries(Object.entries(COL).map(([k, i]) => [k, num(cols[i])])) as Record<
      keyof typeof COL,
      number
    >;
    // 只要有一格是数就留下这周;空格子保留为 NaN,由调用方按序列各自滤掉(别让一格空把另外三条也拖掉一周)
    return Object.values(vals).some(Number.isFinite) ? [{ date, ...vals }] : [];
  });
  if (!weeks.length) throw new Error('MOF 证券流:一行数据都没解析出来');

  return weeks;
}

export async function fetchMofWeeklyFlows(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<MofFlowWeek[]> {
  const res = await doFetch(URL, { headers: { 'User-Agent': UA } }, 30_000);
  if (!res.ok) throw new Error(`MOF 证券流 ${res.status}`);

  return parseMofWeeklyFlows(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
}
