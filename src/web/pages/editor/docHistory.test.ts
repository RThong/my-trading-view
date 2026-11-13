import { describe, expect, test } from 'bun:test';
import { EMPTY_DOC, type ChartDoc, type Drawing } from '../../views/chartDoc/chartDoc';
import { commit, drawingEditLabel, initHistory, redo, undo } from './docHistory';

// 只当不同的文档对象用(历史只比引用、不看内容)
function doc(n: number): ChartDoc {
  return { ...EMPTY_DOC, panes: [], stamp: n } as ChartDoc;
}
const [d0, d1, d2, d3] = [0, 1, 2, 3].map(doc);

describe('docHistory', () => {
  test('记步、撤销、重做往返;提示名跟着那一步走', () => {
    const h = commit(commit(initHistory(d0), d1, '加线', 0), d2, '改颜色', 1000);
    const u = undo(h);
    expect(u.doc).toBe(d1);
    expect(u.past.at(-1)?.label).toBe('加线');
    expect(u.future[0]?.label).toBe('改颜色');

    const r = redo(u);
    expect(r.doc).toBe(d2);
    expect(r.past.at(-1)?.label).toBe('改颜色');
    expect(r.future).toEqual([]);
  });

  test('新的一步清空重做;没改动文档不记;到头了撤销 / 重做原样返回', () => {
    const u = undo(commit(commit(initHistory(d0), d1, 'a', 0), d2, 'b', 1000));
    expect(commit(u, d3, 'c', 2000).future).toEqual([]);
    expect(commit(u, u.doc, 'noop', 2000)).toBe(u);

    const empty = initHistory(d0);
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
  });

  test('同一合并键 500ms 内并成一步,超时或换键另起一步', () => {
    const h = commit(
      commit(commit(initHistory(d0), d1, '改颜色', 0, 'k'), d2, '改颜色', 300, 'k'),
      d3,
      '改颜色',
      600,
      'k',
    );
    expect(h.past.map((s) => s.doc)).toEqual([d0]);
    expect(undo(h).doc).toBe(d0);

    expect(commit(commit(initHistory(d0), d1, 'x', 0, 'k'), d2, 'x', 600, 'k').past).toHaveLength(2);
    expect(commit(commit(initHistory(d0), d1, 'x', 0, 'k'), d2, 'x', 100, 'other').past).toHaveLength(2);
  });

  test('最多留 100 步', () => {
    const h = Array.from({ length: 120 }, (_, i) => doc(i + 10)).reduce(
      (acc, d, i) => commit(acc, d, `s${i}`, i * 1000),
      initHistory(d0),
    );
    expect(h.past).toHaveLength(100);
    expect(h.past[0].label).toBe('s20');
  });
});

describe('drawingEditLabel', () => {
  const trend: Drawing = {
    id: 'd1',
    kind: 'trend',
    a: { time: '2026-01-05', value: 15 },
    b: { time: '2026-02-02', value: 20 },
  };

  test('按变了的字段定名;颜色带合并键', () => {
    expect(drawingEditLabel(trend, { ...trend, locked: true }).label).toBe('锁定画线');
    expect(drawingEditLabel({ ...trend, locked: true }, trend).label).toBe('解锁画线');
    expect(drawingEditLabel(trend, { ...trend, color: '#2962ff' })).toEqual({
      label: '改画线颜色',
      mergeKey: 'drawing-color:d1',
    });
    expect(drawingEditLabel(trend, { ...trend, a: { time: '2026-01-06', value: 15 } }).label).toBe('移动画线');
    expect(drawingEditLabel({ ...trend, kind: 'rect' }, { ...trend, kind: 'rect', extend: true }).label).toBe(
      '修改画线',
    );
  });
});
