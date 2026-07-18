import { describe, expect, it } from 'bun:test';
import { parseMofJgbCsv } from './mofJgb';

describe('parseMofJgbCsv', () => {
  const SAMPLE =
    '﻿Interest Rate,,,(Unit : %)\nDate,1Y,2Y,10Y\n2017/12/29,0.1,-,0.05\n2018/1/4,0.11,0.2,0.06\n2026/6/30,1.165,1.382,2.69';
  it('取 tenors、日期补零、since 过滤、跳过 -', () => {
    const { tenors, series } = parseMofJgbCsv(SAMPLE, '2018-01-01');
    expect(tenors).toEqual(['1Y', '2Y', '10Y']);
    expect(series['1Y'].map((p) => p.date)).toEqual(['2018-01-04', '2026-06-30']); // 2017 行被 since 滤掉
    expect(series['1Y'][0]).toEqual({ date: '2018-01-04', value: 0.11 });
    expect(series['10Y'].at(-1)).toEqual({ date: '2026-06-30', value: 2.69 });
  });
  it('缺值 - 不入序列', () => {
    const csv = 'Date,2Y,10Y\n2020/1/6,-,0.01\n2020/1/7,0.15,0.02';
    const { series } = parseMofJgbCsv(csv, '2018-01-01');
    expect(series['2Y']).toEqual([{ date: '2020-01-07', value: 0.15 }]);
    expect(series['10Y'].length).toBe(2);
  });
});
