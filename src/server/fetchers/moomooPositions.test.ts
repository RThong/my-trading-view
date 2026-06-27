import { describe, test, expect } from 'bun:test';
import { mapPositions } from './moomooPositions';

describe('mapPositions', () => {
  test('把 proto Position 映射成干净结构', () => {
    const raw = [
      { code: 'AAPL', name: '苹果', qty: 100, costPrice: 180.5, price: 195.2, val: 19520, plVal: 1470, plRatio: 0.0814 },
    ];
    expect(mapPositions(raw)).toEqual([
      { code: 'AAPL', name: '苹果', qty: 100, costPrice: 180.5, price: 195.2, marketVal: 19520, plVal: 1470, plRatio: 0.0814 },
    ]);
  });

  test('缺失/非数字字段 → null,不崩(含 qty,不伪装成 0 持仓)', () => {
    const raw = [{ code: 'TSLA', name: '特斯拉', costPrice: undefined, price: null, val: 'x' }];
    const [p] = mapPositions(raw);
    expect(p.qty).toBeNull();        // 缺失 qty 不能变成真实的 0 持仓
    expect(p.costPrice).toBeNull();
    expect(p.price).toBeNull();
    expect(p.marketVal).toBeNull();
    expect(p.plVal).toBeNull();
  });

  test('空列表 → 空数组', () => {
    expect(mapPositions([])).toEqual([]);
    expect(mapPositions(undefined)).toEqual([]);
  });
});
