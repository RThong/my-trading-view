import { describe, expect, test } from 'bun:test';
import { BAND_CALM, BAND_RISK } from '../../chart/palette';
import { normalBand, type ChartDoc, type Layer, type Pane } from './chartDoc';
import {
  allSevenDay,
  canLogScale,
  computeLayerData,
  expandIndicators,
  layerMarks,
  layerRequest,
  type LayerData,
} from './layerPoints';
import { layerLabel } from './layerLabel';

function pane(layers: Partial<Layer>[], expandVisibleTo?: [number, number]): Pane {
  return {
    id: 'p1',
    stretch: 1,
    scales: [{ id: 'right', side: 'right', ...(expandVisibleTo && { expandVisibleTo }) }],
    layers: layers.map((l, i) => ({ id: `l${i + 1}`, series: 'x', scale: 'right', color: '#111111', ...l })),
  };
}
const data: Record<string, LayerData> = {
  l1: { display: [{ time: '2026-01-02', value: 5 }] },
  l2: { display: [{ time: '2026-01-02', value: -1 }] },
};

test('canLogScale:指标图层看子线算出来的值(MACD 柱有负值就不能对数),不看源序列', () => {
  const macd = pane([{ series: 'SPY', indicator: { id: 'macd' } }]);
  const d = {
    l1: { display: [{ time: '2026-01-02', value: 700 }] },
    'l1#hist': { display: [{ time: '2026-01-02', value: -3 }] },
  };
  expect(canLogScale(macd, 'right', d)).toBe(false);
  const ok = { ...d, 'l1#hist': { display: [{ time: '2026-01-02', value: 3 }] } };
  expect(canLogScale(macd, 'right', ok)).toBe(true);
});

test('canLogScale:隐藏的线不挡;被叠加的 A 隐藏了照样挡;下限框撑到 ≤0 也不行', () => {
  expect(canLogScale(pane([{}, {}]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}, { hidden: true }]), 'right', data)).toBe(true);
  const fit = { target: 'l2', start: '2026-01-01', end: '2026-02-01', alpha: 0, beta: 1, r: 1 };
  expect(canLogScale(pane([{ fit }, { hidden: true }]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}], [0, 20]), 'right', data)).toBe(false);
  expect(canLogScale(pane([{}], [1, 20]), 'right', data)).toBe(true);
});

test('computeLayerData:事件竖线裁到其它线最早的起点,不把时间轴往左撑', () => {
  const doc = {
    v: 1 as const,
    panes: [pane([{ series: 'spx' }, { series: 'coreCpiRelease', render: { kind: 'events' } }])],
  };
  const pt = (time: string) => ({ time, value: 1 });
  const points = {
    spx: [pt('2020-03-02'), pt('2020-04-01')],
    'coreCpiRelease#d': [pt('2019-12-11'), pt('2020-03-11'), pt('2020-04-10')],
  };
  const out = computeLayerData(doc, points, '1D');
  expect(out.l2.display.map((p) => p.time)).toEqual(['2020-03-11', '2020-04-10']);
  expect(out.l1.display.length).toBe(2);
  // 数据没变时再算一遍(文档改了别的,比如颜色):裁剪结果是同一个数组,渲染层不重灌
  const again = computeLayerData({ ...doc }, points, '1D');
  expect(again.l2.display).toBe(out.l2.display);
});

test('computeLayerData:竖线按本格裁,别格的长历史线不让短历史那格在没数据处画满竖线', () => {
  const pt = (time: string) => ({ time, value: 1 });
  const long = { ...pane([{ series: 'spx' }]), id: 'p1' };
  const short = {
    ...pane([{ series: 'vix' }, { series: 'coreCpiRelease', render: { kind: 'events' } }]),
    id: 'p2',
    layers: [
      { id: 'l2', series: 'vix', scale: 'right', color: '#111111' },
      { id: 'l3', series: 'coreCpiRelease', scale: 'right', color: '#111111', render: { kind: 'events' as const } },
    ],
  };
  const points = {
    spx: [pt('2018-01-02'), pt('2022-06-01')],
    vix: [pt('2022-03-01'), pt('2022-06-01')],
    'coreCpiRelease#d': [pt('2019-12-11'), pt('2022-04-12')],
  };
  const out = computeLayerData({ v: 1, panes: [long, short] }, points, '1D');
  expect(out.l3.display.map((p) => p.time)).toEqual(['2022-04-12']);
});

describe('layerMarks', () => {
  const base = { id: 'l1', series: 'x', scale: 'right', color: '#111111' };
  // 21 个点 −5 … +5:P5 = −4.5、P95 = 4.5(与常态带 ±2 区分得开)
  const pts = Array.from({ length: 21 }, (_, i) => ({
    time: `2021-01-${String(i + 1).padStart(2, '0')}`,
    value: (i - 10) * 0.5,
  }));

  test('基线和参考线照画;没配分位不出背景带', () => {
    const m = layerMarks(
      { ...base, render: { kind: 'line', baseline: 0 }, refLines: [{ price: 13, title: '警戒' }] },
      pts,
    );
    expect(m.lines).toEqual([
      { price: 0, title: '0' },
      { price: 13, title: '警戒' },
    ]);
    expect(m.band).toBeNull();
  });

  test('只配分位:画 P5 / P95;没给 riskTail 不染背景', () => {
    const m = layerMarks({ ...base, percentile: {} }, pts);
    expect(m.lines).toEqual([
      { price: -4.5, title: 'P5' },
      { price: 4.5, title: 'P95' },
    ]);
    expect(m.band).toBeNull();
  });

  test('分位 + 参考线:线用参考线、不画 P5 / P95,背景照样按分位染(风险端红)', () => {
    const m = layerMarks({ ...base, refLines: normalBand(-2, 2), percentile: { riskTail: 'low' } }, pts);
    expect(m.lines).toEqual(normalBand(-2, 2));
    expect(m.band?.[0]).toMatchObject({ value: 1, color: BAND_RISK }); // 最低值 < P5,低端 = 风险
    expect(m.band?.[20]).toMatchObject({ value: 1, color: BAND_CALM });
    expect(m.band?.[10]).toMatchObject({ value: 1, color: 'rgba(0,0,0,0)' }); // 段内透明
    expect(m.band?.length).toBe(21); // 每个点都有,段外透明
  });

  test('since:只用这天起的点算阈值;比的是平移前的日期;筛空了不画分位线(不出 NaN)', () => {
    const m = layerMarks({ ...base, percentile: { since: '2021-01-11' } }, pts);
    expect(m.lines[0]).toEqual({ price: 0.25, title: 'P5' }); // 0 … 5 共 11 点,P5 = 0.25
    expect(m.window).toHaveLength(11); // 图例的分位排名徽标按同一段排
    // 往右平移 5 个交易日:画在图上的 01-18 原本是 01-11,窗口按原日期从 01-11 起 = 图上 01-18 起,样本更靠后、P5 更高
    const shifted = layerMarks({ ...base, shift: 5, percentile: { since: '2021-01-11' } }, pts);
    expect(shifted.lines[0].price).toBeGreaterThan(0.25);
    const empty = layerMarks({ ...base, percentile: { since: '2030-01-01' }, refLines: normalBand(-2, 2) }, pts);
    expect(empty).toEqual({ lines: normalBand(-2, 2), band: null, window: [] });
  });

  test('符号柱恒有 0 线(同固定面板);同一图层 + 同一份点只算一次', () => {
    const signed = { ...base, render: { kind: 'signed' as const } };
    expect(layerMarks(signed, pts).lines).toEqual([{ price: 0, title: '0' }]);
    expect(layerMarks(signed, pts)).toBe(layerMarks(signed, pts));
  });
});

test('computeLayerData:背景色带只在日线画;竖线周 / 月线按期取最大值(这一期出现过就标),不按期末一天', () => {
  const flags = ['2026-10-01', '2026-10-20', '2026-10-21', '2026-10-30'].map((time, i) => ({
    time,
    value: i < 2 ? 1 : 0,
  }));
  const bg = { v: 1 as const, panes: [pane([{ series: 'oilRollBrentWti', render: { kind: 'background' } }])] };
  expect(computeLayerData(bg, { 'oilRollBrentWti#d': flags }, '1M').l1.display).toEqual([]);
  expect(computeLayerData(bg, { 'oilRollBrentWti#d': flags }, '1D').l1.display).toEqual(flags);

  // 10 月:20 号(含)之前是 1、之后是 0 —— 月末那天是 0,按期末取会整月漏掉
  const ev = { v: 1 as const, panes: [pane([{ series: 'coreCpiRelease', render: { kind: 'events' } }])] };
  expect(computeLayerData(ev, { 'coreCpiRelease#d': flags }, '1M').l1.display).toEqual([
    { time: '2026-10-01', value: 1 },
  ]);
});

describe('整张图都是 7×24 才保留周末', () => {
  const doc = (series: string[]) => ({
    v: 1 as const,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' as const }],
        layers: series.map((s, i) => ({ id: `l${i}`, series: s, scale: 'right', color: '#fff' })),
      },
    ],
  });

  test('BTC + 供应密度全是 7×24:保留;混进 VIX(工作日)就去周末;空图不算', () => {
    expect(allSevenDay(doc(['btc', 'btcSupplyDensity']))).toBe(true);
    expect(allSevenDay(doc(['btc', 'vix']))).toBe(false);
    expect(allSevenDay(doc([]))).toBe(false);
    expect(layerRequest(doc(['btc']).panes[0].layers[0], true).weekends).toBe(true);
    expect(layerRequest(doc(['btc']).panes[0].layers[0]).weekends).toBeUndefined();
  });

  test('图例名:写了 title 用 title,缺省用注册表名', () => {
    const d = doc(['vix']);
    const l = d.panes[0].layers[0];
    expect(layerLabel(d, l)).toBe('VIX');
    expect(layerLabel(d, { ...l, title: '恐慌指数' })).toBe('恐慌指数');
  });
});

describe('指标图层展开成子线', () => {
  const doc = {
    v: 1 as const,
    panes: [
      pane([
        { series: 'SPY', render: { kind: 'candle' } },
        { series: 'SPY', indicator: { id: 'rsi', periods: [6, 12] }, hidden: true },
      ]),
    ],
  };

  test('渲染用的文档:指标换成各条子线(颜色 / 隐藏跟着走),同一份文档只展开一次', () => {
    const view = expandIndicators(doc);
    expect(view.panes[0].layers.map((l) => [l.id, l.hidden ?? false])).toEqual([
      ['l1', false],
      ['l2#rsi6', true],
      ['l2#rsi12', true],
    ]);
    expect(expandIndicators(doc)).toBe(view);
    // RSI 30/50/70 分界线只挂在第一条子线上(挂多条会重复画)
    expect(view.panes[0].layers.map((l) => l.refLines?.map((r) => r.price))).toEqual([
      undefined,
      [30, 50, 70],
      undefined,
    ]);
    const plain = { v: 1 as const, panes: [pane([{ series: 'SPY' }])] };
    expect(expandIndicators(plain)).toBe(plain); // 没有指标就原样
  });

  test('每条子线有自己算好的点;源序列的点相同就复用结果(切显隐不重算)', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({
      time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      value: 100 + i,
    }));
    const out = computeLayerData(doc, { SPY: pts, 'SPY#b': pts }, '1D');
    expect(out['l2#rsi6'].display.length).toBe(pts.length - 6);
    expect(out['l2#rsi12'].display.length).toBe(pts.length - 12);
    expect(computeLayerData({ ...doc }, { SPY: pts, 'SPY#b': pts }, '1D')['l2#rsi6'].display).toBe(
      out['l2#rsi6'].display,
    );
  });

  test('同一条源上两个指标(期权页:EMA + 布林带)各缓存各的,互不顶掉', () => {
    const two = {
      v: 1 as const,
      panes: [
        pane([
          { series: 'SPY', indicator: { id: 'ema', periods: [5] } },
          { series: 'SPY', indicator: { id: 'bb' } },
        ]),
      ],
    };
    const pts = Array.from({ length: 60 }, (_, i) => ({
      time: `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
      value: 100 + i,
    }));
    const a = computeLayerData(two, { SPY: pts }, '1D');
    const b = computeLayerData({ ...two }, { SPY: pts }, '1D');
    expect(b['l1#ema5'].display).toBe(a['l1#ema5'].display);
    expect(b['l2#upper'].display).toBe(a['l2#upper'].display);
  });
});

describe('365 年线:整张图都是 7×24 才自动带(混了工作日序列会去掉 BTC 的周末,365 根就不是年线了)', () => {
  const titles = (doc: ChartDoc) =>
    expandIndicators(doc).panes.flatMap((p) => p.layers.filter((l) => l.id.includes('#')).map((l) => l.title));

  test('纯 BTC:默认那组带 EMA365;BTC + SPY 同图:不带', () => {
    const btcOnly = { v: 1 as const, panes: [pane([{ series: 'btc' }, { series: 'btc', indicator: { id: 'ema' } }])] };
    const mixed = {
      v: 1 as const,
      panes: [pane([{ series: 'btc' }, { series: 'SPY' }, { series: 'btc', indicator: { id: 'ema' } }])],
    };
    expect(titles(btcOnly)).toContain('EMA365');
    expect(titles(mixed)).not.toContain('EMA365');
  });
});
