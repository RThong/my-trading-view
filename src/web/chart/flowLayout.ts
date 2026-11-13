// 横排折行:一串宽度依次排开,一行放不下就换行(导出图片的图例用)。纯计算,不碰画布。

export type FlowLayout = {
  /** 每项在第几行、行内的横坐标(从 0 起) */
  items: { x: number; row: number }[];
  /** 每行的总宽(不含行尾间距) */
  rowWidths: number[];
};

export function flowLayout(widths: number[], maxWidth: number, gap: number): FlowLayout {
  const items: FlowLayout['items'] = [];
  const rowWidths: number[] = [];
  let [x, row] = [0, 0];
  for (const w of widths) {
    // 本行已有东西且放不下才换行:单项比一行还宽时独占一行(超出的部分只能被裁掉)
    if (x > 0 && x + w > maxWidth) {
      rowWidths[row] = x - gap;
      row += 1;
      x = 0;
    }
    items.push({ x, row });
    x += w + gap;
  }
  if (widths.length) rowWidths[row] = x - gap;

  return { items, rowWidths };
}
