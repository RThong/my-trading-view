import { describe, expect, test } from 'bun:test';
import {
  EMPTY_DOC,
  addLayer,
  applyLayerFit,
  clearLayerFit,
  setLayerHidden,
  setLayerShift,
  setScaleInvert,
  setScaleLog,
  moveLayer,
  nextColor,
  nextId,
  normalize,
  parseChartDoc,
  removeLayer,
  removeSeries,
  setLayerCalc,
  setLayerColor,
  setLayerScale,
  setStretches,
  type ChartDoc,
  type Layer,
} from './chartDoc';

function seriesOf(l: Layer) {
  return l.series;
}

function twoOnMain() {
  return addLayer(addLayer(EMPTY_DOC, 'SPY', '#111111'), 'vix', '#222222');
}

describe('addLayer', () => {
  test('空图新建主格(stretch 2、右轴)', () => {
    const d = addLayer(EMPTY_DOC, 'SPY', '#111111');
    expect(d).toEqual({
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 2,
          scales: [{ id: 'right', side: 'right' }],
          layers: [{ id: 'l1', series: 'SPY', scale: 'right', color: '#111111' }],
        },
      ],
    });
  });

  test('有格时加到第 0 格', () => {
    const d = moveLayer(twoOnMain(), 'l2', 'new');
    const e = addLayer(d, 'dgs10', '#333333');
    expect(e.panes[0].layers.map(seriesOf)).toEqual(['SPY', 'dgs10']);
    expect(e.panes[1].layers.map(seriesOf)).toEqual(['vix']);
  });
});

describe('moveLayer', () => {
  test('新开一格追加在最下面,stretch 1,带走右轴', () => {
    const d = moveLayer(twoOnMain(), 'l2', 'new');
    expect(d.panes).toHaveLength(2);
    expect(d.panes[1]).toEqual({
      id: 'p2',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ id: 'l2', series: 'vix', scale: 'right', color: '#222222' }],
    });
  });

  test('移走唯一图层 → 空格自动消失,编号收拢', () => {
    const d = moveLayer(moveLayer(twoOnMain(), 'l2', 'new'), 'l1', 'p2');
    expect(d.panes.map((p) => p.id)).toEqual(['p2']);
    expect(d.panes[0].layers.map((l) => l.id)).toEqual(['l2', 'l1']);
    // 两条都挂右轴:目标格不出现重复的 right
    expect(d.panes[0].scales).toEqual([{ id: 'right', side: 'right' }]);
  });

  test('独立轴不跨格共享:目标格新开一根', () => {
    const base = setLayerScale(moveLayer(twoOnMain(), 'l2', 'new'), 'l1', 'newOverlay');
    expect(base.panes[0].scales).toEqual([{ id: 's1', side: 'overlay' }]);
    const d = moveLayer(base, 'l1', 'p2');
    expect(d.panes).toHaveLength(1);
    const l1 = d.panes[0].layers.find((l) => l.id === 'l1')!;
    expect(l1.scale).toBe('s2');
    expect(d.panes[0].scales).toContainEqual({ id: 's2', side: 'overlay' });
  });

  test('同格调顺序:插到指定图层前面;不给 before = 挪到末尾', () => {
    const d = addLayer(twoOnMain(), 'dgs10', '#333333'); // l1 l2 l3
    const order = (x: ChartDoc) => x.panes[0].layers.map((l) => l.id);
    expect(order(moveLayer(d, 'l3', 'p1', 'l1'))).toEqual(['l3', 'l1', 'l2']);
    expect(order(moveLayer(d, 'l1', 'p1'))).toEqual(['l2', 'l3', 'l1']);
    // 原地不动(插到自己后面那条之前 = 原位置)返回原引用
    expect(moveLayer(d, 'l1', 'p1', 'l2')).toBe(d);
    expect(moveLayer(d, 'l1', 'p1', 'l1')).toBe(d);
  });

  test('目标格不存在 → 原样返回,不丢图层', () => {
    const d = twoOnMain();
    expect(moveLayer(d, 'l1', 'p9')).toBe(d);
  });

  test('跨格插到指定图层前面', () => {
    const d = moveLayer(addLayer(twoOnMain(), 'dgs10', '#333333'), 'l2', 'new'); // p1: l1 l3 / p2: l2
    const e = moveLayer(d, 'l3', 'p2', 'l2');
    expect(e.panes[1].layers.map((l) => l.id)).toEqual(['l3', 'l2']);
  });
});

describe('setLayerScale', () => {
  test('换到左轴;右轴没人用了被回收', () => {
    const d = setLayerScale(addLayer(EMPTY_DOC, 'SPY', '#111111'), 'l1', 'left');
    expect(d.panes[0].scales).toEqual([{ id: 'left', side: 'left' }]);
  });

  test('两条图层可共用同一根独立轴', () => {
    const a = setLayerScale(twoOnMain(), 'l1', 'newOverlay');
    const b = setLayerScale(a, 'l2', { overlay: 's1' });
    expect(b.panes[0].layers.map((l) => l.scale)).toEqual(['s1', 's1']);
    expect(b.panes[0].scales).toEqual([{ id: 's1', side: 'overlay' }]);
  });
});

describe('removeLayer / setLayerColor / setStretches', () => {
  test('removeSeries 拿掉该序列在所有格里的图层', () => {
    const d = addLayer(moveLayer(twoOnMain(), 'l2', 'new'), 'vix', '#333333');
    const e = removeSeries(d, 'vix');
    expect(e.panes.flatMap((p) => p.layers.map(seriesOf))).toEqual(['SPY']);
    expect(e.panes).toHaveLength(1);
  });

  test('删光 → panes 为空', () => {
    expect(removeLayer(removeLayer(twoOnMain(), 'l1'), 'l2')).toEqual(EMPTY_DOC);
  });

  test('改色只动目标图层', () => {
    const d = setLayerColor(twoOnMain(), 'l2', '#ff0000');
    expect(d.panes[0].layers.map((l) => l.color)).toEqual(['#111111', '#ff0000']);
  });

  test('高度比例:长度不符不动、相同返回原引用', () => {
    const d = moveLayer(twoOnMain(), 'l2', 'new');
    expect(setStretches(d, [1])).toBe(d);
    expect(setStretches(d, [2, 1])).toBe(d);
    expect(setStretches(d, [1.5, 0.5]).panes.map((p) => p.stretch)).toEqual([1.5, 0.5]);
  });
});

describe('nextId / nextColor', () => {
  test('按现存最大号 +1', () => {
    const d = removeLayer(twoOnMain(), 'l2');
    expect(nextId(d, 'l')).toBe('l2'); // 删掉的恰是最大号 → 复用
    const e = addLayer(twoOnMain(), 'x', '#000000');
    expect(nextId(e, 'l')).toBe('l4');
  });

  test('优先取没用过的颜色', () => {
    expect(nextColor(twoOnMain(), ['#111111', '#222222', '#333333'])).toBe('#333333');
    expect(nextColor(twoOnMain(), ['#111111', '#222222'])).toBe('#111111');
  });
});

describe('normalize / parseChartDoc', () => {
  test('引用不存在的独立轴退回右轴;补上未声明的内置轴', () => {
    const raw: ChartDoc = {
      v: 1,
      panes: [{ id: 'p1', stretch: 1, scales: [], layers: [{ id: 'l1', series: 'SPY', scale: 's9', color: '#000' }] }],
    };
    expect(normalize(raw).panes[0]).toMatchObject({
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ scale: 'right' }],
    });
  });

  test('往返:序列化后能原样解析回来', () => {
    const d = setLayerScale(moveLayer(twoOnMain(), 'l2', 'new'), 'l1', 'newOverlay');
    expect(parseChartDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  test('id 冲突或保留轴 id 与 side 不符 → null', () => {
    const layer = (id: string) => ({ id, series: 'SPY', scale: 'right', color: '#000000' });
    const pane = (id: string, layers: unknown[], scales: unknown[] = [{ id: 'right', side: 'right' }]) => ({
      id,
      stretch: 1,
      scales,
      layers,
    });
    // 图层 id 跨格重复
    expect(parseChartDoc({ v: 1, panes: [pane('p1', [layer('l1')]), pane('p2', [layer('l1')])] })).toBeNull();
    // 格 id 重复
    expect(parseChartDoc({ v: 1, panes: [pane('p1', [layer('l1')]), pane('p1', [layer('l2')])] })).toBeNull();
    // 保留 id 配错 side / 独立轴占用保留名
    expect(parseChartDoc({ v: 1, panes: [pane('p1', [layer('l1')], [{ id: 'left', side: 'overlay' }])] })).toBeNull();
    expect(parseChartDoc({ v: 1, panes: [pane('p1', [layer('l1')], [{ id: 's1', side: 'left' }])] })).toBeNull();
    // 格 id 占用保留字 'new'
    expect(parseChartDoc({ v: 1, panes: [pane('new', [layer('l1')])] })).toBeNull();
    // 每格各有一根 right 是合法的
    expect(parseChartDoc({ v: 1, panes: [pane('p1', [layer('l1')]), pane('p2', [layer('l2')])] })).not.toBeNull();
  });

  test('坏颜色 / 非有限高度 → null;多余字段被丢掉', () => {
    const base = (layer: Record<string, unknown>, stretch = 1) => ({
      v: 1,
      panes: [{ id: 'p1', stretch, scales: [{ id: 'right', side: 'right' }], layers: [layer] }],
    });
    const ok = { id: 'l1', series: 'SPY', scale: 'right', color: '#3987e5' };
    expect(parseChartDoc(base({ ...ok, color: 'red' }))).toBeNull();
    expect(parseChartDoc(base(ok, Number.POSITIVE_INFINITY))).toBeNull();
    const parsed = parseChartDoc(base({ ...ok, data: [1, 2, 3] }));
    expect(parsed?.panes[0].layers[0]).toEqual(ok);
  });

  test('结构不对返回 null', () => {
    expect(parseChartDoc(null)).toBeNull();
    expect(parseChartDoc({ v: 2, panes: [] })).toBeNull();
    expect(parseChartDoc({ v: 1, panes: [{ id: 'p1', stretch: 0, scales: [], layers: [] }] })).toBeNull();
    expect(
      parseChartDoc({ v: 1, panes: [{ id: 'p1', stretch: 1, scales: [{ id: 'x', side: 'top' }], layers: [] }] }),
    ).toBeNull();
  });
});

describe('平移 / 倒轴', () => {
  test('setLayerShift:取整、截上限、0 删字段、不变返回原引用', () => {
    const d = twoOnMain();
    const e = setLayerShift(d, 'l2', 84.4);
    expect(e.panes[0].layers[1]).toMatchObject({ shift: 84 });
    expect(setLayerShift(e, 'l2', 84)).toBe(e);
    expect(setLayerShift(e, 'l2', 99999).panes[0].layers[1]).toMatchObject({ shift: 3650 });
    expect('shift' in setLayerShift(e, 'l2', 0).panes[0].layers[1]).toBe(false);
  });

  test('setLayerHidden:显示删字段、不变返回原引用、往返解析保留;hidden 只认 true', () => {
    const d = setLayerHidden(twoOnMain(), 'l2', true);
    expect(d.panes[0].layers[1]).toMatchObject({ hidden: true });
    expect(setLayerHidden(d, 'l2', true)).toBe(d);
    expect('hidden' in setLayerHidden(d, 'l2', false).panes[0].layers[1]).toBe(false);
    expect(parseChartDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);

    const raw = JSON.parse(JSON.stringify(d));
    raw.panes[0].layers[1].hidden = false;
    expect(parseChartDoc(raw)).toBeNull();
  });

  test('setScaleLog 与倒轴互不影响,往返解析保留', () => {
    const d = setScaleLog(setScaleInvert(twoOnMain(), 'p1', 'right', true), 'p1', 'right', true);
    expect(d.panes[0].scales).toEqual([{ id: 'right', side: 'right', invert: true, log: true }]);
    expect(setScaleLog(d, 'p1', 'right', false).panes[0].scales).toEqual([
      { id: 'right', side: 'right', invert: true },
    ]);
    expect(parseChartDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  test('轴的范围框:往返解析保留;须是两个有限数,上限框 lo < hi、下限框 lo ≤ hi', () => {
    const doc = (sc: object) => ({
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 1,
          scales: [{ id: 'right', side: 'right', ...sc }],
          layers: [{ id: 'l1', series: 'vix', scale: 'right', color: '#111111' }],
        },
      ],
    });
    const ok = doc({ clampVisibleTo: [-5, 15], expandVisibleTo: [1, 19] });
    expect(parseChartDoc(ok)).toEqual(ok as ChartDoc);
    expect(parseChartDoc(doc({ clampVisibleTo: [15, -5] }))).toBeNull();
    expect(parseChartDoc(doc({ clampVisibleTo: [3, 3] }))).toBeNull();
    expect(parseChartDoc(doc({ expandVisibleTo: [0, 0] }))).not.toBeNull();
    expect(parseChartDoc(doc({ expandVisibleTo: [1] }))).toBeNull();
    expect(parseChartDoc(doc({ expandVisibleTo: [1, null] }))).toBeNull();
  });

  test('setScaleInvert 作用于整根轴;关掉时删字段', () => {
    const d = setScaleInvert(twoOnMain(), 'p1', 'right', true);
    expect(d.panes[0].scales).toEqual([{ id: 'right', side: 'right', invert: true }]);
    expect(setScaleInvert(d, 'p1', 'right', false).panes[0].scales).toEqual([{ id: 'right', side: 'right' }]);
  });
});

describe('叠加', () => {
  test('applyLayerFit:挪进目标格、挂目标对面的内置轴并按需倒轴', () => {
    const base = setLayerScale(moveLayer(twoOnMain(), 'l2', 'new'), 'l1', 'left'); // p1: l1(左轴) / p2: l2
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = applyLayerFit(base, 'l2', fit, true);
    expect(d.panes).toHaveLength(1);
    expect(d.panes[0].layers.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(d.panes[0].layers[1]).toMatchObject({ fit, scale: 'right' });
    expect(d.panes[0].scales).toContainEqual({ id: 'right', side: 'right', invert: true });
    expect(d.panes[0].scales).toContainEqual({ id: 'left', side: 'left' });
  });

  test('applyLayerFit:两侧内置轴都被别的线占了 → 开独立轴', () => {
    const base = setLayerScale(addLayer(twoOnMain(), 'dgs10', '#333333'), 'l3', 'left'); // l1 右 / l2 右 / l3 左
    const d = applyLayerFit(
      base,
      'l2',
      { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 },
      false,
    );
    expect(d.panes[0].layers.find((l) => l.id === 'l2')).toMatchObject({ scale: 's1' });
    expect(d.panes[0].scales).toContainEqual({ id: 's1', side: 'overlay' });
  });

  test('叠加关系被破坏就自动解除:A 挪到别格', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = applyLayerFit(twoOnMain(), 'l2', fit, true); // l1 右轴 / l2 左轴(叠加)
    const moved = moveLayer(d, 'l1', 'new');
    expect(moved.panes.flatMap((p) => p.layers).find((l) => l.id === 'l2')?.fit).toBeUndefined();
  });

  test('别的线不能挂上 B 的轴:换轴被拒,加线 / 挪线进来改开独立轴', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    // A 挂左轴 → B 叠加后挂右轴(新加的线默认也去右轴)
    const d = applyLayerFit(setLayerScale(twoOnMain(), 'l1', 'left'), 'l2', fit, true);
    expect(d.panes[0].layers.find((l) => l.id === 'l2')).toMatchObject({ scale: 'right' });

    const added = addLayer(d, 'dgs10', '#333333');
    expect(added.panes[0].layers.find((l) => l.id === 'l2')?.fit).toEqual(fit);
    const l3 = added.panes[0].layers.find((l) => l.id === 'l3')!;
    expect(added.panes[0].scales.find((sc) => sc.id === l3.scale)?.side).toBe('overlay');
    expect(setLayerScale(added, 'l3', 'right')).toBe(added);

    const elsewhere = moveLayer(addLayer(d, 'dgs10', '#333333'), 'l3', 'new'); // l3 去新格后改挂右轴,再挪回来
    const back = moveLayer(setLayerScale(elsewhere, 'l3', 'right'), 'l3', 'p1');
    expect(back.panes[0].layers.find((l) => l.id === 'l2')?.fit).toEqual(fit);
    expect(back.panes[0].layers.find((l) => l.id === 'l3')?.scale).not.toBe('right');
  });

  test('applyLayerFit:B 原来那根轴的对数会被关掉(B 轴按线性比例跟 A 走)', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: 2, r: 0.9 };
    const base = setScaleLog(setLayerScale(twoOnMain(), 'l2', 'left'), 'p1', 'left', true);
    const d = applyLayerFit(base, 'l2', fit, false);
    expect(d.panes[0].scales.find((sc) => sc.id === 'left')).toEqual({ id: 'left', side: 'left' });
  });

  test('已是别人换算目标的图层不能再换算(否则那条线的换算会被静默冲掉)', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = applyLayerFit(addLayer(twoOnMain(), 'dgs10', '#333333'), 'l2', fit, false);
    expect(applyLayerFit(d, 'l1', { ...fit, target: 'l3' }, false)).toBe(d);
  });

  test('取消叠加 / 删掉换算目标 → 改挂独立轴', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = applyLayerFit(twoOnMain(), 'l2', fit, true);
    expect(d.panes[0].layers[1]).toMatchObject({ scale: 'left' });
    const c = clearLayerFit(d, 'l2');
    expect(c.panes).toHaveLength(1);
    // 取消叠加后改挂本格一根新独立轴;叠加时用的左轴没人用了被回收,倒轴跟着没
    expect(c.panes[0].scales.some((sc) => sc.id === 'left')).toBe(false);
    expect(c.panes[0].layers[1]).toMatchObject({ id: 'l2', scale: 's1' });
    expect(c.panes[0].scales).toContainEqual({ id: 's1', side: 'overlay' });
    expect('fit' in c.panes[0].layers[1]).toBe(false);
    const e = removeLayer(d, 'l1');
    expect(e.panes).toHaveLength(1);
    expect(e.panes[0].layers[0]).toMatchObject({ id: 'l2', scale: 's1' });
    expect('fit' in e.panes[0].layers[0]).toBe(false);
  });

  test('parseChartDoc 拒绝不存在的日期、旧版的派生层', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = applyLayerFit(twoOnMain(), 'l2', fit, false);
    const badDate = JSON.parse(JSON.stringify(d));
    badDate.panes[0].layers[1].fit.end = '2021-99-01';
    expect(parseChartDoc(badDate)).toBeNull();

    // 滚动相关性层已删:旧 JSON 里带 study 的图层不认
    const study = JSON.parse(JSON.stringify(twoOnMain()));
    study.panes.push({
      id: 'p9',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ id: 'l9', scale: 'right', color: '#ffffff', study: { kind: 'corr', a: 'l1', b: 'l2' } }],
    });
    expect(parseChartDoc(study)).toBeNull();
  });

  test('先开对数再开倒轴:复制出去再导入,JSON 文本原样不变', () => {
    const d = setScaleInvert(setScaleLog(twoOnMain(), 'p1', 'right', true), 'p1', 'right', true);
    const text = JSON.stringify(d);
    expect(JSON.stringify(parseChartDoc(JSON.parse(text)))).toBe(text);
  });

  test('叠加后改偏移再重新叠加:复制出去再导入,JSON 文本原样不变', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const once = applyLayerFit(setLayerShift(twoOnMain(), 'l2', 3), 'l2', fit, true);
    const again = applyLayerFit(setLayerShift(once, 'l2', 7), 'l2', { ...fit, end: '2022-06-30' }, true);
    const text = JSON.stringify(again, null, 2);
    expect(JSON.stringify(parseChartDoc(JSON.parse(text)), null, 2)).toBe(text);
  });

  test('导入时叠加的线引用了没声明的轴:退回右轴后与 A 共轴 → 叠加解除,且再导入一次结果不变', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const raw = {
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 2,
          scales: [{ id: 'right', side: 'right' }],
          layers: [
            { id: 'l1', series: 'SPY', scale: 'right', color: '#111111' },
            { id: 'l2', series: 'vix', scale: 's9', color: '#222222', fit },
          ],
        },
      ],
    };
    const once = parseChartDoc(raw)!;
    expect(once.panes[0].layers.find((l) => l.id === 'l2')?.fit).toBeUndefined();
    const text = JSON.stringify(once);
    expect(JSON.stringify(parseChartDoc(JSON.parse(text)))).toBe(text);
  });

  test('parseChartDoc 往返带平移 / 倒轴 / 叠加的文档', () => {
    const fit = { target: 'l1', start: '2018-01-01', end: '2021-12-31', alpha: 1, beta: -2, r: -0.9 };
    const d = setScaleInvert(setLayerShift(applyLayerFit(twoOnMain(), 'l2', fit, true), 'l2', 63), 'p1', 'right', true);
    expect(parseChartDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
    // 坏参数被拦
    const bad = JSON.parse(JSON.stringify(d));
    bad.panes[0].layers[1].shift = 99999;
    expect(parseChartDoc(bad)).toBeNull();
  });
});

describe('固定面板用的可选字段', () => {
  const base = (layerPatch: object, panePatch: object = {}) => ({
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [{ id: 'l1', series: 'vix', scale: 'right', color: '#111111', ...layerPatch }],
        ...panePatch,
      },
    ],
  });

  test('合法值原样保留', () => {
    const ok = base(
      {
        title: 'VIX',
        render: { kind: 'line', baseline: 0, step: true },
        refLines: [{ price: 4, title: '临界 4', color: '#ef4444' }],
        percentile: { riskTail: 'high', since: '2000-01-01' },
      },
      { label: 'VIX', desc: '说明' },
    );
    expect(parseChartDoc(ok)).toEqual(ok as ChartDoc);
  });

  test.each([
    ['render.kind 不认识', { render: { kind: 'candle' } }],
    ['step 只能是 true', { render: { kind: 'line', step: false } }],
    ['参考线颜色须 #rrggbb', { refLines: [{ price: 1, title: 'x', color: 'red' }] }],
    ['参考线缺价位', { refLines: [{ title: 'x' }] }],
    ['riskTail 只有 low / high', { percentile: { riskTail: 'mid' } }],
    ['since 须是真日期', { percentile: { since: '2026-13-01' } }],
    ['title 不能是空串', { title: '' }],
  ])('图层:%s → 拒收', (_, patch) => {
    expect(parseChartDoc(base(patch))).toBeNull();
  });

  test.each([
    ['label 不能是空串', { label: '' }],
    ['desc 须是字符串', { desc: 1 }],
  ])('格:%s → 拒收', (_, patch) => {
    expect(parseChartDoc(base({}, patch))).toBeNull();
  });
});

describe('计算图层(calc)', () => {
  const withCalc = () => setLayerCalc(twoOnMain(), 'l1', { op: '-', series: 'ust2y' });

  test('设上 / 改运算 / 去掉;字段顺序固定,导出再导入原样不变', () => {
    const doc = withCalc();
    expect(doc.panes[0].layers[0].calc).toEqual({ op: '-', series: 'ust2y' });
    expect(Object.keys(doc.panes[0].layers[0]).slice(0, 3)).toEqual(['id', 'series', 'calc']);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    expect(setLayerCalc(doc, 'l1', { op: '/', series: 'ust2y' }).panes[0].layers[0].calc?.op).toBe('/');
    expect(setLayerCalc(doc, 'l1', undefined).panes[0].layers[0].calc).toBeUndefined();
    expect(setLayerCalc(doc, 'l1', { op: '-', series: 'ust2y' })).toBe(doc);
  });

  test('序列 id 带 | @ # 的拒收(取数请求键靠它们分段)', () => {
    const raw = JSON.parse(JSON.stringify(withCalc()));
    raw.panes[0].layers[0].series = 'dgs10|-|vix';
    expect(parseChartDoc(raw)).toBeNull();
  });

  test('搜索框取消勾选 A 只删普通图层,不连带删 A − B', () => {
    const doc = withCalc();
    const both = addLayer(doc, 'SPY', '#333333');
    expect(removeSeries(both, 'SPY').panes[0].layers.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  test.each([
    ['运算不认识', { op: '*', series: 'ust2y' }],
    ['第二条序列为空', { op: '-', series: '' }],
    ['缺第二条序列', { op: '/' }],
    ['第二条序列 id 带请求键分隔符(会被误拆成平移)', { op: '-', series: 'ust2y@5' }],
  ])('%s → 拒收', (_, calc) => {
    const raw = JSON.parse(JSON.stringify(withCalc()));
    raw.panes[0].layers[0].calc = calc;
    expect(parseChartDoc(raw)).toBeNull();
  });
});
