// 收益曲线族多线图的共享系列配色:确定性生成、相邻必不同色区、无 Math.random。
// 为什么手写生成而非硬编码数组:要长度≥期限数(24)且相邻不同色区,又要"不僵硬"的 jitter。

// 8 个暗底下清晰的基准色相(HSL 的 H,度),排序让相邻两个在色相环上尽量远。
const ZONE_HUES = [220, 30, 145, 320, 190, 52, 0, 275]; // 蓝 橙 绿 品红 青 黄 红 紫

// 整数 → [0,1) 的确定性散列(Math.imul + 位运算,ToInt32 语义跨引擎一致;非随机)。
function hash01(n: number): number {
  let h = Math.imul(n + 1, 2654435761);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

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

// 第 i 个系列:色区按 i%8 轮换(相邻必不同区);区内色相±12° jitter、
// 明度按"第几轮(i/8)"错开(同色区不同轮也分得开)、饱和度小幅变化。全确定性。
export function buildSeriesColors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const hue = ZONE_HUES[i % ZONE_HUES.length] + (hash01(i) * 24 - 12); // ±12°
    const light = [60, 72, 50][Math.floor(i / ZONE_HUES.length) % 3]; // 轮次错开明度
    const sat = 68 + hash01(i * 7) * 20; // 68–88%
    return hslToHex((hue + 360) % 360, sat, light);
  });
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

// 前 8 档用验证配色(覆盖各曲线默认选择);OIS 深档(≥8,少被同时选)沿用 HSL 生成填满 24。
export const SERIES_COLORS = [...CATEGORICAL_DARK, ...buildSeriesColors(24).slice(CATEGORICAL_DARK.length)];
