import { describe, expect, test } from 'bun:test';
import { dotDateToIso, parseJgbVixXlsx } from './jpxJgbVix';

describe('dotDateToIso', () => {
  test('YYYY.MM.DD → ISO', () => expect(dotDateToIso('2008.01.15')).toBe('2008-01-15'));
  test('表头/非日期 → null', () => expect(dotDateToIso('Date')).toBeNull());
  test('非法 → null', () => expect(dotDateToIso('2008/1/5')).toBeNull());
});

describe('parseJgbVixXlsx', () => {
  // A 列=共享串索引(日期),B 列=内联数值。ss[0]=Date(表头)、[1]=标题、[2..]=日期串。
  const ss = `<sst><si><t>Date</t></si><si><t>S&amp;P/JPX JGB VIX</t></si>` +
    `<si><t>2017.12.29</t></si><si><t>2018.01.04</t></si><si><t>2018.01.05</t></si></sst>`;
  const sheet =
    `<worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>2.50</v></c></row>` +   // 2017-12-29,since 前
    `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>3.10</v></c></row>` +   // 2018-01-04
    `<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><v>3.22</v></c></row>` +   // 2018-01-05
    `<row r="5"><c r="A5" s="4"/></row>` +                                       // 空行
    `</sheetData></worksheet>`;

  test('解析出日期+值,跳表头,since 过滤,跳空行', () => {
    expect(parseJgbVixXlsx(sheet, ss, '2018-01-01')).toEqual([
      { date: '2018-01-04', value: 3.1 },
      { date: '2018-01-05', value: 3.22 },
    ]);
  });
});
