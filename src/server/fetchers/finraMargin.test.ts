import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { parseFinraMargin } from './finraMargin';

const HEADS = [
  'Year-Month',
  "Debit Balances in Customers' Securities Margin Accounts",
  "Free Credit Balances in Customers' Cash Accounts",
  "Free Credit Balances in Customers' Securities Margin Accounts",
];

// 最小 xlsx:表头走共享字符串,数据是数字格;最新在上(同源文件),2009 那行没有 D 列
// latestYm:给最新一行的年月格塞一个数字(模拟被 Excel 存成日期序列号),不传则用共享字符串 '2026-10'
function xlsx(heads: string[], dropLatestD = false, latestYm?: string): ArrayBuffer {
  const shared = [...heads, '2026-10', '2009-12'];
  const s = (i: number) => `t="s"><v>${i}</v>`;
  const a2 = latestYm ? `<c r="A2"><v>${latestYm}</v></c>` : `<c r="A2" ${s(4)}</c>`;
  const sheet =
    '<worksheet><sheetData>' +
    `<row r="1">${heads.map((_, i) => `<c r="${'ABCD'[i]}1" ${s(i)}</c>`).join('')}</row>` +
    `<row r="2">${a2}<c r="B2"><v>1448360</v></c><c r="C2"><v>210290</v></c>${dropLatestD ? '' : '<c r="D2"><v>212890</v></c>'}</row>` +
    `<row r="3"><c r="A3" ${s(5)}</c><c r="B3"><v>200000</v></c><c r="C3"><v>100000</v></c></row>` +
    '</sheetData></worksheet>';
  const zip = zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook><sheets><sheet name="Customer Margin Balances" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

describe('parseFinraMargin', () => {
  test('按表头名取列,升序,月记当月 1 日;缺 D 列的月记 NaN', () => {
    const m = parseFinraMargin(xlsx(HEADS));
    expect(m.map((x) => x.date)).toEqual(['2009-12-01', '2026-10-01']);
    expect(m[1]).toEqual({ date: '2026-10-01', debit: 1448360, cashCredit: 210290, marginCredit: 212890 });
    expect(m[0].marginCredit).toBeNaN();
  });

  test('2010-02 之后缺保证金账户闲置现金 → 抛错,不悄悄少一个月', () => {
    expect(parseFinraMargin(xlsx(HEADS))).toHaveLength(2); // 2009 那行缺 D 列是正常的
    expect(() => parseFinraMargin(xlsx(HEADS, true))).toThrow('2026-10 缺值');
  });

  test('年月被存成 Excel 日期序列号 → 抛错,不悄悄少一个月', () => {
    expect(() => parseFinraMargin(xlsx(HEADS, false, '46296'))).toThrow('认不出年月');
  });

  test('表头改名 → 抛错,不静默取错列', () => {
    expect(() => parseFinraMargin(xlsx([HEADS[0], 'Debit Balances', HEADS[2], HEADS[3]]))).toThrow('表头');
  });
});
