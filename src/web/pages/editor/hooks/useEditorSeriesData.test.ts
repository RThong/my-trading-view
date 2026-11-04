import { describe, expect, test } from 'bun:test';
import type { RegimeData } from '../../../views/regime/regimeChart.hooks';
import {
  CURVE_SOURCES,
  REGISTRY,
  familyHints,
  libraryIdForYahoo,
  rememberYahooName,
  seriesDef,
  searchSeries,
  vxContractDefs,
  yahooId,
} from '../../../views/chartDoc/registry';
import { asOfValue } from './useCrosshairLegend';
import { calcPoints, commonRange, requestKey, seriesPoints, weekdayOnly } from './useEditorSeriesData';
import { layerUnit, seriesLabel } from '../layerLabel';
import { REGIME_SERIES, isSeriesKey } from '../../../../shared/regimeSeries';

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
const endpoints = { '/api/price/SPY': [{ date: '2026-10-30', open: 750, close: 755.7 }] };
const curves = { real: { series: { '10Y': [{ date: '2026-10-30', value: 1.92 }] } } };
const src = { regime, endpoints, curves };

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

  test('URL + 字段型(25Δ / VRP / 库里序列):按字段取值,取不到的接口 → 空数组', () => {
    const skew = seriesDef('opt:SPY:skew')!;
    expect(skew.source).toEqual({ kind: 'endpoint', url: '/api/options/25delta/SPY?days=3650', field: 'skew' });
    const more = {
      ...endpoints,
      '/api/options/25delta/SPY?days=3650': [{ date: '2026-10-30', callIv: 12, putIv: 17, skew: 5 }],
      '/api/series/VX%3A2026-11-18': null,
    };
    expect(seriesPoints(skew, { ...src, endpoints: more }, '1D')).toEqual([{ time: '2026-10-30', value: 5 }]);
    expect(seriesPoints(seriesDef('db:VX:2026-11-18')!, { ...src, endpoints: more }, '1D')).toEqual([]);
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
    REGISTRY.forEach((d) => {
      if (d.source.kind === 'regime') expect(isSeriesKey(d.source.key)).toBe(true);
    });
  });

  test('改版前的 id 全部还在(ChartDoc / 自动保存的存档引用它们)', () => {
    const legacy = ['SPY', 'qqq', 'GLD', 'IBIT', 'TLT', 'USO', 'btc', 'usd', 'usdjpy', 'vix', 'vxn', 'move', 'skew']
      .concat(['cor1m', 'dgs10', 'jgb10y', 'ust2y', 'ust30y', 'real5y', 'real10y', 'real30y', 'bei5y', 'bei10y'])
      .concat(['tp10Kw', 'hyOas', 'netLiquidity', 'coreCpiYoy', 'ismMfg']);
    expect(legacy.filter((id) => !seriesDef(id))).toEqual([]);
    expect(seriesDef('dgs10')?.source).toEqual({ kind: 'curve', curve: 'treasury', tenor: '10Y' });
  });

  test('regime 序列除了不可画的都进名单', () => {
    const ids = new Set(REGISTRY.map((d) => d.id));
    expect(REGIME_SERIES.filter((k) => !ids.has(k))).toEqual([
      'bojHikeDates',
      'sepMedian',
      'coreCpiRelease',
      'corePceRelease',
    ]);
  });

  test('搜索命中名称 / 别名,不区分大小写', () => {
    expect(searchSeries('dxy').map((d) => d.id)).toEqual(['usd']);
    expect(searchSeries('us10y').map((d) => d.id)).toEqual(['dgs10']);
    expect(searchSeries('比特币').map((d) => d.id)).toEqual(expect.arrayContaining(['IBIT', 'btc', 'btcSharpe1y']));
  });

  test('同族序列默认收起:不打字只列常显的那几条,打了关键字才列出来', () => {
    const ids = (q: string, extra = []) => searchSeries(q, extra).map((d) => d.id);
    expect(ids('')).toContain('opt:SPY:skew');
    expect(ids('')).not.toContain('opt:QQQ:skew');
    expect(ids('')).toContain('vrp:SPY:vrp');
    expect(ids('')).not.toContain('vrp:TLT:rv');
    expect(ids('qqq 25')).toEqual(['opt:QQQ:putIv', 'opt:QQQ:callIv', 'opt:QQQ:skew']);
    expect(ids('tlt vrp')).toEqual(['vrp:TLT:vrp']);
    // 曲线各期限、各家财报同理:默认只留常用的几档
    expect(ids('')).toEqual(expect.arrayContaining(['ust2y', 'dgs10', 'real10y', 'ois:12M', 'fund:buyerFcf']));
    expect(ids('')).not.toContain('ust5y');
    expect(ids('')).not.toContain('fund:NVDA:gm');
    expect(ids('美债 5Y')).toEqual(['ust5y']);
    expect(ids('ois 3m')).toEqual(['ois:3M']);
  });

  test('VX 单月合约:按月份代码(VXZ26 / VXZ2026)或日期搜,光打 vx 只给连续合约', () => {
    const contracts = vxContractDefs(['VX:2026-11-18', 'VX:2026-12-16']);
    expect(seriesDef('db:VX:2026-12-16')?.code).toBe('VXZ26');
    const ids = (q: string) => searchSeries(q, contracts).map((d) => d.id);
    expect(ids('vxz26')).toEqual(['db:VX:2026-12-16']);
    expect(ids('VXZ2026')).toEqual(['db:VX:2026-12-16']);
    expect(ids('vx 2026-1')).toEqual(['db:VX:2026-12-16', 'db:VX:2026-11-18']);
    expect(ids('vx').filter((id) => id.startsWith('db:VX:'))).toEqual([]);
    expect(familyHints('', contracts)['VX 合约']).toContain('单月合约 2 份');
  });

  test('VX 单月合约不在静态表里,按 id 现生成定义', () => {
    expect(seriesDef('db:VX:2026-11-18')).toMatchObject({
      label: 'VX 2026-11-18 到期',
      category: 'VX 合约',
      source: { kind: 'endpoint', url: '/api/series/VX%3A2026-11-18', field: 'value' },
    });
    expect(seriesDef('db:NOPE')).toBeUndefined();
  });

  test('各曲线族、期权、基本面都有登记', () => {
    const kinds = new Set(REGISTRY.flatMap((d) => (d.source.kind === 'curve' ? [d.source.curve] : [])));
    expect([...kinds].sort()).toEqual([...CURVE_SOURCES].sort());
    expect(seriesDef('cds:Oracle')?.unit).toBe('bp');
    expect(seriesDef('vrp:BTC:vrp')?.weekends).toBe(true);
    expect(seriesDef('fund:NVDA:fcf')?.unit).toBe('百万美元');
  });

  test('库里已有的 Yahoo 代码对到库里那条', () => {
    expect(libraryIdForYahoo('spy')).toBe('SPY');
    expect(libraryIdForYahoo('^VIX')).toBe('vix');
    expect(libraryIdForYahoo('DX-Y.NYB')).toBe('usd');
    expect(libraryIdForYahoo('^GVZ')).toBe('db:GVZ');
    expect(libraryIdForYahoo('^VIX6M')).toBe('vix6m');
    expect(libraryIdForYahoo('AAPL')).toBeUndefined();
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

describe('计算图层', () => {
  // 两条日线 + 一条月频(月频那条的日期是月初,落在 2026-10-01)
  const daily = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));
  const data = {
    regime: {
      series: {
        usjp2y: daily([
          ['2026-10-01', 3.5],
          ['2026-10-05', 3.0],
        ]),
        coreCpiYoy: daily([['2026-10-01', 2.0]]),
        vix: daily([
          ['2026-10-01', 0],
          ['2026-10-02', 20],
        ]),
      },
      unavailable: [],
    } as RegimeData,
    curves: {},
  };
  const def = (id: string) => seriesDef(id)!;

  test('相减:以点少的那条为准,另一条取当天或之前最近的值', () => {
    // 两条点数相同 → 以 A(usjp2y:10-01、10-05)为准;10-05 那天 vix 没点,取 10-02 的 20(3 天前,不算太旧)
    expect(calcPoints(def('usjp2y'), '-', def('vix'), data, '1D')).toEqual([
      { time: '2026-10-01', value: 3.5 },
      { time: '2026-10-05', value: -17 },
    ]);
  });

  test('日频 ÷ 月频:对齐到月频那条的日期;除数为 0 的那天跳过', () => {
    expect(calcPoints(def('usjp2y'), '/', def('coreCpiYoy'), data, '1D')).toEqual([
      { time: '2026-10-01', value: 1.75 },
    ]);
    expect(calcPoints(def('usjp2y'), '/', def('vix'), data, '1D')).toEqual([{ time: '2026-10-05', value: 0.15 }]);
  });

  test('请求键区分计算与否、运算与第二条序列', () => {
    const keys = [
      { series: 'dgs10', shift: 0 },
      { series: 'dgs10', calc: { op: '-' as const, series: 'ust2y' }, shift: 0 },
      { series: 'dgs10', calc: { op: '/' as const, series: 'ust2y' }, shift: 0 },
      { series: 'dgs10', calc: { op: '-' as const, series: 'ust2y' }, shift: 3, daily: true as const },
    ].map(requestKey);
    expect(new Set(keys).size).toBe(4);
  });

  test('名称与单位:% − % 是百分点,比值没有单位,单位不同的相减也没有单位', () => {
    expect(seriesLabel('dgs10', { op: '-', series: 'ust2y' })).toBe('美债 10Y − 美债 2Y');
    expect(seriesLabel('vixeq', { op: '/', series: 'vix' })).toBe('VIXEQ 成分股波动率 ÷ VIX');
    const layer = (calc?: { op: '-' | '/'; series: string }) => ({
      id: 'l1',
      series: 'dgs10',
      scale: 'right',
      color: '#111111',
      ...(calc && { calc }),
    });
    expect(layerUnit(layer())).toBe('%');
    expect(layerUnit(layer({ op: '-', series: 'ust2y' }))).toBe('pp');
    expect(layerUnit(layer({ op: '/', series: 'ust2y' }))).toBeUndefined();
    expect(layerUnit(layer({ op: '-', series: 'vix' }))).toBeUndefined();
  });
});
