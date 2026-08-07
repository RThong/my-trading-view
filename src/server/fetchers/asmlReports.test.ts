import { describe, expect, test } from 'bun:test';
import { parseAsmlReport } from './asmlReports';

/**
 * ASML 报表的两种表格编码都要吃:
 *  · cells —— 2025Q1 及更早,数字在各自的单元格里
 *  · inline —— 2025Q2 起,整份文档没有 <table>,数字与标签同处一个文本块
 * 两种的**列序都是 [去年同期, 本期, 去年累计, 本期累计]**,本期在第 2 个数字。
 */
type Cols = {
  revPrev: number;
  rev: number;
  cogsPrev: number;
  cogs: number;
  ocfPrev: number;
  ocf: number;
  capexPrev: number;
  capex: number;
  gmPrev: number;
  gm: number;
};

const REAL: Cols = {
  // 实测 2026Q2 那份:去年同季 / 本季。
  revPrev: 7691.7,
  rev: 9326.5,
  cogsPrev: 3562.2,
  cogs: 4291.1,
  ocfPrev: 747.7,
  ocf: 1703.0,
  capexPrev: 414.8,
  capex: 299.4,
  gmPrev: 53.7,
  gm: 54.0,
};

const n = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 1 });

/** 单元格式(老版):每个数字一个 <td>。 */
const cells = (c: Cols) =>
  `<p>(Unaudited, in millions, except per share data)</p><table>` +
  `<tr><td>Three months ended</td><td>Six months ended</td></tr>` +
  `<tr><td>Total net sales</td><td>${n(c.revPrev)}</td><td>${n(c.rev)}</td><td>15,433.2</td><td>18,093.4</td></tr>` +
  `<tr><td>Total cost of sales</td><td>(${n(c.cogsPrev)})</td><td>(${n(c.cogs)})</td><td>(7,124.0)</td><td>(8,413.0)</td></tr>` +
  `<tr><td>Gross margin</td><td>${c.gmPrev} %</td><td>${c.gm} %</td><td>53.8 %</td><td>53.5 %</td></tr>` +
  `<tr><td>Net cash provided by (used in) operating activities</td><td>${n(c.ocfPrev)}</td><td>${n(c.ocf)}</td><td>689.1</td><td>(482.5)</td></tr>` +
  `<tr><td>Purchase of property, plant and equipment</td><td>(${n(c.capexPrev)})</td><td>(${n(c.capex)})</td><td>(829.8)</td><td>(701.8)</td></tr>` +
  `</table>`;

/** 内联式(新版):整段是纯文本,数字靠空格分隔。 */
const inline = (c: Cols) =>
  `<div>(Unaudited, , in millions, except per share data) 2025 2026 2025 2026 ` +
  `Total net sales ${n(c.revPrev)} ${n(c.rev)} 15,433.2 18,093.4 ` +
  `Total cost of sales (${n(c.cogsPrev)}) (${n(c.cogs)}) (7,124.0) (8,413.0) ` +
  `Gross profit 4,129.5 5,035.4 8,309.2 9,680.4 ` +
  `Gross margin ${c.gmPrev} % ${c.gm} % 53.8 % 53.5 % ` +
  `Cash flows from operating activities Net income 2,290.3 2,917.6 4,645.3 5,674.3 ` +
  `Net cash provided by (used in) operating activities ${n(c.ocfPrev)} ${n(c.ocf)} 689.1 (482.5) ` +
  `Cash flows from investing activities ` +
  `Purchase of property, plant and equipment (${n(c.capexPrev)}) (${n(c.capex)}) (829.8) (701.8)</div>`;

describe('parseAsmlReport', () => {
  for (const [name, build] of [
    ['单元格式(2025Q1 及更早)', cells],
    ['内联式(2025Q2 起,整份无 <table>)', inline],
  ] as const) {
    test(`${name}:取**第 2 列**(本期),不是第 1 列`, () => {
      const r = parseAsmlReport(build(REAL));

      // 列序和 TSM 相反。取错列会拿到去年同季的 7,691.7 —— 不会报错,只会静默错一年。
      expect(r).toEqual({ revenue: 9326.5, cogs: 4291.1, ocf: 1703.0, capex: 299.4 });
      expect(r.revenue).not.toBe(REAL.revPrev);
      expect(((r.revenue - r.cogs) / r.revenue) * 100).toBeCloseTo(54.0, 1);
    });
  }

  test('自校验:算出的毛利率与报表自印的对不上就抛', () => {
    // 把印出来的毛利率改成 60%(而营收/成本仍算出 54%)→ 必须拒绝,这正是取错列的症状。
    expect(() => parseAsmlReport(inline({ ...REAL, gm: 60.0 }))).toThrow(/与报表自印的 60% 不符/);
  });

  test('自校验容差:报表只印一位小数,差 0.1pp 之内要放行', () => {
    expect(() => parseAsmlReport(inline({ ...REAL, gm: 53.9 }))).not.toThrow();
  });

  test('单位不是 millions 就抛 —— 静默换算是 1000 倍错误', () => {
    expect(() => parseAsmlReport(cells(REAL).replace('in millions', 'in thousands'))).toThrow(/拒绝按百万换算/);
  });

  test('capex 锚在现金流那一段之后', () => {
    // 资产负债表里也有「Purchase of property...」样的行时,不该取到前面那个。
    const withDecoy =
      '<p>(Unaudited, in millions)</p><p>Purchase of property, plant and equipment 111.1 222.2</p>' + inline(REAL);
    expect(parseAsmlReport(withDecoy).capex).toBe(299.4);
  });

  test('缺行就抛,不静默给 0', () => {
    expect(() => parseAsmlReport('<p>(Unaudited, in millions)</p><p>Total net sales</p>')).toThrow(/没解析出来/);
  });
});
