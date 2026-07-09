import { describe, expect, it } from 'bun:test';
import { deepEqual } from './assetChart.hooks';

describe('deepEqual', () => {
  it('基本类型', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });
  it('数组:长度/元素', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(deepEqual([1, 2, 3], { 0: 1, 1: 2, 2: 3 })).toBe(false); // 数组≠对象
  });
  it('嵌套对象:键与值', () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false); // 键数不同
  });
  it('Spec 式结构:相等 true,改一个 data 点 false', () => {
    const mk = () => [{ key: 'ad', pane: 1, kind: 'line', color: '#fff', title: 'x',
      data: [{ time: 'd1', value: 1 }, { time: 'd2', value: 2 }] }];
    expect(deepEqual(mk(), mk())).toBe(true);
    const b = mk(); b[0].data[1].value = 99;
    expect(deepEqual(mk(), b)).toBe(false);
  });
});
