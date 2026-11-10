import { describe, expect, test } from 'bun:test';
import {
  EMPTY_DOC,
  addLayer,
  applyLayerFit,
  clearLayerFit,
  setLayerHidden,
  setLayerRender,
  liveScaleIds,
  isMarkLayer,
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
  addIndicator,
  setIndicatorPeriods,
  findLayer,
  addDrawing,
  allDrawings,
  clearDrawings,
  removeDrawing,
  updateDrawing,
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

  test('画法:signed / events 往返解析保留,setLayerRender 设回折线删字段;addLayer 可带画法', () => {
    const d = setLayerRender(twoOnMain(), 'l2', { kind: 'signed' });
    expect(d.panes[0].layers[1].render).toEqual({ kind: 'signed' });
    expect(setLayerRender(d, 'l2', { kind: 'signed' })).toBe(d);
    expect('render' in setLayerRender(d, 'l2', undefined).panes[0].layers[1]).toBe(false);
    expect(parseChartDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);

    const candle = setLayerRender(twoOnMain(), 'l1', { kind: 'candle' });
    expect(parseChartDoc(JSON.parse(JSON.stringify(candle)))).toEqual(candle);
    // 蜡烛图层改成计算图层:没有 K 线了,画法退回折线
    expect('render' in setLayerCalc(candle, 'l1', { op: '-', series: 'vix' }).panes[0].layers[0]).toBe(false);

    const bg = setLayerRender(twoOnMain(), 'l2', { kind: 'background' });
    expect(parseChartDoc(JSON.parse(JSON.stringify(bg)))).toEqual(bg);
    expect(isMarkLayer(bg.panes[0].layers[1])).toBe(true);

    const op = setLayerRender(twoOnMain(), 'l2', { kind: 'events', opacity: 0.35 });
    expect(parseChartDoc(JSON.parse(JSON.stringify(op)))).toEqual(op);

    const e = addLayer(twoOnMain(), 'coreCpiRelease', '#333333', { kind: 'events' });
    expect(e.panes[0].layers[2]).toMatchObject({ series: 'coreCpiRelease', render: { kind: 'events' } });
    expect(parseChartDoc(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  test('liveScaleIds:竖线占的独立轴 lw-charts 里没有,不列(对它调 priceScale 会抛)', () => {
    const d = addLayer(twoOnMain(), 'coreCpiRelease', '#333333', { kind: 'events' });
    const withOverlay = { ...d.panes[0], scales: [...d.panes[0].scales, { id: 's9', side: 'overlay' as const }] };
    withOverlay.layers = withOverlay.layers.map((l) => (l.series === 'coreCpiRelease' ? { ...l, scale: 's9' } : l));
    expect(liveScaleIds(withOverlay)).toEqual(['right']);
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
      { desc: '说明' },
    );
    expect(parseChartDoc(ok)).toEqual(ok as ChartDoc);
    // 旧版存档带格子短名 label(已删的字段):照样载入,字段丢掉
    expect(parseChartDoc(base({}, { label: 'VIX' }))?.panes[0]).not.toHaveProperty('label');
  });

  test.each([
    ['render.kind 不认识', { render: { kind: 'ohlc-bars' } }],
    ['竖线透明度须在 (0, 1]', { render: { kind: 'events', opacity: 0 } }],
    ['竖线透明度不能大于 1', { render: { kind: 'events', opacity: 1.5 } }],
    ['step 只能是 true', { render: { kind: 'line', step: false } }],
    ['参考线颜色须 #rrggbb', { refLines: [{ price: 1, title: 'x', color: 'red' }] }],
    ['参考线缺价位', { refLines: [{ title: 'x' }] }],
    ['riskTail 只有 low / high', { percentile: { riskTail: 'mid' } }],
    ['since 须是真日期', { percentile: { since: '2026-13-01' } }],
    ['title 不能是空串', { title: '' }],
  ])('图层:%s → 拒收', (_, patch) => {
    expect(parseChartDoc(base(patch))).toBeNull();
  });

  test.each([['desc 须是字符串', { desc: 1 }]])('格:%s → 拒收', (_, patch) => {
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

describe('指标图层', () => {
  const sc = [{ id: 'right', side: 'right' as const }];
  const base: ChartDoc = {
    v: 1,
    panes: [
      { id: 'p1', stretch: 2, scales: sc, layers: [{ id: 'l1', series: 'SPY', scale: 'right', color: '#3987e5' }] },
      { id: 'p2', stretch: 1, scales: sc, layers: [{ id: 'l2', series: 'vix', scale: 'right', color: '#e66767' }] },
    ],
  };

  test('叠加类(EMA / 布林带)放在源线同格同轴、紧跟其后;振荡类(MACD / RSI)在源线那格下方新开一格', () => {
    const ema = addIndicator(base, 'l1', 'ema');
    expect(ema.panes[0].layers.map((l) => [l.series, l.indicator?.id, l.scale])).toEqual([
      ['SPY', undefined, 'right'],
      ['SPY', 'ema', 'right'],
    ]);
    const rsiDoc = addIndicator(base, 'l1', 'rsi');
    expect(rsiDoc.panes.map((p) => p.layers.map((l) => l.indicator?.id ?? l.series))).toEqual([
      ['SPY'],
      ['rsi'],
      ['vix'],
    ]);
  });

  test('改周期写进 indicator.periods;清空回默认;非指标图层不动', () => {
    const doc = addIndicator(base, 'l1', 'ema');
    const id = doc.panes[0].layers[1].id;
    expect(findLayer(setIndicatorPeriods(doc, id, [10, 30]), id)?.layer.indicator).toEqual({
      id: 'ema',
      periods: [10, 30],
    });
    expect(findLayer(setIndicatorPeriods(doc, id, undefined), id)?.layer.indicator).toEqual({ id: 'ema' });
    expect(setIndicatorPeriods(doc, 'l1', [10])).toBe(doc);
  });

  test('JSON 校验:认识的指标 id、周期是 1~1000 的整数(最多 10 个);导出再导入原样不变', () => {
    const doc = addIndicator(addIndicator(base, 'l1', 'ema'), 'l1', 'macd');
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const withInd = (indicator: unknown) => ({
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 1,
          scales: sc,
          layers: [{ id: 'l1', series: 'SPY', scale: 'right', color: '#3987e5', indicator }],
        },
      ],
    });
    expect(parseChartDoc(withInd({ id: 'ema', periods: [5, 20] }))).not.toBeNull();
    expect(parseChartDoc(withInd({ id: 'kdj' }))).toBeNull();
    expect(parseChartDoc(withInd({ id: 'ema', periods: [0] }))).toBeNull();
    expect(parseChartDoc(withInd({ id: 'ema', periods: [] }))).toBeNull();
    expect(parseChartDoc(withInd({ id: 'rsi', periods: [6.5] }))).toBeNull();
    // 重复周期会展开出同 id 的两条子线;布林带 / MACD 参数固定,不收 periods
    expect(parseChartDoc(withInd({ id: 'ema', periods: [5, 5] }))).toBeNull();
    expect(parseChartDoc(withInd({ id: 'bb', periods: [20] }))).toBeNull();
    const markWithInd = withInd({ id: 'ema' });
    (markWithInd.panes[0].layers[0] as Record<string, unknown>).render = { kind: 'events' };
    expect(parseChartDoc(markWithInd)).toBeNull();
  });

  test('改周期:非法的(重复)不改', () => {
    const doc = addIndicator(base, 'l1', 'ema');
    const id = doc.panes[0].layers[1].id;
    expect(setIndicatorPeriods(doc, id, [5, 5])).toBe(doc);
  });

  test('叠加对比里被对齐的 B 腿:叠加类指标挂不上去(会拆掉叠加),振荡类照加;指标不再套指标', () => {
    const fit = { target: 'l1', start: '2026-01-01', end: '2026-06-01', alpha: 0, beta: 1, r: 0.9 };
    const withFit: ChartDoc = {
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 2,
          scales: [...sc, { id: 's1', side: 'overlay' }],
          layers: [
            { id: 'l1', series: 'SPY', scale: 'right', color: '#3987e5' },
            { id: 'l2', series: 'vix', scale: 's1', color: '#e66767', fit },
          ],
        },
      ],
    };
    expect(addIndicator(withFit, 'l2', 'ema')).toBe(withFit);
    expect(findLayer(addIndicator(withFit, 'l2', 'rsi'), 'l2')?.layer.fit).toEqual(fit);
    expect(addIndicator(withFit, 'l2', 'rsi').panes).toHaveLength(2);
    // 跟着源线平移
    const shifted: ChartDoc = {
      ...base,
      panes: [{ ...base.panes[0], layers: [{ ...base.panes[0].layers[0], shift: 20 }] }, base.panes[1]],
    };
    expect(addIndicator(shifted, 'l1', 'ema').panes[0].layers[1].shift).toBe(20);
    const ema = addIndicator(base, 'l1', 'ema');
    expect(addIndicator(ema, ema.panes[0].layers[1].id, 'rsi')).toBe(ema);
    // 标记图层(竖线、色带)的值只是 0 / 1 标志:不加指标
    const marks: ChartDoc = {
      v: 1,
      panes: [
        {
          id: 'p1',
          stretch: 1,
          scales: sc,
          layers: [
            { id: 'l1', series: 'coreCpiRelease', scale: 'right', color: '#facc15', render: { kind: 'events' } },
          ],
        },
      ],
    };
    expect(addIndicator(marks, 'l1', 'rsi')).toBe(marks);
  });
});

describe('画线', () => {
  const base = addLayer(addLayer(EMPTY_DOC, 'vix', '#ff0000'), 'spy', '#00ff00');
  const vix = base.panes[0].layers[0].id;
  const trend = {
    id: 'd1',
    kind: 'trend' as const,
    a: { time: '2026-01-05', value: 15 },
    b: { time: '2026-02-02', value: 20 },
  };

  test('加到图层上,id 进 nextId 序列;JSON 往返无损', () => {
    const doc = addDrawing(base, vix, trend);
    expect(findLayer(doc, vix)?.layer.drawings).toEqual([trend]);
    expect(nextId(doc, 'd')).toBe('d2');
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  test('改 / 删 / 清空;删光了不留空数组', () => {
    const doc = addDrawing(addDrawing(base, vix, trend), vix, { id: 'd2', kind: 'vline', time: '2026-03-18' });
    const moved = updateDrawing(doc, { id: 'd2', kind: 'vline', time: '2026-03-18', paneOnly: true });
    expect(allDrawings(moved).map((e) => e.drawing)).toContainEqual({
      id: 'd2',
      kind: 'vline',
      time: '2026-03-18',
      paneOnly: true,
    });
    expect(allDrawings(removeDrawing(doc, 'd1')).map((e) => e.drawing.id)).toEqual(['d2']);
    expect(findLayer(clearDrawings(doc), vix)?.layer).not.toHaveProperty('drawings');
  });

  test('id 已被占用(画线或图层)就不加,免得存档载不回来', () => {
    const doc = addDrawing(base, vix, trend);
    expect(addDrawing(doc, vix, { id: 'd1', kind: 'hline', value: 1 })).toBe(doc);
    expect(addDrawing(doc, vix, { id: vix, kind: 'hline', value: 1 })).toBe(doc);
  });

  test('删图层连同它的画线;隐藏的线不能挂', () => {
    const doc = addDrawing(base, vix, trend);
    expect(allDrawings(removeLayer(doc, vix))).toEqual([]);
    expect(addDrawing(setLayerHidden(base, vix, true), vix, trend)).toEqual(setLayerHidden(base, vix, true));
  });

  test('校验:坏日期的画线丢掉那一条,画线 id 与图层重名整张拒收', () => {
    const doc = addDrawing(base, vix, trend);
    const bad = (d: unknown) => {
      const raw = JSON.parse(JSON.stringify(doc));
      raw.panes[0].layers[0].drawings = [d];
      const parsed = parseChartDoc(raw);
      // 坏画线只丢那一条:图照常载入、这一条不在;整张图拒收时是 null
      return parsed && allDrawings(parsed).length;
    };
    expect(bad({ ...trend, a: { time: '2026-02-30', value: 1 } })).toBe(0);
    expect(bad({ ...trend, id: vix })).toBeNull();
    expect(bad({ id: 'd9', kind: 'vline', time: '2026-01-05', paneOnly: false })).toBe(0);
    expect(bad({ id: 'd9', kind: 'hline', value: 3 })).toBe(1);
  });

  test('射线 / 水平射线:往返保留,缺点或坏点的丢掉', () => {
    const ray = { ...trend, id: 'd2', kind: 'ray' as const };
    const hray = { id: 'd3', kind: 'hray' as const, a: { time: '2026-03-02', value: 21.5 } };
    const doc = addDrawing(addDrawing(base, vix, ray), vix, hray);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(allDrawings(doc).map((e) => e.drawing)).toEqual([ray, hray]);

    const bad = (d: unknown) => {
      const raw = JSON.parse(JSON.stringify(doc));
      raw.panes[0].layers[0].drawings = [d];
      const parsed = parseChartDoc(raw);
      // 坏画线只丢那一条:图照常载入、这一条不在;整张图拒收时是 null
      return parsed && allDrawings(parsed).length;
    };
    expect(bad({ id: 'd9', kind: 'ray', a: ray.a })).toBe(0);
    expect(bad({ id: 'd9', kind: 'hray', value: 3 })).toBe(0);
    expect(bad({ ...hray, a: { time: '2026-13-01', value: 1 } })).toBe(0);
  });

  test('文字:往返保留(含多行、加框),空文字 / box 非 true 的丢掉', () => {
    const text = {
      id: 'd5',
      kind: 'text' as const,
      a: { time: '2026-02-10', value: 25 },
      text: 'FOMC\n加息 25bp',
      box: true as const,
    };
    const doc = addDrawing(base, vix, text);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    const bad = (d: unknown) => {
      const raw = JSON.parse(JSON.stringify(doc));
      raw.panes[0].layers[0].drawings = [d];
      const parsed = parseChartDoc(raw);
      // 坏画线只丢那一条:图照常载入、这一条不在;整张图拒收时是 null
      return parsed && allDrawings(parsed).length;
    };
    expect(bad({ ...text, text: '   ' })).toBe(0);
    expect(bad({ ...text, box: false })).toBe(0);
  });

  test('标注气泡:尖 a、框 b、多行文字往返保留;空文字 / 缺 b 的丢掉,多余字段去掉', () => {
    const callout = {
      id: 'd6',
      kind: 'callout' as const,
      a: { time: '2026-02-10', value: 25 },
      b: { time: '2026-01-20', value: 30 },
      text: '这里见顶\n第二行',
    };
    const doc = addDrawing(base, vix, callout);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    const parse = (d: unknown) => {
      const raw = JSON.parse(JSON.stringify(doc));
      raw.panes[0].layers[0].drawings = [d];
      const parsed = parseChartDoc(raw);
      return parsed && allDrawings(parsed).map((e) => e.drawing);
    };
    expect(parse({ ...callout, text: ' \n ' })).toEqual([]);
    expect(parse({ ...callout, b: undefined })).toEqual([]);
    expect(parse({ ...callout, box: true })).toEqual([callout]);
  });

  test('矩形:对角两点往返保留(含向右延伸),缺 b / extend 非 true 的丢掉', () => {
    const rect = {
      id: 'd7',
      kind: 'rect' as const,
      a: { time: '2026-01-20', value: 30 },
      b: { time: '2026-02-10', value: 25 },
      extend: true as const,
    };
    const doc = addDrawing(base, vix, rect);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    const count = (d: unknown) => {
      const raw = JSON.parse(JSON.stringify(doc));
      raw.panes[0].layers[0].drawings = [d];
      const parsed = parseChartDoc(raw);
      return parsed && allDrawings(parsed).length;
    };
    expect(count({ ...rect, b: undefined })).toBe(0);
    expect(count({ ...rect, extend: false })).toBe(0);
  });

  test('平行通道:三个点往返保留,缺 c 的丢掉', () => {
    const channel = { ...trend, id: 'd4', kind: 'channel' as const, c: { time: '2026-02-10', value: 25 } };
    const doc = addDrawing(base, vix, channel);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);

    const raw = JSON.parse(JSON.stringify(doc));
    raw.panes[0].layers[0].drawings = [{ ...trend, id: 'd9', kind: 'channel' }];
    expect(parseChartDoc(raw)).toEqual(base);
  });

  test('认不出的画线种类(别的版本存的)只丢那一条,同图层的其它画线和整张图照常载入', () => {
    const doc = addDrawing(base, vix, trend);
    const raw = JSON.parse(JSON.stringify(doc));
    raw.panes[0].layers[0].drawings.push({ id: 'd9', kind: 'signpost', a: trend.a, text: '未来的画线' });
    expect(parseChartDoc(raw)).toEqual(doc);
  });
});

describe('画线与标记图层', () => {
  const base = addLayer(EMPTY_DOC, 'vix', '#ff0000');
  const id = base.panes[0].layers[0].id;
  const doc = addDrawing(base, id, { id: 'd1', kind: 'hline', value: 20 });

  test('改成竖线 / 色带时画线跟着丢,存档仍能载回', () => {
    const marked = setLayerRender(doc, id, { kind: 'events' });
    expect(findLayer(marked, id)?.layer).not.toHaveProperty('drawings');
    expect(parseChartDoc(JSON.parse(JSON.stringify(marked)))).not.toBeNull();
  });

  test('导入时标记图层带画线拒收', () => {
    const raw = JSON.parse(JSON.stringify(doc));
    raw.panes[0].layers[0].render = { kind: 'background' };
    expect(parseChartDoc(raw)).toBeNull();
  });
});

test('画线:日期超出 0000–9999 年(外推太远)的不写进文档', () => {
  const base = addLayer(EMPTY_DOC, 'vix', '#ff0000');
  const id = base.panes[0].layers[0].id;
  expect(addDrawing(base, id, { id: 'd1', kind: 'vline', time: '-000282-08-01' })).toBe(base);
  const doc = addDrawing(base, id, { id: 'd1', kind: 'vline', time: '2026-01-05' });
  expect(updateDrawing(doc, { id: 'd1', kind: 'vline', time: '+01702-01-01' })).toBe(doc);
});
