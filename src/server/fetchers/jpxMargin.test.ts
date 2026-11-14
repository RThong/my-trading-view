import { describe, expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { mergeWeeks, parseMtskXls, parseRecentXlsx, parseWeeklyXlsx } from './jpxMargin';

// 用 SheetJS 按真实文件的版式(2026-11 实测)生成最小样本:只填被核对的表头格和取值格
function book(rows: unknown[][], bookType: XLSX.BookType): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  return XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer;
}
// 稀疏地放格子:[[行, 列, 值], …] → 二维数组
function grid(cells: [number, number, unknown][]): unknown[][] {
  const rows: unknown[][] = [];
  cells.forEach(([r, c, v]) => {
    rows[r] ??= [];
    rows[r][c] = v;
  });
  return Array.from(rows, (r) => r ?? []);
}

const HEAD_XLS: [number, number, unknown][] = [
  [3, 9, '合計   　　　Total'],
  [4, 11, '買残高'],
  [6, 12, '金額'],
];
const HEAD_RECENT: [number, number, unknown][] = [
  [3, 13, '合計 Total'],
  [4, 15, '買残高'],
  [6, 16, '金額'],
];

describe('JPX 信用残', () => {
  test('.xls 全历史:Excel 日期序列号 → 周五,取第 12 列合計买残金额', () => {
    const buf = book(
      grid([...HEAD_XLS, [10, 0, 46283], [10, 12, 6455988], [9, 0, '[東京・名古屋 Tokyo & Nagoya]']]),
      'biff8',
    );
    expect(parseMtskXls(buf)).toEqual([{ date: '2026-09-18', value: 6455988 }]);
  });

  test('推移表 .xlsx:取第 16 列;表头错位 → 抛错', () => {
    expect(parseRecentXlsx(book(grid([...HEAD_RECENT, [10, 0, 46325], [10, 16, 6505887]]), 'xlsx'))).toEqual([
      { date: '2026-10-30', value: 6505887 },
    ]);
    const shifted = book(grid([...HEAD_XLS, [10, 0, 46325], [10, 16, 1]]), 'xlsx');
    expect(() => parseRecentXlsx(shifted)).toThrow('表头对不上');
  });

  test('每周 .xlsx:「信用取引残高合計」下一行的金額 × 二市场买残高', () => {
    const buf = book(
      grid([
        [1, 1, 46332],
        [5, 4, '二市場 Tokyo&Nagoya'],
        [6, 6, '買残高・\n融資残高\nPurchases'],
        [13, 1, '信用取引残高合計\nTotal Outstanding Margin Trading'],
        [13, 3, '株数Shs.'],
        [13, 6, 3460691],
        [14, 3, '金額Val.'],
        [14, 6, 5880994],
      ]),
      'xlsx',
    );
    expect(parseWeeklyXlsx(buf)).toEqual({ date: '2026-11-06', value: 5880994 });
  });

  test('拼接:同一周值相同则去重、升序;值不同 → 抛错', () => {
    const a = { date: '2026-10-30', value: 6505887 };
    expect(mergeWeeks([[{ date: '2026-11-06', value: 5880994 }, a], [a]])).toEqual([
      a,
      { date: '2026-11-06', value: 5880994 },
    ]);
    expect(() => mergeWeeks([[a], [{ ...a, value: 1 }]])).toThrow('各文件数值不一致');
  });

  test('交接处:相隔 ≤ 15 天(含黄金周那种 14 天)放行,超过 → 抛错', () => {
    const w = (date: string) => ({ date, value: 1 });
    expect(mergeWeeks([[w('2022-04-28')], [w('2022-05-13')]])).toHaveLength(2);
    expect(() => mergeWeeks([[w('2026-09-18')], [w('2026-10-02')], [w('2026-10-30')]])).toThrow(
      '交接处断档 2026-10-02 → 2026-10-30',
    );
  });

  test('买残金额不是数字 → 抛错', () => {
    const buf = book(grid([...HEAD_XLS, [10, 0, 46283], [10, 12, '-']]), 'biff8');
    expect(() => parseMtskXls(buf)).toThrow('不是数字');
  });
});
