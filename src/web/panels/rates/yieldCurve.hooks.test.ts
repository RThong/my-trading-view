import { describe, expect, it } from 'bun:test';
import { valueAt, curveForDate, unionDatesAsc, snapToTradingDay, shiftDate, presetDates } from './yieldCurve.hooks';

// 收益率有周末/假日缺口,取值一律"往前贴到 ≤ 目标的最近观测"。
const series = {
  '3M': [
    { date: '2026-06-30', value: 3.7 },
    { date: '2026-07-01', value: 3.75 },
    { date: '2026-07-02', value: 3.76 },
  ],
  '2Y': [
    { date: '2026-06-30', value: 4.1 },
    { date: '2026-07-02', value: 4.14 },
  ], // 缺 07-01
  '10Y': [{ date: '2026-07-02', value: 4.49 }],
};

describe('valueAt: 就近往前贴', () => {
  it('命中当天取当天', () => expect(valueAt(series['3M'], '2026-07-01')).toBe(3.75));
  it('目标是周末/假日 → 取前一个观测', () => expect(valueAt(series['2Y'], '2026-07-01')).toBe(4.1));
  it('早于所有观测 → null', () => expect(valueAt(series['10Y'], '2026-06-30')).toBeNull());
  it('晚于所有观测 → 取最后一个', () => expect(valueAt(series['3M'], '2026-12-31')).toBe(3.76));
  it('序列缺失 → null', () => expect(valueAt(undefined, '2026-07-01')).toBeNull());
});

describe('curveForDate: 一条曲线', () => {
  const tenors = ['3M', '2Y', '10Y'];
  it('07-02 各期限齐全', () => expect(curveForDate(series, tenors, '2026-07-02')).toEqual([3.76, 4.14, 4.49]));
  it('07-01 缺该日的期限往前贴或断开', () =>
    expect(curveForDate(series, tenors, '2026-07-01')).toEqual([3.75, 4.1, null]));
});

describe('unionDatesAsc', () => {
  it('并集去重升序', () => expect(unionDatesAsc(series)).toEqual(['2026-06-30', '2026-07-01', '2026-07-02']));
});

describe('snapToTradingDay', () => {
  const dates = ['2026-06-30', '2026-07-01', '2026-07-02'];
  it('贴到 ≤ 目标的最近交易日', () => expect(snapToTradingDay(dates, '2026-07-04')).toBe('2026-07-02'));
  it('无更早交易日 → null', () => expect(snapToTradingDay(dates, '2026-06-01')).toBeNull());
});

describe('shiftDate: 往前推', () => {
  it('减天', () => expect(shiftDate('2026-07-05', { days: 7 })).toBe('2026-06-28'));
  it('减月', () => expect(shiftDate('2026-07-05', { months: 1 })).toBe('2026-06-05'));
  it('减年', () => expect(shiftDate('2026-07-05', { years: 1 })).toBe('2025-07-05'));
  it('月末减月不溢出(3-31 减 1 月 → 2 月底)', () => expect(shiftDate('2026-03-31', { months: 1 })).toBe('2026-02-28'));
  it('闰日减年不溢出(2-29 减 1 年 → 2-28)', () => expect(shiftDate('2024-02-29', { years: 1 })).toBe('2023-02-28'));
});

describe('presetDates: 最近 3 个交易日 + 长端贴到交易日', () => {
  // 每个长端预置各自贴到不同的一天(否则会被同日去重合并)
  const dates = ['2025-07-01', '2025-12-31', '2026-06-01', '2026-06-25', '2026-06-30', '2026-07-01', '2026-07-02'];
  const presets = presetDates('2026-07-02', dates);
  it('短端 = 数据里最近 3 个交易日,不按日历', () => {
    expect(presets.slice(0, 3)).toEqual([
      { label: '最新', date: '2026-07-02' },
      { label: '前1日', date: '2026-07-01' },
      { label: '前2日', date: '2026-06-30' },
    ]);
  });
  it('一年前 贴到最近交易日', () => expect(presets.find((p) => p.label === '一年前')!.date).toBe('2025-07-01'));
  it('周一:短端往前数交易日,不会两条重复(旧口径昨天/前天 都贴到上周五)', () => {
    const mon = presetDates('2026-07-27', ['2026-07-20', '2026-07-24', '2026-07-27']);
    expect(mon).toEqual([
      { label: '最新', date: '2026-07-27' },
      { label: '前1日', date: '2026-07-24' },
      { label: '前2日', date: '2026-07-20' },
    ]);
  });
  it('数据不够的预置被丢弃(不产出空曲线)', () => {
    const only = presetDates('2026-07-02', ['2026-07-02']); // 只有一天,往前的都没有
    expect(only.map((p) => p.label)).toEqual(['最新']);
  });
});
