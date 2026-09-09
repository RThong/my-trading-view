import { describe, expect, test } from 'bun:test';
import { excelSerialToIso, parseHlwSheet, resolveSheetPath } from './nyfedRstar';

describe('excelSerialToIso', () => {
  // 官方文件的末点(实测 2026-09-09):序列 46113,官方标为 2026Q2 → 季度首日。
  test('季度首日序列 → ISO', () => expect(excelSerialToIso(46113)).toBe('2026-04-01'));
  test('1961Q1 起点', () => expect(excelSerialToIso(22282)).toBe('1961-01-01'));
  test('非法 → null', () => expect(excelSerialToIso(Number.NaN)).toBeNull());
});

describe('parseHlwSheet', () => {
  // A 列=内联数值(Excel 序列日),K 列=美国 r*。表头行的 A 列是共享字符串(t="s"),靠这个被滤掉。
  // C/G/O 列是别的指标块(g / z / 产出缺口),必须不被当成 r* —— 故每行都放上干扰值。
  const sheet =
    `<worksheet><sheetData>` +
    `<row r="6"><c r="A6" t="s"><v>42</v></c><c r="B6" t="s"><v>43</v></c><c r="K6" t="s"><v>43</v></c></row>` +
    // 2017-10-01:since 前,应被过滤
    `<row r="7"><c r="A7"><v>43009</v></c><c r="C7"><v>1.11</v></c><c r="K7"><v>0.55</v></c></row>` +
    // 2018-01-01
    `<row r="8"><c r="A8"><v>43101</v></c><c r="C8"><v>1.22</v></c><c r="K8"><v>0.71</v></c></row>` +
    // 2018-04-01:负值 + 科学计数法(官方文件里 r* 附近的小数就是这种写法)
    `<row r="9"><c r="A9"><v>43191</v></c><c r="C9"><v>1.33</v></c><c r="K9"><v>-8.5544910456154505E-2</v></c></row>` +
    // r* 缺失(只有别的块有值)→ 整行跳过,不能补 0
    `<row r="10"><c r="A10"><v>43282</v></c><c r="C10"><v>1.44</v></c></row>` +
    `<row r="11"><c r="A11" s="4"/></row>` + // 空行
    `</sheetData></worksheet>`;

  test('取 K 列(美国 r*),跳表头/空行/缺值行,since 过滤', () => {
    expect(parseHlwSheet(sheet, '2018-01-01')).toEqual([
      { date: '2018-01-01', value: 0.71 },
      { date: '2018-04-01', value: -0.085544910456154505 },
    ]);
  });

  test('不会把趋势增长那一块(C 列)当成 r*', () => {
    const vals = parseHlwSheet(sheet, '2018-01-01').map((r) => r.value);
    expect(vals).not.toContain(1.22);
  });
});

describe('resolveSheetPath', () => {
  // 官方文件实测形状(2026-09-09):HLW Estimates 是 rId2 → worksheets/sheet2.xml。
  const workbook =
    `<workbook><sheets>` +
    `<sheet name="Read Me" sheetId="1" r:id="rId1"/>` +
    `<sheet name="HLW Estimates" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`;
  const rels =
    `<Relationships>` +
    `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>` +
    `</Relationships>`;

  test('按名字解到 zip 路径', () =>
    expect(resolveSheetPath(workbook, rels, 'HLW Estimates')).toBe('xl/worksheets/sheet2.xml'));

  // 关键保证:官方在前面插一张表,靠 sheetN 编号会静默取到别的表,按名字解则跟着走。
  test('前面插表后仍跟着名字走', () => {
    const shifted = workbook.replace(
      '<sheet name="Read Me"',
      '<sheet name="Notes" sheetId="9" r:id="rId9"/><sheet name="Read Me"',
    );
    expect(resolveSheetPath(shifted, rels, 'HLW Estimates')).toBe('xl/worksheets/sheet2.xml');
  });

  test('表被改名 → null(上层抛错,不静默取错表)', () =>
    expect(resolveSheetPath(workbook, rels, 'HLW Estimates v2')).toBeNull());

  test('绝对 Target 去掉前导斜杠', () =>
    expect(
      resolveSheetPath(workbook, rels.replace('worksheets/sheet2.xml', '/xl/worksheets/sheet2.xml'), 'HLW Estimates'),
    ).toBe('xl/worksheets/sheet2.xml'));
});
