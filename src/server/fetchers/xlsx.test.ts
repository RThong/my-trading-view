import { describe, expect, test } from 'bun:test';
import { resolveSheetPath, parseSharedStrings } from './xlsx';

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

describe('parseSharedStrings', () => {
  test('按 <si> 顺序给出下标表', () =>
    expect(parseSharedStrings('<sst><si><t>%</t></si><si><t>Output gap</t></si></sst>')).toEqual(['%', 'Output gap']));

  // 日银表的真实形状:注音 <rPh> 里也是 <t>。不剥的话读成「需給ギャップジュキュウ」,
  // 按表头名匹配列就会对不上 —— 而且不报错,只是那一列永远找不到。
  test('剥掉注音 rPh,只留正文', () =>
    expect(
      parseSharedStrings('<sst><si><t>需給ギャップ</t><rPh sb="0" eb="2"><t>ジュキュウ</t></rPh></si></sst>'),
    ).toEqual(['需給ギャップ']));

  test('富文本多段 <t> 拼接', () =>
    expect(parseSharedStrings('<sst><si><r><t>Output </t></r><r><t>gap</t></r></si></sst>')).toEqual(['Output gap']));
});
