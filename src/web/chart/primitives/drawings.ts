// 手画线画在格子上的图元(lw 格级插件 IPanePrimitive):按 kind 算像素几何、描线 / 填色 / 写字 / 手柄,测量框和落点预览。
// 纯计算(时间轴、命中、光标)见 chart/drawings,交互见编辑器 useDrawings。
import type {
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  calloutBox,
  calloutPointer,
  channelOffset,
  DRAWING_COLOR,
  HANDLE_R,
  hitCursor,
  hitShapes,
  LINE_DASH,
  type Pt,
  rayEnd,
  rectBounds,
  type RectHandle,
  rectHandleAt,
  segments,
  type Shape,
  type ShapeOf,
  type Size,
  TEXT_FONT,
  TEXT_LINE,
  TEXT_PAD,
  type TwoPoints,
} from '../drawings';
import { SIGNED_DOWN, SIGNED_UP } from '../palette';

/** 一种画线在这一格里怎么画:几段实线 + 可选的虚线(通道中线)/ 填色区域 + 选中时手柄的位置 */
type Geom = {
  lines: [Pt, Pt][];
  dashed?: [Pt, Pt][];
  fill?: Pt[];
  handles: Pt[];
  squares?: Pt[];
  /** 画线旁的一行小字(回归通道的相关系数),左上角在 at */
  label?: { at: Pt; text: string };
};

function twoPointGeom(s: TwoPoints, to: Pt): Geom {
  return {
    lines: [[[s.x1, s.y1], to]],
    handles: [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ],
  };
}

function channelGeom(s: ShapeOf<'channel'>): Geom {
  const off = channelOffset(s);
  const [a, b]: Pt[] = [
    [s.x1, s.y1],
    [s.x2, s.y2],
  ];
  const [a2, b2]: Pt[] = [
    [s.x1, s.y1 + off],
    [s.x2, s.y2 + off],
  ];

  return {
    lines: [
      [a, b],
      [a2, b2],
    ],
    dashed: [
      [
        [s.x1, s.y1 + off / 2],
        [s.x2, s.y2 + off / 2],
      ],
    ],
    fill: [a, b, b2, a2],
    handles: [a, b, [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2 + off]],
  };
}

// 两点线两端、水平射线起点、通道平行线中点(拖它改宽度)的手柄可拖;水平 / 竖线的手柄在中点,拖它 = 拖线身,只为看得出选中了
const GEOM: { [K in Exclude<Shape['kind'], 'text' | 'callout'>]: (s: ShapeOf<K>, size: Size) => Geom } = {
  trend: (s) => twoPointGeom(s, [s.x2, s.y2]),
  ray: (s) => {
    const end = rayEnd(s.x1, s.y1, s.x2, s.y2);
    return twoPointGeom(s, [end.x, end.y]);
  },
  channel: channelGeom,
  // 8 个手柄按不延伸的框放(同 TradingView):四角画圆(横竖都改),四边中点画方块(只改一个方向)
  rect: (s, size) => {
    const box = rectBounds(s);
    const at = (hs: RectHandle[]) => hs.map((h) => rectHandleAt(box, h));
    const { l, r, t, b } = rectBounds(s, size.width);
    const edges: [Pt, Pt][] = [
      [
        [l, t],
        [r, t],
      ],
      [
        [l, b],
        [r, b],
      ],
      [
        [l, t],
        [l, b],
      ],
    ];
    const rightEdge: [Pt, Pt][] = s.extend
      ? []
      : [
          [
            [r, t],
            [r, b],
          ],
        ];

    return {
      lines: [...edges, ...rightEdge],
      fill: [
        [l, t],
        [r, t],
        [r, b],
        [l, b],
      ],
      handles: at(['nw', 'ne', 'se', 'sw']),
      squares: at(['n', 'e', 's', 'w']),
    };
  },
  // 上下轨实线、中线虚线、两轨之间淡色填充(同通道);手柄在中线两端,拖它改起止日期;下轨起点下方标相关系数(同 TradingView)
  regression: (s) => {
    const [first] = s.down;
    return {
      lines: [...segments(s.up), ...segments(s.down)],
      dashed: segments(s.mid),
      fill: [...s.up, ...[...s.down].reverse()],
      handles: [
        [s.x1, s.y1],
        [s.x2, s.y2],
      ],
      ...(s.r !== null && first && { label: { at: first, text: `r = ${s.r.toFixed(2)}` } }),
    };
  },
  hray: (s, size) => ({
    lines: [
      [
        [s.x, s.y],
        [size.width, s.y],
      ],
    ],
    handles: [[s.x, s.y]],
  }),
  hline: (s, size) => ({
    lines: [
      [
        [0, s.y],
        [size.width, s.y],
      ],
    ],
    handles: [[size.width / 2, s.y]],
  }),
  vline: (s, size) => ({
    lines: [
      [
        [s.x, 0],
        [s.x, size.height],
      ],
    ],
    handles: [[s.x, size.height / 2]],
  }),
};

/** 这一格此刻要画的:各条画线的像素、选中的那条、绘图模式下的光标 */
export type PaneDrawingState = {
  shapes: Shape[];
  selected: string | null;
  cursor?: string;
  /** 绘图工具下「点下去落在哪」的预览(已过磁吸等插件):光标跟着吸附点跳,看得出吸没吸上 */
  preview?: { x: number; y: number };
  /** 测量尺(临时,不存进文档):起点 → 终点的像素 + 框下两行字;涨绿跌红 */
  measure?: { x1: number; y1: number; x2: number; y2: number; up: boolean; label: [string, string] };
  /** 文字用的主题色:正文色 + 加框时的底色(画布读不到 CSS 变量,由外面按明暗主题给) */
  ink: { text: string; bg: string };
};

const PREVIEW_R = 4;
// 加框文字的底色不透明度:衬得出字,又隐约看得到下面的 K 线
const TEXT_BOX_ALPHA = 0.85;

// 通道填色的不透明度:淡到不挡住里面的 K 线
const FILL_ALPHA = 0.08;
const MEASURE_ALPHA = 0.15;
const LABEL_FONT = '12px system-ui, -apple-system, sans-serif';
const LABEL_PAD = 6;
const LABEL_LINE = 16;

/** 测量框:淡色区域 + 横竖两条中线(看得出量的是哪两点)+ 框下(跌时框上)的实底标签 */
function drawMeasure(ctx: CanvasRenderingContext2D, m: NonNullable<PaneDrawingState['measure']>) {
  const color = m.up ? SIGNED_UP : SIGNED_DOWN;
  const [left, right] = [Math.min(m.x1, m.x2), Math.max(m.x1, m.x2)];
  const [top, bottom] = [Math.min(m.y1, m.y2), Math.max(m.y1, m.y2)];
  const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];

  ctx.globalAlpha = MEASURE_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, m.y1);
  ctx.lineTo(cx, m.y2);
  ctx.moveTo(m.x1, cy);
  ctx.lineTo(m.x2, cy);
  ctx.stroke();

  ctx.font = LABEL_FONT;

  const width = Math.max(...m.label.map((t) => ctx.measureText(t).width)) + LABEL_PAD * 2;
  const height = LABEL_LINE * m.label.length + LABEL_PAD;
  const boxTop = m.up ? bottom + LABEL_PAD : top - LABEL_PAD - height;

  ctx.fillStyle = color;
  ctx.fillRect(cx - width / 2, boxTop, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  m.label.forEach((t, i) => {
    ctx.fillText(t, cx, boxTop + LABEL_PAD / 2 + 2 + i * LABEL_LINE);
  });
}

/** 文字:加框时先铺底色、描边(画线颜色,默认黄);选中时(未加框)画虚线外框;再逐行写字,左上角出手柄 */
function drawText(ctx: CanvasRenderingContext2D, s: ShapeOf<'text'>, on: boolean, ink: PaneDrawingState['ink']) {
  const color = s.color ?? DRAWING_COLOR;

  if (s.box) {
    ctx.globalAlpha = TEXT_BOX_ALPHA;
    ctx.fillStyle = ink.bg;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.globalAlpha = 1;
    ctx.lineWidth = on ? 2 : 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  } else if (on) {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.setLineDash([]);
  }

  ctx.font = TEXT_FONT;
  ctx.fillStyle = s.color ?? ink.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  s.lines.forEach((line, i) => {
    ctx.fillText(line, s.x + TEXT_PAD, s.y + TEXT_PAD / 2 + 2 + i * TEXT_LINE);
  });

  if (!on) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(s.x, s.y, HANDLE_R, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 标注气泡:框 + 指针铺底色、描边(画线颜色,默认黄;指针的边只描框外那一截),框里逐行写字;选中时尖上出手柄。
 * 就地编辑时这里照样画(文字为空),编辑框以同一中心盖在框上。
 * 底色不透明:画线压在 K 线下面,透不透明都挡不住 K 线,不透明省得框和指针交叠处叠深
 */
function drawCallout(
  ctx: CanvasRenderingContext2D,
  s: ShapeOf<'callout'>,
  on: boolean,
  ink: PaneDrawingState['ink'],
  size: Size,
) {
  const color = s.color ?? DRAWING_COLOR;
  const tri = calloutPointer(s);
  const { left, top } = calloutBox(s);
  const pointer = () => {
    if (!tri) return;
    ctx.beginPath();
    ctx.moveTo(...tri[0]);
    ctx.lineTo(...tri[2]);
    ctx.lineTo(...tri[1]);
  };

  ctx.fillStyle = ink.bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = on ? 2 : 1;
  pointer();
  ctx.fill();
  ctx.fillRect(left, top, s.w, s.h);

  // 指针两条边只描框外的部分:裁掉框内(整块画布减去框,evenodd)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size.width, size.height);
  ctx.rect(left, top, s.w, s.h);
  ctx.clip('evenodd');
  pointer();
  ctx.stroke();
  ctx.restore();

  ctx.strokeRect(left, top, s.w, s.h);

  ctx.font = TEXT_FONT;
  ctx.fillStyle = s.color ?? ink.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  s.lines.forEach((line, i) => {
    ctx.fillText(line, left + TEXT_PAD, top + TEXT_PAD / 2 + 2 + i * TEXT_LINE);
  });

  if (!on) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(s.x1, s.y1, HANDLE_R, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 描一组线段。和上一段首尾相接就接着画、不另起子路径:回归通道的轨道是逐根 K 线的 1px 小段,
 * 每段 moveTo 会让虚线节奏从头开始,整条看起来还是实线
 */
function strokeSegments(ctx: CanvasRenderingContext2D, segs: [Pt, Pt][], dash: number[]) {
  ctx.setLineDash(dash);
  ctx.beginPath();
  segs.forEach(([from, to], i) => {
    const prev = segs[i - 1]?.[1];
    if (!prev || prev[0] !== from[0] || prev[1] !== from[1]) ctx.moveTo(...from);
    ctx.lineTo(...to);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly state: PaneDrawingState) {}

  draw(target: CanvasRenderingTarget2D): void {
    const { shapes, selected, preview, measure, ink } = this.state;
    // biome-ignore lint/correctness/useHookAtTopLevel: useMediaCoordinateSpace 是 canvas 方法,不是 React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      shapes.forEach((s) => {
        const on = s.id === selected;
        if (s.kind === 'text') {
          drawText(ctx, s, on, ink);
          return;
        }
        if (s.kind === 'callout') {
          drawCallout(ctx, s, on, ink, mediaSize);
          return;
        }

        const color = s.color ?? DRAWING_COLOR;
        ctx.lineWidth = on ? 2 : 1.5;
        ctx.strokeStyle = color;
        // 按 kind 取对应那一行;联合类型下 TS 认不出 s 和 GEOM[s.kind] 是同一种,只能断言
        const g = GEOM[s.kind](s as never, mediaSize);
        if (g.fill) {
          ctx.globalAlpha = FILL_ALPHA;
          ctx.fillStyle = color;
          ctx.beginPath();
          const [first, ...rest] = g.fill;
          ctx.moveTo(...first);
          rest.forEach((pt) => {
            ctx.lineTo(...pt);
          });
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        strokeSegments(ctx, g.lines, s.dash ? LINE_DASH[s.dash] : []);
        // 通道中线固定用比「虚线」线型更密的节奏:轨道选了虚线时中线仍分得开
        if (g.dashed) strokeSegments(ctx, g.dashed, [4, 4]);

        if (g.label) {
          ctx.font = LABEL_FONT;
          ctx.fillStyle = color;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(g.label.text, g.label.at[0], g.label.at[1] + LABEL_PAD);
        }

        if (!on) return;

        ctx.fillStyle = color;
        g.handles.forEach(([hx, hy]) => {
          ctx.beginPath();
          ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
        });
        // 只管一个方向的手柄画圆角方块(同 TradingView:看形状就知道拖它只改一条边)
        g.squares?.forEach(([hx, hy]) => {
          ctx.beginPath();
          ctx.roundRect(hx - HANDLE_R, hy - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2, 1.5);
          ctx.fill();
        });
      });

      if (measure) drawMeasure(ctx, measure);

      // 落点预览:空心圈,不挡下面的 K 线
      if (preview) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = DRAWING_COLOR;
        ctx.beginPath();
        ctx.arc(preview.x, preview.y, PREVIEW_R, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
}

/**
 * 挂在一个 lw 格上的图元。不自己存画线:每次重画都调 source 现算(平移 / 缩放 / 拖动草稿都即时跟上),
 * 状态变了由外面调 update() 请求重画。格级图元总画在 K 线下面 —— 有意的,同 TradingView 默认(设计文档 §5「渲染」)
 */
export class DrawingsPrimitive implements IPanePrimitive<Time> {
  private requestUpdate?: () => void;
  // 同一个数组:lw-charts 按数组引用做缓存,集合没变就别换
  private readonly views: readonly IPanePrimitivePaneView[];

  constructor(private readonly source: () => PaneDrawingState) {
    this.views = [{ renderer: () => new DrawingsRenderer(this.source()) }];
  }

  attached({ requestUpdate }: PaneAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  update(): void {
    this.requestUpdate?.();
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }

  // 只用来换光标(lw-charts 按它设格子的 cursor):绘图模式下整格十字,悬停在画线上见 hitCursor
  hitTest(x: number, y: number) {
    const { shapes, cursor } = this.source();
    if (cursor) return { externalId: 'drawing-tool', zOrder: 'top' as const, cursorStyle: cursor };
    const hit = hitShapes(shapes, x, y);
    const shape = hit && shapes.find((s) => s.id === hit.id);
    return hit && shape
      ? {
          externalId: hit.id,
          zOrder: 'top' as const,
          // 锁定的拖不动:不给移动 / 放缩箭头,给手指表示「能点选」
          cursorStyle: shape.locked ? 'pointer' : hitCursor(shape, hit.part),
          distance: hit.dist,
        }
      : null;
  }
}
