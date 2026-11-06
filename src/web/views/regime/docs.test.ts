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

  test('固定面板画不了的设定(多线 / 非 regime 源 / 平移 / 叠加 / 隐藏 / 左轴 / 独立轴 / 倒轴 / 对数 / 同一序列占两格)直接报错,不静默', () => {
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
    const twoLines = withLayer({});
    twoLines.panes[0].layers.push({ ...twoLines.panes[0].layers[0], id: 'l9' });
    expect(() => docToPaneSpecs(twoLines)).toThrow();
    // 事件图层不算第二条线,转成格子的 events;它自己不能平移
    const ev = {
      id: 'l9',
      series: 'coreCpiRelease',
      scale: 'right',
      color: '#eab308',
      render: { kind: 'events' as const },
    };
    const withEvents = withLayer({ render: { kind: 'signed' } });
    withEvents.panes[0].layers.push(ev);
    expect(docToPaneSpecs(withEvents)[0]).toMatchObject({
      render: { kind: 'signed' },
      events: [{ key: 'coreCpiRelease', title: '核心 CPI 发布日', color: '#eab308' }],
    });
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
});
