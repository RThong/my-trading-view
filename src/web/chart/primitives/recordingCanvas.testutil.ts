// 测试用:假的 canvas 绘制目标,把图元 renderer 调过的 ctx 方法和参数记下来(不真画),断言「画在哪」。
// 属性赋值(fillStyle 等)照存;measureText 按每字 10px 给宽度。只给 *.test.ts 用
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

type Call = [name: string, args: unknown[]];

export function recordingCanvas(width = 400, height = 300) {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {};
  const context = new Proxy(props, {
    get: (t, k) =>
      typeof k === 'string' && k in t
        ? t[k]
        : (...args: unknown[]) => {
            calls.push([String(k), args]);
            return k === 'measureText' ? { width: 10 * String(args[0]).length } : undefined;
          },
    set: (t, k, v) => {
      t[String(k)] = v;
      return true;
    },
  });
  const target = {
    useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;

  /** 某个方法被调用时的参数,按调用顺序 */
  const argsOf = (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args);
  /**
   * 描出来的线段 [起点, 终点]:每个 lineTo 配它之前的落笔点(moveTo 或上一个 lineTo),只算最后 stroke() 的路径
   * —— 首尾相接的线段只有一个 moveTo,单看 lineTo 认不出是哪一段;填色的多边形也走 moveTo / lineTo,不能算成线
   */
  const segments = () => {
    const out: unknown[][] = [];
    let path: unknown[][] = [];
    let pen: unknown[] | null = null;
    calls.forEach(([n, args]) => {
      if (n === 'beginPath') path = [];
      if (n === 'lineTo' && pen) path.push([pen, args]);
      if (n === 'moveTo' || n === 'lineTo') pen = args;
      if (n === 'stroke') out.push(...path);
    });

    return out;
  };

  return { target, argsOf, segments };
}
