import { describe, expect, test } from 'bun:test';
import { hitShapes, rayEnd, timeAxis } from './drawings';

describe('timeAxis', () => {
  // 周线:每周一根(7 天一根)
  const axis = timeAxis(['2026-01-12', '2026-01-05', '2026-01-19', '2026-01-05']);

  test('图上的点 = 整数下标(乱序、重复也按并集排好)', () => {
    expect(axis.toLogical('2026-01-05')).toBe(0);
    expect(axis.toLogical('2026-01-19')).toBe(2);
  });

  test('两根之间按日历天插值;两端之外按中位间隔外推', () => {
    expect(axis.toLogical('2026-01-08')).toBeCloseTo(3 / 7);
    expect(axis.toLogical('2026-01-26')).toBe(3);
    expect(axis.toLogical('2025-12-29')).toBe(-1);
  });

  test('下标 → 日期取整到天,与 toLogical 互逆', () => {
    ['2026-01-08', '2026-02-02', '2025-12-20', '2026-01-12'].forEach((d) => {
      expect(axis.toTime(axis.toLogical(d)!)).toBe(d);
    });
  });

  test('空轴两边都是 null', () => {
    expect(timeAxis([]).toLogical('2026-01-05')).toBeNull();
    expect(timeAxis([]).toTime(0)).toBeNull();
  });
});

describe('hitShapes', () => {
  const shapes = [
    { id: 't', kind: 'trend' as const, x1: 0, y1: 0, x2: 100, y2: 100 },
    { id: 'h', kind: 'hline' as const, y: 200 },
    { id: 'v', kind: 'vline' as const, x: 300 },
  ];

  test('端点优先于线身;离线太远不算', () => {
    expect(hitShapes(shapes, 2, 1)).toMatchObject({ id: 't', part: 'a' });
    expect(hitShapes(shapes, 99, 98)).toMatchObject({ id: 't', part: 'b' });
    expect(hitShapes(shapes, 50, 52)).toMatchObject({ id: 't', part: 'body' });
    expect(hitShapes(shapes, 50, 80)).toBeNull();
  });

  test('水平线按 y、竖线按 x,取最近的那条', () => {
    expect(hitShapes(shapes, 500, 203)).toMatchObject({ id: 'h', part: 'body' });
    expect(hitShapes(shapes, 302, 190)).toMatchObject({ id: 'v' });
  });
});

describe('射线 / 水平射线', () => {
  test('rayEnd:沿起点→第二点的方向延伸到很远;第二点在左边就往左;两点重合停在原地', () => {
    const right = rayEnd(0, 0, 3, 4);
    expect(right.x / right.y).toBeCloseTo(3 / 4);
    expect(right.x).toBeGreaterThan(10_000);

    expect(rayEnd(100, 100, 50, 100).x).toBeLessThan(-10_000);
    expect(rayEnd(5, 5, 5, 5)).toEqual({ x: 5, y: 5 });
  });

  test('rayEnd:起点在画布外很远(早年画的射线放大后滚到最新),远端仍越过画布', () => {
    expect(rayEnd(-500_000, 100, -499_990, 100).x).toBeGreaterThan(10_000);
  });

  test('射线过了第二点仍点得中;起点反方向点不中', () => {
    const shapes = [{ id: 'r', kind: 'ray' as const, x1: 0, y1: 0, x2: 100, y2: 0 }];
    expect(hitShapes(shapes, 400, 3)).toMatchObject({ id: 'r', part: 'body' });
    expect(hitShapes(shapes, 99, 1)).toMatchObject({ id: 'r', part: 'b' });
    expect(hitShapes(shapes, -50, 0)).toBeNull();
  });

  test('水平射线:起点是手柄,往右的线身点得中,起点左边点不中', () => {
    const shapes = [{ id: 'hr', kind: 'hray' as const, x: 100, y: 50 }];
    expect(hitShapes(shapes, 102, 51)).toMatchObject({ id: 'hr', part: 'a' });
    expect(hitShapes(shapes, 600, 54)).toMatchObject({ id: 'hr', part: 'body' });
    expect(hitShapes(shapes, 40, 50)).toBeNull();
  });
});
