import { describe, expect, it } from 'bun:test';
import { tenorSeriesData, pickDefaultTenors, DEFAULT_TENORS, spotBars, spotVolume } from './tenorHistory.hooks';

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
  // 美债 / JGB 默认只开差值那两条腿(见 DEFAULT_TENORS 的注释)。两格都断言,免得只改一边。
  it('treasury 默认只开 10Y−1Y 的两条腿', () =>
    expect(pickDefaultTenors('treasury', available)).toEqual(['1Y', '10Y']));
  it('jgb 默认同样只开这两条腿(与美债口径一致)', () =>
    expect(pickDefaultTenors('jgb', ['1Y', '2Y', '5Y', '10Y', '30Y'])).toEqual(['1Y', '10Y']));
  it('表里有但数据没有的期限被剔除', () => expect(pickDefaultTenors('sofr_ois', ['3M', '10Y'])).toEqual(['3M', '10Y']));
  it('无表项 → 回退前 4 个', () => expect(pickDefaultTenors('unknown', available)).toEqual(['1M', '3M', '6M', '1Y']));
  it('DEFAULT_TENORS 含 treasury / sofr_ois / bei / jgb / ai_cds', () =>
    expect(Object.keys(DEFAULT_TENORS).sort()).toEqual(['ai_cds', 'bei', 'jgb', 'sofr_ois', 'treasury']));
  it('sofr_ois 默认用 12M 而非 1Y,对齐 OIS 真实档位', () => {
    const oisTenors = ['1D', '1W', '1M', '3M', '6M', '9M', '12M', '18M', '2Y', '3Y', '5Y', '10Y', '30Y'];
    expect(pickDefaultTenors('sofr_ois', oisTenors)).toEqual(['1M', '3M', '6M', '12M', '2Y', '10Y']);
  });
  it('bei 默认勾选 5Y/10Y/30Y 锚点', () =>
    expect(pickDefaultTenors('bei', ['5Y', '7Y', '10Y', '20Y', '30Y'])).toEqual(['5Y', '10Y', '30Y']));
});

// 成交量必须和蜡烛**逐根对齐且总量守恒** —— 错位或漏加不会报错,只会让某根 K 线的量价讲两件事。
it('spotVolume:按蜡烛周期聚合,逐根对齐且总量守恒', () => {
  const rows = [
    { date: '2026-08-03', open: 10, high: 10, low: 10, close: 10, volume: 1 }, // 周一
    { date: '2026-08-04', open: 11, high: 11, low: 11, close: 11, volume: 2 },
    { date: '2026-08-07', open: 12, high: 12, low: 12, close: 12, volume: 4 }, // 周五
    { date: '2026-08-10', open: 13, high: 13, low: 13, close: 13, volume: 8 }, // 次周一
  ];
  const candles = spotBars(rows, '1W');
  const vol = spotVolume(rows, candles, '1W');

  expect(vol).toHaveLength(candles.length); // 逐根对齐
  expect(vol.map((v) => v.time)).toEqual(candles.map((c) => c.time)); // 时间键一致
  expect(vol.reduce((s, v) => s + v.value, 0)).toBe(15); // 1+2+4+8,守恒
  expect(vol[0]!.value).toBe(7); // 第一周 1+2+4
});

it('spotVolume:源没有量 → 空数组(调用方据此不建这条线)', () => {
  const rows = [
    { date: '2026-08-03', open: 10, high: 10, low: 10, close: 10 },
    { date: '2026-08-04', open: 11, high: 11, low: 11, close: 11 },
  ];
  expect(spotVolume(rows, spotBars(rows, '1D'), '1D')).toEqual([]);
  // 只有 null 也算没有 —— 加 volume 列之前的历史行就是这个形态。
  const nulls = [{ date: '2026-08-03', open: 10, high: 10, low: 10, close: 10, volume: null }];
  expect(spotVolume(nulls, spotBars(nulls, '1D'), '1D')).toEqual([]);
});
