import { describe, expect, test } from 'bun:test';
import {
  EMPTY_DOC,
  addLayer,
  moveLayer,
  nextColor,
  nextId,
  normalize,
  parseChartDoc,
  removeLayer,
  removeSeries,
  setLayerColor,
  setLayerScale,
  setStretches,
  type ChartDoc,
} from './chartDoc';

const twoOnMain = () => addLayer(addLayer(EMPTY_DOC, 'SPY', '#111111'), 'vix', '#222222');

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
    expect(e.panes[0].layers.map((l) => l.series)).toEqual(['SPY', 'dgs10']);
    expect(e.panes[1].layers.map((l) => l.series)).toEqual(['vix']);
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
    expect(e.panes.flatMap((p) => p.layers.map((l) => l.series))).toEqual(['SPY']);
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
