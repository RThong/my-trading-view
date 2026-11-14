import { describe, expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { parseCiLongSeries } from './cabinetCi';

// 按真实文件版式(2026-11 实测)造样本:第 0 行大类、第 2 行列名,1980 起只有 DI、1985 起才有 CI
const HEAD = [
  [null, null, null, 'ＣＩ指数', 'ＣＩ指数', 'ＣＩ指数'],
  [],
  ['時間軸コード', '西暦年', '月', '先行指数', '一致指数', '遅行指数'],
  [],
  [null, null, null, '(令和2年=100)', '(令和2年=100)', '(令和2年=100)'],
];
function xlsx(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...HEAD, ...rows]), 'S');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('parseCiLongSeries', () => {
  test('跳过 CI 开始前的行,取先行 / 一致,月记当月 1 日', () => {
    const buf = xlsx([
      ['1984001212', 1984, 12, null, null, null],
      ['1985000101', 1985, 1, 84.5, 90.8, 84.5],
      ['1985000202', 1985, 2, 84.9, 91.0, 84.7],
      [],
    ]);
    expect(parseCiLongSeries(buf)).toEqual([
      { date: '1985-01-01', leading: 84.5, coincident: 90.8 },
      { date: '1985-02-01', leading: 84.9, coincident: 91.0 },
    ]);
  });

  test('CI 开始后缺值 / 缺月 → 抛错', () => {
    expect(() =>
      parseCiLongSeries(
        xlsx([
          ['x', 1985, 1, 84.5, 90.8],
          ['x', 1985, 2, null, 91.0],
        ]),
      ),
    ).toThrow('缺值');
    expect(() =>
      parseCiLongSeries(
        xlsx([
          ['x', 1985, 1, 84.5, 90.8],
          ['x', 1985, 3, 84.9, 91.0],
        ]),
      ),
    ).toThrow('不连续');
  });

  test('1985-01 缺值 → 抛错,不从 1985-02 悄悄开始', () => {
    const buf = xlsx([
      ['x', 1985, 1, null, null],
      ['x', 1985, 2, 84.9, 91.0],
    ]);
    expect(() => parseCiLongSeries(buf)).toThrow('首个 CI 月是 1985-2');
  });

  test('表头变了 → 抛错', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([[], [], ['時間軸コード', '西暦年', '月', '一致指数', '先行指数']]),
      'S',
    );
    expect(() => parseCiLongSeries(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)).toThrow(
      '表头对不上',
    );
  });
});
