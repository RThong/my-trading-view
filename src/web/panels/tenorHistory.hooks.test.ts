import { describe, expect, it } from 'bun:test';
import { tenorSeriesData, pickDefaultTenors, DEFAULT_TENORS } from './tenorHistory.hooks';

const rows = [
  { date: '2026-06-01', value: 4.0 },
  { date: '2026-06-15', value: 4.2 },
  { date: '2026-07-02', value: 4.5 },
];

describe('tenorSeriesData', () => {
  it('1D 原样映射 date→time', () =>
    expect(tenorSeriesData(rows, '1D')).toEqual([
      { time: '2026-06-01', value: 4.0 },
      { time: '2026-06-15', value: 4.2 },
      { time: '2026-07-02', value: 4.5 },
    ]));

  it('1M 按月聚合,月内取最后一点', () =>
    expect(tenorSeriesData(rows, '1M')).toEqual([
      { time: '2026-06-01', value: 4.2 }, // 6 月两点取后者
      { time: '2026-07-01', value: 4.5 },
    ]));

  it('序列缺失 → 空数组', () => expect(tenorSeriesData(undefined, '1D')).toEqual([]));
});

describe('pickDefaultTenors', () => {
  const available = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'];
  it('treasury 用表并过滤到可用期限', () =>
    expect(pickDefaultTenors('treasury', available)).toEqual(['3M', '1Y', '2Y', '5Y', '10Y', '30Y']));
  it('表里有但数据没有的期限被剔除', () =>
    expect(pickDefaultTenors('sofr_ois', ['3M', '10Y'])).toEqual(['3M', '10Y']));
  it('无表项 → 回退前 4 个', () =>
    expect(pickDefaultTenors('unknown', available)).toEqual(['1M', '3M', '6M', '1Y']));
  it('DEFAULT_TENORS 含 treasury 与 sofr_ois', () =>
    expect(Object.keys(DEFAULT_TENORS).sort()).toEqual(['sofr_ois', 'treasury']));
  it('sofr_ois 默认用 12M 而非 1Y,对齐 OIS 真实档位', () => {
    const oisTenors = ['1D', '1W', '1M', '3M', '6M', '9M', '12M', '18M', '2Y', '3Y', '5Y', '10Y', '30Y'];
    expect(pickDefaultTenors('sofr_ois', oisTenors)).toEqual(['1M', '3M', '6M', '12M', '2Y', '10Y']);
  });
});
