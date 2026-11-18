import { expect, test } from 'bun:test';
import type { Shape, ShapeOf } from '../drawings';
import { DrawingsPrimitive, type PaneDrawingState } from './drawings';
import { recordingCanvas } from './recordingCanvas.testutil';

const INK = { text: '#000000', bg: '#ffffff' };
const HLINE: Shape = { id: 'h', kind: 'hline', y: 50 };

function draw(state: Partial<PaneDrawingState>) {
  const prim = new DrawingsPrimitive(() => ({ shapes: [], selected: null, ink: INK, ...state }));
  const canvas = recordingCanvas(400, 300);
  prim.paneViews()[0].renderer()?.draw(canvas.target);

  return canvas;
}

test('水平线横贯整格宽;没选中不画手柄,选中在中点出手柄', () => {
  const plain = draw({ shapes: [HLINE] });
  expect(plain.argsOf('moveTo')).toEqual([[0, 50]]);
  expect(plain.argsOf('lineTo')).toEqual([[400, 50]]);
  expect(plain.argsOf('arc')).toEqual([]);

  const picked = draw({ shapes: [HLINE], selected: 'h' });
  expect(picked.argsOf('arc').map(([x, y]) => [x, y])).toEqual([[200, 50]]);
});

test('矩形四边 + 填色;向右延伸时右边那条竖边不画、上下边画到格子右缘', () => {
  const rect: ShapeOf<'rect'> = { id: 'r', kind: 'rect', x1: 100, y1: 40, x2: 200, y2: 120, extend: false };
  const rightEdge = [
    [200, 40],
    [200, 120],
  ];
  const closed = draw({ shapes: [rect] });
  expect(closed.segments()).toHaveLength(4);
  expect(closed.segments()).toContainEqual(rightEdge);
  expect(closed.argsOf('fill')).toHaveLength(1);

  const extended = draw({ shapes: [{ ...rect, extend: true }] });
  expect(extended.segments()).toHaveLength(3);
  expect(extended.segments()).not.toContainEqual(rightEdge);
  expect(extended.segments()).toContainEqual([
    [100, 120],
    [400, 120],
  ]);
});

test('落点预览画空心圈;测量框画底色 + 两行标签', () => {
  const preview = draw({ preview: { x: 30, y: 60 } });
  expect(preview.argsOf('arc').map(([x, y]) => [x, y])).toEqual([[30, 60]]);

  const measure = draw({ measure: { x1: 10, y1: 200, x2: 110, y2: 100, up: true, label: ['+5%', '20 根'] } });
  expect(measure.argsOf('fillRect')[0]).toEqual([10, 100, 100, 100]);
  expect(measure.argsOf('fillText').map(([t]) => t)).toEqual(['+5%', '20 根']);
});

test('hitTest:绘图工具下整格用它的光标;压在线上给移动、锁定的给手指;没压上 → null', () => {
  const at = (state: Partial<PaneDrawingState>, y: number) =>
    new DrawingsPrimitive(() => ({ shapes: [HLINE], selected: null, ink: INK, ...state })).hitTest(100, y);

  expect(at({ cursor: 'crosshair' }, 200)?.cursorStyle).toBe('crosshair');
  expect(at({}, 52)?.cursorStyle).toBe('move');
  expect(at({ shapes: [{ ...HLINE, locked: true }] }, 52)?.cursorStyle).toBe('pointer');
  expect(at({}, 200)).toBeNull();
});
