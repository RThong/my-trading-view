import { describe, expect, test } from 'bun:test';
import { type ChartDoc, moveLayer, parseChartDoc } from '../chartDoc/chartDoc';
import { CONCENTRATION } from '../../pages/featured/concentration';
import { docToPaneSpecs } from './regimeChart.hooks';
import { dimPanes, REGIME_DOCS } from '../../pages/regimeDims';

// 固定面板迁成 ChartDoc 后,编译期的拼写检查只剩一半(序列 id 是字符串):这里补回来。
describe('固定面板的 ChartDoc', () => {
  test.each(Object.entries(REGIME_DOCS))('%s:导出成 JSON 再解析,与原文档完全相同', (_, doc) => {
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  test.each(Object.keys(REGIME_DOCS))('%s:每格都解析成了 /api/regime 的序列', (dim) => {
    // 序列 id 不在注册表 / 不是 regime 源时,docToPaneSpecs 在模块加载时就抛了;这里确认格数没少
    expect(dimPanes(dim as never).length).toBe(REGIME_DOCS[dim as keyof typeof REGIME_DOCS].panes.length);
  });

  test('编辑器里把一格唯一的线拖到新格:格子的说明跟着走,不丢', () => {
    const moved = moveLayer(CONCENTRATION, 'l1', 'new');
    const pane = moved.panes.find((p) => p.layers.some((l) => l.id === 'l1'))!;
    expect(pane.desc).toBe(CONCENTRATION.panes[0].desc);
    expect(moved.panes.length).toBe(3);
  });

  test('拖进已有格(两格并成一格):只留目标格自己的说明', () => {
    const merged = moveLayer(CONCENTRATION, 'l2', 'p1');
    expect(merged.panes.map((p) => p.desc)).toEqual([CONCENTRATION.panes[0].desc, CONCENTRATION.panes[2].desc]);
  });

  test('固定面板画不了的设定(非 regime 源 / 平移 / 叠加 / 隐藏 / 左轴 / 独立轴 / 倒轴 / 对数 / 同一序列占两格)直接报错,不静默', () => {
    // 底子用第三格(普通的 regime 序列,不是计算格)
    const withLayer = (patch: object, scale: object = { id: 'right', side: 'right' }): ChartDoc => ({
      v: 1,
      panes: [
        { id: 'p1', stretch: 1, scales: [scale as never], layers: [{ ...CONCENTRATION.panes[2].layers[0], ...patch }] },
      ],
    });
    expect(() => docToPaneSpecs(withLayer({ series: 'SPY' }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({ series: 'nope' }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({ shift: 5 }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({ hidden: true }))).toThrow();
    // 轴的范围框照传(固定面板按格子画,格子只有右轴)
    const boxed = docToPaneSpecs(
      withLayer({}, { id: 'right', side: 'right', clampVisibleTo: [-5, 15], expandVisibleTo: [1, 19] }),
    );
    expect(boxed[0]).toMatchObject({ clampVisibleTo: [-5, 15], expandVisibleTo: [1, 19] });
    // 计算图层支持了,但两条腿都得在注册表里
    expect(() => docToPaneSpecs(withLayer({ calc: { op: '-', series: 'nope' } }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({ scale: 'left' }, { id: 'left', side: 'left' }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({}, { id: 'right', side: 'right', log: true }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({}, { id: 'right', side: 'right', invert: true }))).toThrow();
    expect(() => docToPaneSpecs(withLayer({ scale: 's1' }, { id: 's1', side: 'overlay' }))).toThrow();
    const fit = { target: 'l0', start: '2020-01-01', end: '2021-01-01', alpha: 0, beta: 1, r: 1 };
    expect(() => docToPaneSpecs(withLayer({ fit }))).toThrow();
    // 第二条线起是叠加线:普通折线(可阶梯 / 隐藏)照传;计算 / 平移 / 换轴 / 柱状 / 参考线 / 分位等写了不照画 → 报错
    const withSigned = (): ChartDoc => {
      const d = withLayer({ render: { kind: 'signed' }, refLines: undefined, percentile: undefined });
      d.panes[0].layers.push({ id: 'l8', series: 'vix', scale: 'right', color: '#f59e0b' });
      return d;
    };
    const twoLines = (overlay: object, scales?: object[]): ChartDoc => {
      const d = withLayer({});
      d.panes[0].layers.push({ id: 'l9', series: 'vix', scale: 'right', color: '#f59e0b', ...overlay });
      if (scales) d.panes[0].scales.push(...(scales as never[]));
      return d;
    };
    expect(docToPaneSpecs(twoLines({ render: { kind: 'line', step: true }, hidden: true }))[0].overlays).toEqual([
      { key: 'vix', title: 'VIX', color: '#f59e0b', step: true, hidden: true },
    ]);
    expect(() => docToPaneSpecs(twoLines({ calc: { op: '-', series: 'vix3m' } }))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ shift: 2 }))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ scale: 's1' }, [{ id: 's1', side: 'overlay' }]))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ render: { kind: 'signed' } }))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ render: { kind: 'line', baseline: 0 } }))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ refLines: [{ price: 1, title: 'x' }] }))).toThrow();
    expect(() => docToPaneSpecs(twoLines({ series: 'SPY' }))).toThrow(); // 不是 /api/regime 的序列
    // 叠加线和主线(或另一条叠加线)同序列:后写的会盖掉前面那条 → 报错
    const mainSeries = withLayer({}).panes[0].layers[0].series;
    expect(() => docToPaneSpecs(twoLines({ series: mainSeries }))).toThrow();
    // 柱状主线不画叠加线 → 报错;标普 500 编辑器能画蜡烛(K 线从 Yahoo 取),固定面板的 ohlc 里没有 → 报错
    expect(() => docToPaneSpecs(withSigned())).toThrow();
    expect(() =>
      docToPaneSpecs(
        withLayer({ series: 'spx', render: { kind: 'candle' }, refLines: undefined, percentile: undefined }),
      ),
    ).toThrow();
    // QQQ 蜡烛:编辑器走 ETF 现货,固定面板按登记的 regimeKey 读库里的 ohlc.qqq
    expect(
      docToPaneSpecs(
        withLayer({ series: 'qqq', render: { kind: 'candle' }, refLines: undefined, percentile: undefined }),
      )[0].key,
    ).toBe('qqq');
    // 注册表另给了取法、但 /api/regime 也发同名键的(dgs10 编辑器走收益曲线):固定面板照旧读同名键
    expect(docToPaneSpecs(withLayer({ series: 'dgs10', refLines: undefined, percentile: undefined }))[0].key).toBe(
      'dgs10',
    );
    // 只有竖线 / 背景、没有线:没有主线 → 报错
    const onlyMarks = withLayer({ series: 'bojHikeDates', render: { kind: 'events' } });
    expect(() => docToPaneSpecs(onlyMarks)).toThrow();
    // 事件图层不算第二条线,转成格子的 events;它自己不能平移
    const ev = {
      id: 'l9',
      series: 'coreCpiRelease',
      scale: 'right',
      color: '#eab308',
      render: { kind: 'events' as const },
    };
    const withEvents = withLayer({});
    withEvents.panes[0].layers.push(ev);
    expect(docToPaneSpecs(withEvents)[0]).toMatchObject({
      events: [{ key: 'coreCpiRelease', title: '核心 CPI 发布日', color: '#eab308' }],
    });
    // 柱状格固定面板只画柱子,竖线写了也不画 → 报错
    const signedEvents = withLayer({ render: { kind: 'signed' }, refLines: undefined, percentile: undefined });
    signedEvents.panes[0].layers.push(ev);
    expect(() => docToPaneSpecs(signedEvents)).toThrow();
    // 蜡烛照传;BTC 只进 /api/regime 的 ohlc(不在 series 里),蜡烛图层也认
    // 底子那格带分位 / 参考线,蜡烛格不画这些 → 去掉
    const btcCandle = withLayer({
      series: 'btc',
      render: { kind: 'candle' },
      refLines: undefined,
      percentile: undefined,
    });
    expect(docToPaneSpecs(btcCandle)[0]).toMatchObject({ key: 'btc', render: { kind: 'candle' } });
    expect(() => docToPaneSpecs(withLayer({ series: 'btc' }))).toThrow(); // 折线的 BTC 固定面板没有现成键
    // 写了蜡烛却没有 K 线 / 蜡烛格配了固定面板不画的东西 → 报错(不悄悄空白 / 少画)
    expect(() => docToPaneSpecs(withLayer({ render: { kind: 'candle' } }))).toThrow();
    expect(() =>
      docToPaneSpecs(withLayer({ series: 'btc', render: { kind: 'candle' }, refLines: [{ price: 1, title: 'x' }] })),
    ).toThrow();
    withEvents.panes[0].layers[1] = { ...ev, shift: 3 };
    expect(() => docToPaneSpecs(withEvents)).toThrow();
    // 错月背景图层 → 格子的 rollMismatch;别的序列当背景、或一格两层背景,固定面板画不了 → 报错
    const bg = { ...ev, series: 'oilRollCrack', color: '#94a3b8', render: { kind: 'background' as const } };
    withEvents.panes[0].layers[1] = bg;
    expect(docToPaneSpecs(withEvents)[0]).toMatchObject({ rollMismatch: 'crack' });
    withEvents.panes[0].layers[1] = { ...bg, series: 'vix' };
    expect(() => docToPaneSpecs(withEvents)).toThrow();
    // 颜色不是错月灰蓝:编辑器照画、固定面板按固定色画,两边对不上 → 报错
    withEvents.panes[0].layers[1] = { ...bg, color: '#f97316' };
    expect(() => docToPaneSpecs(withEvents)).toThrow();
    withEvents.panes[0].layers[1] = bg;
    withEvents.panes[0].layers.push({ ...bg, id: 'l8', series: 'oilRollBrentWti' });
    expect(() => docToPaneSpecs(withEvents)).toThrow();
    const samePaneTwice: ChartDoc = {
      v: 1,
      panes: [
        CONCENTRATION.panes[0],
        { ...CONCENTRATION.panes[0], id: 'p9', layers: [{ ...CONCENTRATION.panes[0].layers[0], id: 'l9' }] },
      ],
    };
    expect(() => docToPaneSpecs(samePaneTwice)).toThrow();
  });

  test('集中度:比值两格是计算格(前端现算),回撤差仍读服务端', () => {
    const panes = dimPanes('concentration');
    expect(panes.map((p) => p.key)).toEqual(['spx|/|spxew', 'vixeq|/|vixSpot', 'eqwDdSpread']);
    expect(panes[0].from).toEqual({ series: 'spx', calc: { op: '/', series: 'spxew' } });
    expect(panes[1].title).toBe('VIXEQ / VIX 隐含集中度');
  });

  test('真实的复杂格(利率 · 加息定价:主线 + 3 条叠加线 + 2 条竖线)写成 ChartDoc,转回来画的东西与原格一致', () => {
    const doc: ChartDoc = {
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 1,
          scales: [{ id: 'right', side: 'right' }],
          layers: [
            {
              id: 'l1',
              series: 'oisHikes12m',
              scale: 'right',
              color: '#f43f5e',
              title: '12 个月内计入(次)',
              render: { kind: 'line', baseline: 0 },
            },
            { id: 'l2', series: 'oisHikes3m', scale: 'right', color: '#fde047', title: '3 个月内(次)' },
            { id: 'l3', series: 'oisHikes6m', scale: 'right', color: '#fb923c', title: '6 个月内(次)' },
            { id: 'l4', series: 'oisHikes2y', scale: 'right', color: '#a78bfa', title: '2 年内(次)' },
            {
              id: 'l5',
              series: 'coreCpiRelease',
              scale: 'right',
              color: '#facc15',
              title: '核心 CPI 发布日',
              render: { kind: 'events', opacity: 0.55 },
            },
            {
              id: 'l6',
              series: 'corePceRelease',
              scale: 'right',
              color: '#60a5fa',
              title: '核心 PCE 发布日',
              render: { kind: 'events', opacity: 0.55 },
            },
          ],
        },
      ],
    };
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    const original = dimPanes('policyRepricing')[0];
    const pick = ({ key, title, color, render, overlays, events }: typeof original) => ({
      key,
      title,
      color,
      render,
      overlays,
      events,
    });
    // 格子短名 label、说明 desc 不比:label 按「不兼容老面板界面」已删,desc 是另写的文字
    expect(pick(docToPaneSpecs(doc)[0])).toEqual(pick(original));
  });
});
