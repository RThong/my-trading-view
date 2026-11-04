import { describe, test, expect } from 'bun:test';
import { pointToSegmentDistance, serializeLines, parseLines, type TrendLine } from './trendlines';

describe('pointToSegmentDistance', () => {
  test('点落在线段上 → 距离 0', () => {
    expect(pointToSegmentDistance(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 5);
  });
  test('点在线段正上方 → 垂直距离', () => {
    expect(pointToSegmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 5);
  });
  test('垂足落在段外(点在端点左侧)→ 到最近端点距离', () => {
    expect(pointToSegmentDistance(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4, 5);
  });
  test('退化线段(两端点重合)→ 到该点距离', () => {
    expect(pointToSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 5);
  });
});

describe('serialize/parse round-trip', () => {
  const lines: TrendLine[] = [{ a: { logical: 10, price: 1.5 }, b: { logical: 42, price: 2.75 } }];
  test('序列化再解析 = 原对象', () => {
    expect(parseLines(serializeLines(lines))).toEqual(lines);
  });
  test('null → 空数组', () => {
    expect(parseLines(null)).toEqual([]);
  });
  test('坏 JSON → 空数组(不抛)', () => {
    expect(parseLines('{ not json')).toEqual([]);
  });
  test('非数组 JSON → 空数组', () => {
    expect(parseLines('{"a":1}')).toEqual([]);
  });
  test('数组含畸形元素([null]/[{}]/缺字段)→ 全滤掉', () => {
    expect(parseLines('[null, {}, {"a":{"logical":1}}]')).toEqual([]);
  });
  test('混合:保留形状合法的,丢弃畸形的', () => {
    const raw = JSON.stringify([{ a: { logical: 1, price: 2 }, b: { logical: 3, price: 4 } }, { a: { logical: 'x' } }]);
    expect(parseLines(raw)).toEqual([{ a: { logical: 1, price: 2 }, b: { logical: 3, price: 4 } }]);
  });
});
