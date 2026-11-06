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

  test('编辑器里把一格唯一的线拖到新格:格子的短名和说明跟着走,不丢', () => {
    const moved = moveLayer(CONCENTRATION, 'l1', 'new');
    const pane = moved.panes.find((p) => p.layers.some((l) => l.id === 'l1'))!;
    expect(pane).toMatchObject({ label: '市值 / 等权', desc: CONCENTRATION.panes[0].desc });
    expect(moved.panes.length).toBe(3);
  });

  test('拖进已有格(两格并成一格):只留目标格自己的短名和说明', () => {
    const merged = moveLayer(CONCENTRATION, 'l2', 'p1');
    expect(merged.panes.map((p) => p.label)).toEqual(['市值 / 等权', '等权 − 加权回撤']);
    expect(merged.panes[0].desc).toBe(CONCENTRATION.panes[0].desc);
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
