// 多线图的共享系列配色:同一 tab 里所有线按下标依次取色,两两都要分得开。
// 前 8 档是验证过的类别色;之后从候选网格里贪心补色(每次挑离已选各色最远的),确定性、无 Math.random。
// 不再用「按 8 个色区轮转 + 轮次错开明度」生成:那套和前 8 档不是同一个色相序,会撞回去
// (实测 #7≈#17 色差 11、#0≈#24 色差 19,OIS 差值线与 1D 期限线肉眼同色)。

// HSL→#rrggbb。h∈[0,360) s,l∈[0,100]。紧凑实现(无依赖)。
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// dataviz skill 验证过的 8 色定序类别配色(dark surface,顺序即相邻 CVD 最优)。
// validate_palette.js 对底 #0a0a0a 全 PASS(亮度/彩度/对比);相邻 CVD 最差 10.3 在 floor 带,
// 靠面板已有的图例 + 右侧数值直标做二级编码(合规)。隔档选(如 BEI 5Y/10Y/30Y=slot 0/2/4=蓝/黄/紫)也拉得开。
export const CATEGORICAL_DARK = [
  '#3987e5',
  '#199e70',
  '#c98500',
  '#008300',
  '#9085e9',
  '#e66767',
  '#d55181',
  '#d95926',
];

// 候选色网格:色相每 10°、三档明度,饱和度固定 65(与前 8 档柔和度相当,不显荧光);暗底(#0a0a0a)上都够亮。
const CANDIDATES = [48, 62, 76].flatMap((l) => Array.from({ length: 36 }, (_, i) => hslToHex(i * 10, 65, l)));

function rgb(hex: string) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

/** 近似感知色差(redmean 加权 RGB):比纯 RGB 欧氏距离更贴近人眼,够判「两色分不分得开」。 */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

/** 从 seed 出发补到 n 色:每次从候选里挑「与已选各色的最小色差最大」的一个。确定性,加长不改前面的色。 */
export function extendDistinct(seed: string[], n: number): string[] {
  const out = [...seed];
  // 每步依赖已选集合,命令式更直白。
  while (out.length < n) {
    const best = CANDIDATES.filter((c) => !out.includes(c)).reduce(
      (acc, c) => {
        const d = Math.min(...out.map((o) => colorDistance(c, o)));
        return d > acc.d ? { c, d } : acc;
      },
      { c: '', d: -1 },
    );
    out.push(best.c);
  }
  return out;
}

// 32 = OIS 24 个期限 + 差值线等余量(按下标取色,加长不改前面的色)。
export const SERIES_COLORS = extendDistinct(CATEGORICAL_DARK, 32);

/** #rrggbb → 带透明度的 rgba(背景色带用图层颜色的淡色版) */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 色带段外的透明色 */
export const TRANSPARENT = 'rgba(0,0,0,0)';
/**
 * 背景色带的淡度(固定面板错月背景定的,编辑器背景图层沿用):它是「在这里多看一眼」的提醒,
 * 不是「这段数据不能用」—— 0.28 时全历史视图满屏条纹,读起来像大半数据都坏了
 */
export const BACKGROUND_ALPHA = 0.14;

/** 分位背景带:风险端红、机会端绿(固定面板与图表编辑器共用) */
export const BAND_RISK = 'rgba(239,68,68,0.45)';
export const BAND_CALM = 'rgba(34,197,94,0.45)';

/** 符号柱:正绿负红(固定面板与图表编辑器共用) */
export const SIGNED_UP = '#22c55e';
export const SIGNED_DOWN = '#ef4444';

// 成交量柱半透明:单日放量的长柱满色太抢眼(上色的点和不上色时的图层颜色同一个透明度)
export const VOLUME_ALPHA = 0.6;
/** 成交量柱按 K 线涨跌上色(同 TradingView:收 ≥ 开为涨) */
export function volumeColor(up: boolean): string {
  return withAlpha(up ? SIGNED_UP : SIGNED_DOWN, VOLUME_ALPHA);
}

/**
 * 取色器的固定色板,照抄 TradingView(2026-11-24 在官方演示页读 DOM 取的色值):
 * 第 1 行白到黑 10 档灰,第 2 行 10 个主色,其下 6 行是各主色由浅到深。固定色值 = 每次点同一格颜色完全一样
 */
export const SWATCH_ROWS: string[][] = [
  ['#ffffff', '#dbdbdb', '#b8b8b8', '#9c9c9c', '#808080', '#636363', '#4a4a4a', '#2e2e2e', '#0f0f0f', '#000000'],
  ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'],
  ['#fccbcd', '#ffe0b2', '#fff9c4', '#c8e6c9', '#ace5dc', '#b2ebf2', '#bbd9fb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
  ['#faa1a4', '#ffcc80', '#fff59d', '#a5d6a7', '#70ccbd', '#80deea', '#90bff9', '#b39ddb', '#ce93d8', '#f48fb1'],
  ['#f77c80', '#ffb74d', '#fff176', '#81c784', '#42bda8', '#4dd0e1', '#5b9cf6', '#9575cd', '#ba68c8', '#f06292'],
  ['#f7525f', '#ffa726', '#ffee58', '#66bb6a', '#22ab94', '#26c6da', '#3179f5', '#7e57c2', '#ab47bc', '#ec407a'],
  ['#b22833', '#f57c00', '#fbc02d', '#388e3c', '#056656', '#0097a7', '#1848cc', '#512da8', '#7b1fa2', '#c2185b'],
  ['#801922', '#e65100', '#f57f17', '#1b5e20', '#00332a', '#006064', '#0c3299', '#311b92', '#4a148c', '#880e4f'],
];
