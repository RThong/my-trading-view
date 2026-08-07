import {
  defaultFetch,
  fetchReportDoc,
  flattenHtml,
  listQuarterly6K,
  numsInRow,
  type FetchFn,
  type FsFiling,
  type Sec6kValues,
} from './sec6k';

/**
 * ASML 交给 EDGAR 的**季度 6-K**(封面 `form6-kquarterlyfilings.htm`),里面
 * `financialstatementsusgaa*.htm` 是**美国会计准则**摘要报表 —— ASML 是少见的用 US GAAP
 * 报的外国发行人,不是 IFRS。
 *
 * 为什么不用 companyfacts:ASML 的 companyfacts 虽然在 `us-gaap` 命名空间下有 623 个 tag,
 * 但**只有年频、只来自 20-F** —— 季报 6-K 近十年一份都没做 XBRL 标记(实测 46 份里 0 份)。
 *
 * 比 TSM 那条好在三处:
 *  1. **单季直给**,不用差分(每份都有 "Three months ended" 那一列)。
 *  2. **T+16~17**(实测 2026-06-28 → 07-15),而 TSM 是 T+45。
 *  3. 报表**自己印了毛利率**,可以拿来验解析有没有取错列 —— 见 parseAsmlReport 的自校验。
 *
 * ⚠️ 列序**和 TSM 相反**:ASML 是 `[去年同期, 本期, 去年累计, 本期累计]`,本期在**第 2 列**。
 * 币种 EUR,单位百万。历史 22 个季度(2021Q1 起),可回填。
 */

/** 季报 6-K 的封面名。月度/年报/股东会那些 6-K 都另有前缀,不会混进来。 */
const QUARTERLY_DOC = /^form6-kquarterlyfilings\.htm$/i;

/** 同一份申报里的非报表文件:封面、新闻稿、投资者演示、荷兰法定中报(IFRS,口径不同)。 */
const NOT_THE_REPORT = /^form6-k|presentation|pressrelease|statutory/i;

/** 报表单位是**百万欧元** → 基础货币单位的乘数。 */
export const ASML_SCALE = 1_000_000;

/** 计算出的毛利率与报表自印值允许差多少(百分点)。报表只印一位小数,故不能为 0。 */
const GM_TOLERANCE_PP = 0.15;

/**
 * 解析一份 ASML 季度报表,取**本期单季**四科目(百万欧元)。
 *
 * 列结构两种,但**本期恒在第 2 个数字**,所以不用分支:
 *  · Q1 报告:两列 `[去年 Q1, 本期 Q1]`
 *  · Q2/Q3/Q4:四列 `[去年同季, 本期季, 去年累计, 本期累计]`(Q4 的累计写作 "Twelve months ended")
 * 与 TSM 相反 —— 那边本期在第 1 列。这一条错了不会报错,只会静默取到去年的数。
 *
 * 故用报表**自己印的毛利率**当守卫:算出来的和印出来的对不上就抛。
 */
export function parseAsmlReport(html: string): Sec6kValues {
  const txt = flattenHtml(html);

  // 单位必须确认过才敢用:若哪天改成千欧元,静默换算就是 1000 倍错误。
  if (!/in millions/i.test(txt)) throw new Error('ASML 报表:没确认到「in millions」表头,拒绝按百万换算');

  // ASML 的报表换过表格编码:2025Q1 及更早是单元格式,2025Q2 起数字与标签同处一个文本块
  // (整份文档 <table> 数为 0)。numsInRow 两种都吃,见它的注释。
  const CURRENT = 1; // 本期在第 2 个数字(索引 1)
  const pick = (label: string, from = 0): number => {
    const xs = numsInRow(txt, label, CURRENT + 1, from);
    const v = xs[CURRENT];
    if (v === undefined || !Number.isFinite(v)) throw new Error(`ASML 报表:${label} 没解析出来(列结构可能变了)`);
    return v;
  };

  const revenue = pick('Total net sales');
  const cogs = Math.abs(pick('Total cost of sales')); // 报表里是负数
  const ocf = pick('Net cash provided by (used in) operating activities');
  // capex 从 OCF 那一行往后找 —— 现金流量表里才是「购置」,别撞上别处同名的行。
  const capex = Math.abs(pick('Purchase of property, plant and equipment', txt.indexOf('operating activities')));

  // 自校验:报表在「Ratios and Other Data」里印了本期毛利率。取错列时这两个必然对不上。
  const printed = numsInRow(txt, 'Gross margin', CURRENT + 1)[CURRENT];
  const computed = ((revenue - cogs) / revenue) * 100;
  if (printed !== undefined && Math.abs(printed - computed) > GM_TOLERANCE_PP) {
    throw new Error(`ASML 报表:算出的毛利率 ${computed.toFixed(2)}% 与报表自印的 ${printed}% 不符 —— 多半是取错了列`);
  }

  return { revenue, cogs, ocf, capex };
}

export function createAsmlFetcher(doFetch: FetchFn = defaultFetch) {
  return {
    listFilings: (cik: string): Promise<FsFiling[]> => listQuarterly6K(cik, QUARTERLY_DOC, doFetch),
    fetchReport: async (cik: string, accn: string): Promise<string> =>
      (await fetchReportDoc(cik, accn, NOT_THE_REPORT, doFetch)).html,
  };
}
