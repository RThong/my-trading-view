import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { parseFinraMargin } from './finraMargin';

const HEADS = [
  'Year-Month',
  "Debit Balances in Customers' Securities Margin Accounts",
  "Free Credit Balances in Customers' Cash Accounts",
  "Free Credit Balances in Customers' Securities Margin Accounts",
];

// 最小 xlsx:表头走共享字符串,数据是数字格;最新在上(同源文件),末尾一行全空。
// opts.latestYm:给最新一行的年月格塞一个数字(模拟被 Excel 存成日期序列号);
// opts.latestB2:替换最新一行的借方格(整段 <c> XML);opts.noDebit:所有数据行都不写借方
function xlsx(heads: string[], opts: { latestYm?: string; latestB2?: string; noDebit?: true } = {}): ArrayBuffer {
  const shared = [...heads, '2026-10', '2009-12'];
  const s = (i: number) => `t="s"><v>${i}</v>`;
  const a2 = opts.latestYm ? `<c r="A2"><v>${opts.latestYm}</v></c>` : `<c r="A2" ${s(4)}</c>`;
  const b2 = opts.noDebit ? '' : (opts.latestB2 ?? '<c r="B2"><v>1448360</v></c>');
  const b3 = opts.noDebit ? '' : '<c r="B3"><v>200000</v></c>';
  const sheet =
    '<worksheet><sheetData>' +
    `<row r="1">${heads.map((_, i) => `<c r="${'ABCD'[i]}1" ${s(i)}</c>`).join('')}</row>` +
    `<row r="2">${a2}${b2}<c r="C2"><v>210290</v></c><c r="D2"><v>212890</v></c></row>` +
    `<row r="3"><c r="A3" ${s(5)}</c>${b3}<c r="C3"><v>100000</v></c></row>` +
    '<row r="4"></row>' +
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
  test('按表头名取借方列,升序,月记当月 1 日;全空行跳过', () => {
    expect(parseFinraMargin(xlsx(HEADS))).toEqual([
      { date: '2009-12-01', debit: 200000 },
      { date: '2026-10-01', debit: 1448360 },
    ]);
  });

  test('年月被存成 Excel 日期序列号 → 抛错,不悄悄少一个月', () => {
    expect(() => parseFinraMargin(xlsx(HEADS, { latestYm: '46296' }))).toThrow('认不出年月');
  });

  test('借方变成文本(共享字符串或行内字符串)→ 抛错,不当成空格子跳过', () => {
    const inline = '<c r="B2" t="inlineStr"><is><t>n/a</t></is></c>';
    expect(() => parseFinraMargin(xlsx(HEADS, { latestB2: inline }))).toThrow('借方不是数字');
    // 共享字符串下标 0 = 表头 'Year-Month',同样不是数字
    expect(() => parseFinraMargin(xlsx(HEADS, { latestB2: '<c r="B2" t="s"><v>0</v></c>' }))).toThrow('借方不是数字');
  });

  test('借方整列为空 → 抛错', () => {
    expect(() => parseFinraMargin(xlsx(HEADS, { noDebit: true }))).toThrow('一行数据都没解析出来');
  });

  test('表头改名 → 抛错,不静默取错列', () => {
    expect(() => parseFinraMargin(xlsx([HEADS[0], 'Debit Balances', HEADS[2], HEADS[3]]))).toThrow('表头');
  });
});
