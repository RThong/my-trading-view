import { describe, expect, test } from 'bun:test';
import {
  calloutPointer,
  channelOffset,
  hitCursor,
  hitShapes,
  RECT_EDGES,
  rayEnd,
  rectHandleAt,
  resizeCursor,
  textSize,
  timeAxis,
} from './drawings';

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

describe('平行通道', () => {
  // 底边 (0,100)→(200,0),第三点 (100,90):底边在 x=100 处 y=50,平行线往下偏 40
  const ch = { id: 'c', kind: 'channel' as const, x1: 0, y1: 100, x2: 200, y2: 0, x3: 100, y3: 90 };

  test('channelOffset:第三点到底边同一横坐标处的竖直距离;底边竖直时为 0', () => {
    expect(channelOffset(ch)).toBe(40);
    expect(channelOffset({ ...ch, x2: 0 })).toBe(0);
  });

  test('命中:端点 a / b、平行线中点的宽度手柄 c、两条边、通道里面都点得中;外面点不中', () => {
    expect(hitShapes([ch], 1, 99)).toMatchObject({ part: 'a' });
    expect(hitShapes([ch], 100, 91)).toMatchObject({ part: 'c' });
    expect(hitShapes([ch], 150, 66)).toMatchObject({ part: 'body' });
    expect(hitShapes([ch], 50, 95)).toMatchObject({ part: 'body' });
    expect(hitShapes([ch], 50, 130)).toBeNull();
    expect(hitShapes([ch], 250, 20)).toBeNull();
  });
});

describe('文字', () => {
  test('textSize:多行按最宽那行 + 两侧留白,高度按行数(单测没 DOM,按字符估宽)', () => {
    const one = textSize(['FOMC']);
    const two = textSize(['FOMC', '加息 25bp']);
    expect(two.w).toBeGreaterThan(one.w);
    expect(two.h).toBeGreaterThan(one.h);
  });

  test('命中:左上角是手柄,整块范围内算线身,范围外点不中', () => {
    const t = { id: 't', kind: 'text' as const, x: 100, y: 100, lines: ['FOMC'], box: false, w: 60, h: 24 };
    expect(hitShapes([t], 101, 101)).toMatchObject({ part: 'a' });
    expect(hitShapes([t], 140, 115)).toMatchObject({ part: 'body' });
    expect(hitShapes([t], 170, 115)).toBeNull();
  });
});

describe('标注气泡', () => {
  // 尖在 (300,300),框中心 (100,100)、宽 80 高 24 → 框占 x 60~140、y 88~112
  const c = {
    id: 'c',
    kind: 'callout' as const,
    x1: 300,
    y1: 300,
    x2: 100,
    y2: 100,
    lines: ['见顶'],
    w: 80,
    h: 24,
  };

  test('命中:尖是手柄 a;框里算 b(只挪框);指针附近算线身(整个挪);别处点不中', () => {
    expect(hitShapes([c], 299, 301)).toMatchObject({ part: 'a' });
    expect(hitShapes([c], 65, 90)).toMatchObject({ part: 'b' });
    expect(hitShapes([c], 200, 202)).toMatchObject({ part: 'body' });
    expect(hitShapes([c], 300, 100)).toBeNull();
  });

  test('calloutPointer:根部在框中心两侧、垂直于指向,尖在 a;半宽不超过半个框高;尖和中心重合 → null', () => {
    const right = calloutPointer({ x1: 200, y1: 100, x2: 100, y2: 100, h: 24 });
    expect(right).toEqual([
      [100, 110],
      [100, 90],
      [200, 100],
    ]);
    const low = calloutPointer({ x1: 200, y1: 100, x2: 100, y2: 100, h: 10 });
    expect(low?.[0][1]).toBe(104);
    expect(calloutPointer({ x1: 100, y1: 100, x2: 100, y2: 100, h: 24 })).toBeNull();
  });
});

describe('矩形', () => {
  // 对角 (300,200) / (100,100):框占 x 100~300、y 100~200
  const r = { id: 'r', kind: 'rect' as const, x1: 300, y1: 200, x2: 100, y2: 100, extend: false };

  test('命中:8 个手柄(四角 + 四边中点)优先;只有四条边附近算线身,框里、框外都点不中(同 TradingView)', () => {
    expect(hitShapes([r], 101, 99)).toMatchObject({ part: 'nw' });
    expect(hitShapes([r], 299, 201)).toMatchObject({ part: 'se' });
    expect(hitShapes([r], 200, 101)).toMatchObject({ part: 'n' });
    expect(hitShapes([r], 99, 150)).toMatchObject({ part: 'w' });
    expect(hitShapes([r], 260, 103)).toMatchObject({ part: 'body', dist: 3 });
    expect(hitShapes([r], 104, 130)).toMatchObject({ part: 'body', dist: 4 });
    expect(hitShapes([r], 200, 150)).toBeNull();
    expect(hitShapes([r], 200, 220)).toBeNull();
    expect(hitShapes([r], 400, 150)).toBeNull();
  });

  test('向右延伸:上下边一直延伸到右边、没有右边线;手柄仍在原来的框上;价格带中间点不中', () => {
    const ext = { ...r, extend: true };
    expect(hitShapes([ext], 400, 102)).toMatchObject({ part: 'body' });
    expect(hitShapes([ext], 300, 150)).toMatchObject({ part: 'e' });
    expect(hitShapes([ext], 330, 150)).toBeNull();
    expect(hitShapes([ext], 400, 150)).toBeNull();
    expect(hitShapes([ext], 50, 150)).toBeNull();
  });

  test('rectHandleAt / RECT_EDGES:角取两条邻边,边中点只取一条、另一方向取中点', () => {
    const box = { l: 100, r: 300, t: 100, b: 200 };
    expect(rectHandleAt(box, 'ne')).toEqual([300, 100]);
    expect(rectHandleAt(box, 's')).toEqual([200, 200]);
    expect(RECT_EDGES.e).toEqual({ x: 'r' });
  });
});

describe('悬停光标', () => {
  test('resizeCursor:按方向取最近的双向箭头,正反同一个', () => {
    expect(resizeCursor(10, 0)).toBe('ew-resize');
    expect(resizeCursor(-10, 1)).toBe('ew-resize');
    expect(resizeCursor(0, 10)).toBe('ns-resize');
    expect(resizeCursor(10, 10)).toBe('nwse-resize');
    expect(resizeCursor(-10, -10)).toBe('nwse-resize');
    expect(resizeCursor(-10, 10)).toBe('nesw-resize');
  });

  test('hitCursor:线身移动;端点 / 角按对面那一点 → 这一点;通道宽度竖向;单点画线移动', () => {
    const rect = { id: 'r', kind: 'rect' as const, x1: 300, y1: 200, x2: 100, y2: 100, extend: false };
    expect(hitCursor(rect, 'body')).toBe('move');
    expect(hitCursor(rect, 'nw')).toBe('nwse-resize');
    expect(hitCursor(rect, 'sw')).toBe('nesw-resize');
    expect(hitCursor(rect, 'n')).toBe('ns-resize');
    expect(hitCursor(rect, 'e')).toBe('ew-resize');
    const trend = { id: 't', kind: 'trend' as const, x1: 0, y1: 100, x2: 200, y2: 100 };
    expect(hitCursor(trend, 'b')).toBe('ew-resize');
    expect(hitCursor({ ...trend, kind: 'channel' as const, x3: 100, y3: 50 }, 'c')).toBe('ns-resize');
    expect(hitCursor({ id: 'h', kind: 'hray' as const, x: 10, y: 10 }, 'a')).toBe('move');
    const callout = {
      id: 'c',
      kind: 'callout' as const,
      x1: 300,
      y1: 300,
      x2: 100,
      y2: 100,
      lines: ['x'],
      w: 64,
      h: 24,
    };
    expect(hitCursor(callout, 'b')).toBe('move');
    expect(hitCursor(callout, 'a')).toBe('nwse-resize');
  });
});

describe('回归通道', () => {
  const reg = {
    id: 'g',
    kind: 'regression' as const,
    x1: 100,
    y1: 200,
    x2: 300,
    y2: 100,
    mid: [
      [100, 200],
      [300, 100],
    ] as [number, number][],
    up: [
      [100, 150],
      [300, 50],
    ] as [number, number][],
    down: [
      [100, 250],
      [300, 150],
    ] as [number, number][],
    r: 0.8,
  };

  test('命中:中线两端是手柄;中线 / 上下轨附近算线身;两轨之间、外面点不中', () => {
    expect(hitShapes([reg], 101, 201)).toMatchObject({ part: 'a' });
    expect(hitShapes([reg], 299, 99)).toMatchObject({ part: 'b' });
    expect(hitShapes([reg], 200, 152)).toMatchObject({ part: 'body' });
    expect(hitShapes([reg], 200, 100)).toMatchObject({ part: 'body' });
    expect(hitShapes([reg], 200, 125)).toBeNull();
    expect(hitShapes([reg], 400, 100)).toBeNull();
  });
});
