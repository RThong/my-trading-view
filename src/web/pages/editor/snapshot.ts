// 导出图片(同 TradingView 的「Download image / Copy image」,2026-11-13 演示页实测):只截图表区、不带工具栏;
// 我们另在顶上写标题、底下写落款(TV 底下是它的 logo 栏)。
// 图表本身(各格、坐标轴、画线)走 lightweight-charts 的 takeScreenshot;图例不照搬屏幕上的那块(那是悬停读数用的),
// 另画横排的「色块 + 名字 + 标签」(居中、放不下折行),只说明哪条线是什么(见 Legend.tsx 的 snapshotLegend):
// 主图的在标题和图表之间单独一条,副图的在各自格子顶部。
import type { IChartApi } from 'lightweight-charts';
import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import type { SnapshotLegendItem } from '../../views/chartDoc/Legend';
import { flowLayout } from '../../chart/flowLayout';

const HEADER = 36;
// 没标题时顶上也留一条窄空白:图表直接顶到卡片上沿不好看(负责人 2026-11-13 定,不自动拿序列名凑标题)
const NO_TITLE_GAP = 12;
const FOOTER = 26;
// 标题、落款离卡片左右边的距离(12 太贴边,负责人 2026-11-13 嫌丑)
const PAD = 20;
// 图例一行:高、内边距、离两边价格轴至少留多少、色块宽、色块与名字 / 名字与标签 / 两项之间的间距
const LEGEND = { h: 20, pad: 6, margin: 24, swatch: 12, gap: 6, itemGap: 16, tagPad: 4 };
// 主图图例条与图表之间的空隙
const LEGEND_BAND_GAP = 6;

type Colors = { bg: string; text: string; font: string };

/** 量一格图例的排版:每项宽(含标签)、标签在项内的位置、按 width 折行后每项落在哪行哪里 */
function legendLayout(ctx: CanvasRenderingContext2D, items: SnapshotLegendItem[], width: number, font: string) {
  const [nameFont, tagFont] = [`12px ${font}`, `10px ${font}`];
  const measure = (s: string, f: string) => {
    ctx.font = f;
    return ctx.measureText(s).width;
  };
  // 每项:名字宽、各标签宽及其在项内的横坐标(标签跟在名字后面一字排开,不折行)
  const parts = items.map((it) => {
    const nameW = measure(it.label, nameFont);
    const tagWs = it.tags.map((t) => measure(t, tagFont) + LEGEND.tagPad * 2);
    const tagsStart = LEGEND.swatch + LEGEND.gap + nameW + LEGEND.gap;
    const tags = flowLayout(tagWs, Number.POSITIVE_INFINITY, LEGEND.gap);
    const itemW = it.tags.length ? tagsStart + (tags.rowWidths[0] ?? 0) : tagsStart - LEGEND.gap;
    return { tagWs, tagXs: tags.items.map((p) => tagsStart + p.x), width: itemW };
  });
  const flow = flowLayout(
    parts.map((p) => p.width),
    width - LEGEND.margin * 2 - LEGEND.pad * 2,
    LEGEND.itemGap,
  );

  return { parts, flow, nameFont, tagFont };
}

/**
 * 一格的图例:横排(色块 名字 [标签]),每行在画图区(两根价格轴之间)居中、离两边的轴都隔开(同研报图);
 * 放不下就换行(一格线多、名字长时一行会压到价格轴上被裁掉);每行垫一层半透明底色,免得字压在线上看不清
 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  items: SnapshotLegendItem[],
  at: { x: number; y: number; width: number },
  c: Colors,
) {
  if (!items.length) return;
  const { parts, flow, nameFont, tagFont } = legendLayout(ctx, items, at.width, c.font);

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = c.bg;
  // 每行的左边:按行宽在画图区里居中
  const rowX = flow.rowWidths.map((rw) => at.x + (at.width - rw - LEGEND.pad * 2) / 2);
  flow.rowWidths.forEach((rw, row) => {
    ctx.beginPath();
    ctx.roundRect(rowX[row], at.y + row * LEGEND.h, rw + LEGEND.pad * 2, LEGEND.h, 4);
    ctx.fill();
  });
  ctx.restore();

  ctx.textBaseline = 'middle';
  items.forEach((it, i) => {
    const x = rowX[flow.items[i].row] + LEGEND.pad + flow.items[i].x;
    const mid = at.y + flow.items[i].row * LEGEND.h + LEGEND.h / 2;

    // 色块同屏幕图例:蜡烛涨绿跌红各半,其余一小段线
    if (it.swatch === 'candle') {
      ctx.fillStyle = SIGNED_UP;
      ctx.fillRect(x, mid - 5, LEGEND.swatch / 2, 10);
      ctx.fillStyle = SIGNED_DOWN;
      ctx.fillRect(x + LEGEND.swatch / 2, mid - 5, LEGEND.swatch / 2, 10);
    } else {
      ctx.fillStyle = it.swatch;
      ctx.fillRect(x, mid - 1, LEGEND.swatch, 2);
    }

    ctx.font = nameFont;
    ctx.fillStyle = c.text;
    ctx.fillText(it.label, x + LEGEND.swatch + LEGEND.gap, mid);

    it.tags.forEach((t, j) => {
      const [tx, tw] = [x + parts[i].tagXs[j], parts[i].tagWs[j]];
      ctx.strokeStyle = c.text;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.roundRect(tx + 0.5, mid - 7.5, tw - 1, 15, 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = tagFont;
      ctx.fillText(t, tx + LEGEND.tagPad, mid);
    });
  });
}

type Snapshot = {
  chart: IChartApi;
  /** 图表容器:截图的坐标原点 */
  origin: HTMLElement;
  /** 各格图例(按格的顺序)+ 各格顶边、左轴宽(同屏幕图例的位置,见 useCrosshairLegend 的 layout) */
  legend: SnapshotLegendItem[][];
  layout: { tops: number[]; left: number };
  title?: string;
  /** 标题色:页面正文色(主题的 ink),比轴刻度的灰更实 */
  ink: string;
  /** 右下角落款(周期、数据截至哪天) */
  footer: string;
};

/**
 * 拼出导出用的整张图:标题栏 + 主图图例条 + 图表 + 落款栏,再套上外框。
 * 第 1 格的图例画在图表上方单独一条(不压在画图区里,同研报图);副图的图例只能画在各自格子顶部(截图是一整张,格子之间插不进空白)
 */
export function snapshotCanvas({ chart, origin, legend, layout, title, ink, footer }: Snapshot): HTMLCanvasElement {
  const shot = chart.takeScreenshot(true);
  // 截图是设备像素(Retina 上 2 倍),下面按 CSS 像素画
  const scale = shot.width / origin.clientWidth;
  const [w, h] = [shot.width / scale, shot.height / scale];
  const { background, textColor, fontFamily } = chart.options().layout;
  const bg = 'color' in background ? background.color : background.topColor;
  const colors = { bg, text: textColor, font: fontFamily };
  // 画图区 = 左轴右边起、时间轴那么宽(左右两根价格轴之间)
  const plot = { x: layout.left, width: chart.timeScale().width() };
  // 主图图例条的高度:先拿一块草稿画布量出折成几行
  const scratch = document.createElement('canvas').getContext('2d');
  const mainRows =
    scratch && legend[0]?.length ? legendLayout(scratch, legend[0], plot.width, fontFamily).flow.rowWidths.length : 0;
  const titleH = title ? HEADER : NO_TITLE_GAP;
  const header = titleH + (mainRows ? mainRows * LEGEND.h + LEGEND_BAND_GAP : 0);

  const out = document.createElement('canvas');
  out.width = shot.width;
  out.height = Math.round((h + header + FOOTER) * scale);
  const ctx = out.getContext('2d');
  if (!ctx) return shot;
  ctx.scale(scale, scale);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h + header + FOOTER);
  ctx.drawImage(shot, 0, header, w, h);

  drawLegend(ctx, legend[0] ?? [], { ...plot, y: titleH }, colors);
  legend.slice(1).forEach((items, i) => {
    drawLegend(ctx, items, { ...plot, y: header + (layout.tops[i + 1] ?? 0) + 6 }, colors);
  });

  ctx.fillStyle = textColor;
  ctx.textBaseline = 'middle';
  if (title) {
    // 标题用页面的字体和正文色、加粗加大(图表的字体 / 轴刻度灰写标题发虚,负责人 2026-11-13 嫌丑)
    ctx.font = `700 18px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle = ink;
    // 很长的标题(最多 80 字)按卡片宽压窄,不被截掉
    ctx.fillText(title, PAD, HEADER / 2, w - PAD * 2);
    ctx.fillStyle = textColor;
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
