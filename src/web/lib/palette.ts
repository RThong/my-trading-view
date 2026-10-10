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

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

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
