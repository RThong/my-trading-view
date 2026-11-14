import { describe, expect, test } from 'bun:test';
import { parseKcPrs } from './kcFedPrs';

describe('parseKcPrs', () => {
  test('取 KCPRS 列,日期补零,升序', () => {
    const csv = 'Year,Month,Day,KCPRU,KCPRS\n2026,11,12,1.45,-0.101\n1989,4,3,1.598,0.313\n';
    expect(parseKcPrs(csv)).toEqual([
      { date: '1989-04-03', value: 0.313 },
      { date: '2026-11-12', value: -0.101 },
    ]);
  });

  test('表头变了(含 BOM / 列序)→ 抛错', () => {
    expect(() => parseKcPrs('Year,Month,Day,KCPRS,KCPRU\n2026,11,12,-0.1,1.4')).toThrow('表头变了');
    expect(() => parseKcPrs('﻿Year,Month,Day,KCPRU,KCPRS\n2026,11,12,1.4,-0.1')).toThrow('表头变了');
  });

  test('坏行:缺值 / 缺 KCPRU / 多列 / 非法日期 → 抛错', () => {
    const bad = [
      '2026,11,12,1.45,',
      '2026,11,12,,-0.1',
      '2026,11,12,1.45,-0.1,9',
      '2026,13,99,1.45,-0.1',
      '2026,11,12,1.45,1e3',
    ];
    bad.forEach((row) => {
      expect(() => parseKcPrs(`Year,Month,Day,KCPRU,KCPRS\n${row}`)).toThrow('坏行');
    });
  });
});
