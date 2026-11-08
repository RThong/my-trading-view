import { describe, expect, test } from 'bun:test';
import { hitShapes, timeAxis } from './drawings';

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
