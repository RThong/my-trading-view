import { describe, expect, test } from 'bun:test';
import type { RegimeData } from '../regime/regimeChart.hooks';
import { REGISTRY, rememberYahooName, seriesDef, searchSeries, yahooId } from './registry';
import { asOfValue } from './useCrosshairLegend';
import { commonRange, seriesPoints, weekdayOnly } from './useEditorSeriesData';
import { REGIME_SERIES } from '../../../shared/regimeSeries';

const regime: RegimeData = {
  series: {
    vix: [
      { date: '2026-10-30', value: 19.4 },
      { date: '2026-10-29', value: Number.NaN },
    ],
  },
  unavailable: [],
  ohlc: {
    btc: [
      { time: '2026-10-30', open: 1, high: 1, low: 1, close: 100 }, // 周五
      { time: '2026-10-31', open: 1, high: 1, low: 1, close: 101 }, // 周六
      { time: '2026-11-01', open: 1, high: 1, low: 1, close: 102 }, // 周日
      { time: '2026-11-02', open: 1, high: 1, low: 1, close: 103 }, // 周一
    ],
  },
};
const prices = { SPY: [{ date: '2026-10-30', close: 755.7 }] };
const curves = { real: { series: { '10Y': [{ date: '2026-10-30', value: 1.92 }] } } };
const src = { regime, prices, curves };

describe('seriesPoints', () => {
  test('regime 序列:统一成 {time,value},丢掉非有限值', () => {
    expect(seriesPoints(seriesDef('vix')!, src, '1D')).toEqual([{ time: '2026-10-30', value: 19.4 }]);
  });

  test('BTC 走 ohlc 收盘,并去掉周末', () => {
    expect(seriesPoints(seriesDef('btc')!, src, '1D').map((p) => p.time)).toEqual(['2026-10-30', '2026-11-02']);
  });

  test('price 源取收盘', () => {
    expect(seriesPoints(seriesDef('SPY')!, src, '1D')).toEqual([{ time: '2026-10-30', value: 755.7 }]);
  });

  test('收益曲线源取对应期限', () => {
    expect(seriesPoints(seriesDef('real10y')!, src, '1D')).toEqual([{ time: '2026-10-30', value: 1.92 }]);
    expect(seriesPoints(seriesDef('real5y')!, src, '1D')).toEqual([]);
  });

  test('Yahoo 任意代码:动态定义;含大量周末点的(加密)自动去周末', () => {
    rememberYahooName('BTC-USD', 'Bitcoin USD');
    const def = seriesDef(yahooId('btc-usd'))!;
    expect(def).toMatchObject({
      id: 'yh:BTC-USD',
      label: 'BTC-USD Bitcoin USD',
      source: { kind: 'yahoo', symbol: 'BTC-USD' },
    });
    const yahoo = {
      'BTC-USD': {
        symbol: 'BTC-USD',
        name: 'Bitcoin USD',
        points: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((date, i) => ({ date, close: 100 + i })),
      },
      'GC=F': { symbol: 'GC=F', name: 'Gold', points: [{ date: '2026-10-30', close: 3900 }] },
    };
    expect(seriesPoints(def, { ...src, yahoo }, '1D').map((p) => p.time)).toEqual(['2026-10-30', '2026-11-02']);
    expect(seriesPoints(seriesDef('yh:GC=F')!, { ...src, yahoo }, '1D')).toEqual([{ time: '2026-10-30', value: 3900 }]);
    // 没记到名字就只显示代码
    expect(seriesDef('yh:ZZZ')!.label).toBe('ZZZ');
  });

  test('源里没有 → 空数组', () => {
    expect(seriesPoints(seriesDef('dgs10')!, src, '1D')).toEqual([]);
  });

  test('按周期聚合(周线取周内最后一点,键为周一)', () => {
    expect(seriesPoints(seriesDef('btc')!, src, '1W')).toEqual([
      { time: '2026-10-26', value: 100 },
      { time: '2026-11-02', value: 103 },
    ]);
  });
});

test('weekdayOnly 保留周一~周五', () => {
  const pts = ['2026-10-30', '2026-10-31', '2026-11-01'].map((time) => ({ time, value: 1 }));
  expect(weekdayOnly(pts).map((p) => p.time)).toEqual(['2026-10-30']);
});

describe('registry', () => {
  test('id 唯一;regime 源的 key 都是后端真实对外名', () => {
    expect(new Set(REGISTRY.map((d) => d.id)).size).toBe(REGISTRY.length);
    const names: ReadonlySet<string> = new Set(REGIME_SERIES);
    REGISTRY.forEach((d) => {
      if (d.source.kind === 'regime') expect(names.has(d.source.key)).toBe(true);
    });
  });

  test('搜索命中名称 / 别名,不区分大小写', () => {
    expect(searchSeries('dxy').map((d) => d.id)).toEqual(['usd']);
    expect(searchSeries('比特币').map((d) => d.id)).toEqual(['IBIT', 'btc']);
    expect(searchSeries('  ')).toBe(REGISTRY);
  });
});

describe('asOfValue', () => {
  const pts = [
    { time: '2026-09-01', value: 1 },
    { time: '2026-10-01', value: 2 },
  ];
  test('取当天或之前最近一点', () => {
    expect(asOfValue(pts, '2026-09-15')).toBe(1);
    expect(asOfValue(pts, '2026-10-01')).toBe(2);
    expect(asOfValue(pts, '2026-08-31')).toBeUndefined();
  });
  test('null = 最新值;空序列 = undefined', () => {
    expect(asOfValue(pts, null)).toBe(2);
    expect(asOfValue([], null)).toBeUndefined();
  });
});

describe('commonRange', () => {
  const pts = (...times: string[]) => times.map((time) => ({ time, value: 1 }));
  test('起点取最晚的起点、终点取最晚的终点', () => {
    expect(commonRange([pts('1993-01-29', '2026-10-30'), pts('2018-01-02', '2026-10-29')])).toEqual({
      from: '2018-01-02',
      to: '2026-10-30',
    });
  });
  test('忽略空序列;全空或交集为空 → null', () => {
    expect(commonRange([pts('2020-01-01', '2021-01-01'), []])).toEqual({ from: '2020-01-01', to: '2021-01-01' });
    expect(commonRange([[], []])).toBeNull();
    expect(commonRange([pts('2020-01-01'), pts('2020-01-01')])).toBeNull();
  });
});
