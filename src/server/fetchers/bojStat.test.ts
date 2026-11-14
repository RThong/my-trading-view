import { describe, expect, test } from 'bun:test';
import { bojDateToIso, bojQuarterToIso, parseBojCsv } from './bojStat';

// 真实响应的形状(截取):元数据行 + 表头 + 数据行;名称列带逗号、缺值是字面量 null。
const CSV = [
  'STATUS,200',
  'MESSAGEID,M181000I',
  'MESSAGE,Successfully completed',
  'DATE,2026-09-27T16:47:33.253+09:00',
  'PARAMETER,DB,FM01',
  'NEXTPOSITION,',
  'SERIES_CODE,NAME_OF_TIME_SERIES,UNIT,FREQUENCY,CATEGORY,LAST_UPDATE,SURVEY_DATES,VALUES',
  'STRDCLUCON,"Call Rate, Uncollateralized Overnight, Average (Daily)",percent per annum,DAILY,Call Rate,20260925,20260918,0.977',
  'STRDCLUCON,"Call Rate, Uncollateralized Overnight, Average (Daily)",percent per annum,DAILY,Call Rate,20260925,20260919,null',
  'STRDCLUCON,"Call Rate, Uncollateralized Overnight, Average (Daily)",percent per annum,DAILY,Call Rate,20260925,20260917,0.976',
].join('\n');

describe('bojDateToIso', () => {
  test('月频 → 当月 1 日,日频原样', () => {
    expect(bojDateToIso('202609')).toBe('2026-09-01');
    expect(bojDateToIso('20260918')).toBe('2026-09-18');
    expect(bojDateToIso('SURVEY_DATES')).toBeNull();
  });
});

describe('parseBojCsv', () => {
  test('跳过元数据与 null,名称列里的逗号不影响取值,输出升序', () => {
    expect(parseBojCsv(CSV, ['STRDCLUCON'])).toEqual({
      STRDCLUCON: [
        { date: '2026-09-17', value: 0.976 },
        { date: '2026-09-18', value: 0.977 },
      ],
    });
  });

  test('请求的代码一行都没有 → 抛错,不静默成空序列', () => {
    expect(() => parseBojCsv(CSV, ['STRDCLUCON', 'DLDR121N'])).toThrow('DLDR121N');
  });

  test('NEXTPOSITION 非空 = 被分页截断 → 抛错', () => {
    expect(() => parseBojCsv(CSV.replace('NEXTPOSITION,', 'NEXTPOSITION,250'), ['STRDCLUCON'])).toThrow('分页');
  });
});

describe('季频(短観 YYYYQQ)', () => {
  test('季号 01~04 → 季末;越界 / 月份形状不当成季度', () => {
    expect(bojQuarterToIso('202602')).toBe('2026-06-30');
    expect(bojQuarterToIso('201401')).toBe('2014-03-31');
    expect(bojQuarterToIso('202606')).toBeNull();
  });

  test('quarterly 时按季解析(同为 6 位,不能当月份)', () => {
    const csv = [
      'NEXTPOSITION,',
      'TK99F0000204HCQ00000,"Firms\' price expectations, 1 year",%,QUARTERLY,,20261001,202603,2.6',
    ].join('\n');
    expect(parseBojCsv(csv, ['TK99F0000204HCQ00000'], true)).toEqual({
      TK99F0000204HCQ00000: [{ date: '2026-09-30', value: 2.6 }],
    });
  });
});
