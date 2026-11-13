// 导出图片(同 TradingView 的「Download image / Copy image」,2026-11-13 演示页实测):只截图表区、不带工具栏,
// 图例画进图里;我们另在顶上写标题、底下写落款(TV 底下是它的 logo 栏)。
// 图表本身(各格、坐标轴、画线)走 lightweight-charts 的 takeScreenshot;图例是叠在画布上的 HTML,
// 照屏幕上的位置把每个元素的底色 / 边框 / 文字描到画布上 —— 不另写一份图例排版,图例改了导出自动跟着变。
import type { IChartApi } from 'lightweight-charts';

const HEADER = 36;
// 没标题时顶上也留一条窄空白:图表直接顶到卡片上沿不好看(负责人 2026-11-13 定,不自动拿序列名凑标题)
const NO_TITLE_GAP = 12;
const FOOTER = 26;
const PAD = 12;

function visible(c: string): boolean {
  return c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c);
}

/**
 * 把 el 底下的元素按屏幕位置描到 ctx(坐标以 origin 左上为原点,CSS 像素)。
 * ponytail: 只描底色、边框、文字,图标(svg)略过 —— 图例里只有隐藏块前的小眼睛和 ⓘ 是图标,丢了不影响读数
 */
function paintDom(ctx: CanvasRenderingContext2D, el: Element, origin: DOMRect) {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || el instanceof SVGElement) return;

  const r = el.getBoundingClientRect();
  const [x, y] = [r.left - origin.left, r.top - origin.top];
  const radius = Number.parseFloat(s.borderTopLeftRadius) || 0;
  if (r.width && visible(s.backgroundColor)) {
    ctx.fillStyle = s.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(x, y, r.width, r.height, radius);
    ctx.fill();
  }

  const border = Number.parseFloat(s.borderTopWidth);
  if (border && visible(s.borderTopColor)) {
    ctx.strokeStyle = s.borderTopColor;
    ctx.lineWidth = border;
    ctx.beginPath();
    ctx.roundRect(x + border / 2, y + border / 2, r.width - border, r.height - border, radius);
    ctx.stroke();
  }

  el.childNodes.forEach((n) => {
    if (n instanceof Element) {
      paintDom(ctx, n, origin);
      return;
    }
    if (n.nodeType !== Node.TEXT_NODE) return;

    // 只量去掉首尾空白的那段:折叠掉的空格不占位,带着画会整段右移
    const raw = n.textContent ?? '';
    const start = raw.search(/\S/);
    if (start < 0) return;
    const range = document.createRange();
    range.setStart(n, start);
    range.setEnd(n, raw.trimEnd().length);
    const t = range.getBoundingClientRect();
    ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    ctx.fillStyle = s.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(range.toString(), t.left - origin.left, t.top - origin.top + t.height / 2);
  });
}

type Snapshot = {
  chart: IChartApi;
  /** 图表容器:截图的坐标原点 */
  origin: HTMLElement;
  /** 叠在图上要一起画进去的 HTML(图例) */
  overlay: HTMLElement | null;
  title?: string;
  /** 右下角落款(周期、日期) */
  footer: string;
};

/** 拼出导出用的整张图:标题栏 + 图表(含图例)+ 落款栏,再套上外框 */
export function snapshotCanvas({ chart, origin, overlay, title, footer }: Snapshot): HTMLCanvasElement {
  const shot = chart.takeScreenshot(true);
  // 截图是设备像素(Retina 上 2 倍),下面按 CSS 像素画
  const scale = shot.width / origin.clientWidth;
  const [w, h] = [shot.width / scale, shot.height / scale];
  const header = title ? HEADER : NO_TITLE_GAP;
  const { background, textColor, fontFamily } = chart.options().layout;

  const out = document.createElement('canvas');
  out.width = shot.width;
  out.height = Math.round((h + header + FOOTER) * scale);
  const ctx = out.getContext('2d');
  if (!ctx) return shot;
  ctx.scale(scale, scale);
  ctx.fillStyle = 'color' in background ? background.color : background.topColor;
  ctx.fillRect(0, 0, w, h + header + FOOTER);
  ctx.drawImage(shot, 0, header, w, h);

  ctx.save();
  ctx.translate(0, header);
  if (overlay) paintDom(ctx, overlay, origin.getBoundingClientRect());
  ctx.restore();

  ctx.fillStyle = textColor;
  ctx.textBaseline = 'middle';
  if (title) {
    ctx.font = `600 16px ${fontFamily}`;
    ctx.fillText(title, PAD, HEADER / 2);
  }
  ctx.font = `12px ${fontFamily}`;
  ctx.globalAlpha = 0.6;
  ctx.fillText('My Trading View', PAD, header + h + FOOTER / 2);
  ctx.textAlign = 'right';
  ctx.fillText(footer, w - PAD, header + h + FOOTER / 2);

  return framed(out, scale);
}

// 外框(仿 carbon.now.sh 的默认样式,负责人 2026-11-13 要的「窗口感」,不要窗口左上角的三个圆点):
// 灰蓝底、四周留白、圆角卡片 + 下沉阴影。尺寸按 CSS 像素
const FRAME = {
  bg: 'rgb(171, 184, 195)',
  pad: 28,
  radius: 8,
  shadow: 'rgba(0, 0, 0, 0.55)',
  shadowY: 10,
  shadowBlur: 32,
};

/** 把拼好的图放进外框 */
function framed(card: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const { bg, pad, radius, shadow, shadowY, shadowBlur } = FRAME;
  const [w, h] = [card.width / scale, card.height / scale];

  const out = document.createElement('canvas');
  out.width = Math.round((w + pad * 2) * scale);
  out.height = Math.round((h + pad * 2) * scale);
  const ctx = out.getContext('2d');
  if (!ctx) return card;
  ctx.scale(scale, scale);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w + pad * 2, h + pad * 2);

  // 阴影的偏移 / 模糊不随 ctx.scale 缩放(按设备像素算),要自己乘上
  ctx.save();
  ctx.shadowColor = shadow;
  ctx.shadowOffsetY = shadowY * scale;
  ctx.shadowBlur = shadowBlur * scale;
  ctx.beginPath();
  ctx.roundRect(pad, pad, w, h, radius);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(pad, pad, w, h, radius);
  ctx.clip();
  ctx.drawImage(card, pad, pad, w, h);

  return out;
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), 'image/png'),
  );
}

export async function downloadPng(canvas: HTMLCanvasElement, name: string) {
  const url = URL.createObjectURL(await pngBlob(canvas));
  const a = document.createElement('a');
  a.href = url;
  // 文件名里不能有的字符换成 -
  a.download = `${name.replace(/[\\/:*?"<>|]/g, '-')}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 复制到剪贴板:Promise 直接交给 ClipboardItem(Safari 要求在点击的同一拍里调 write,不能先 await 出图) */
export function copyPng(canvas: HTMLCanvasElement): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(canvas) })]);
}
