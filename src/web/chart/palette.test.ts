import { describe, expect, it } from 'bun:test';
import { extendDistinct, colorDistance, SERIES_COLORS, CATEGORICAL_DARK, hslToHex } from './palette';

describe('hslToHex', () => {
  it('纯红 (0,100,50) → #ff0000', () => expect(hslToHex(0, 100, 50)).toBe('#ff0000'));
  it('纯绿 (120,100,50) → #00ff00', () => expect(hslToHex(120, 100, 50)).toBe('#00ff00'));
});

describe('extendDistinct', () => {
  it('确定性 + 保留 seed + 加长不改前面的色(= 刷新、扩表都不变色)', () => {
    const a = extendDistinct(CATEGORICAL_DARK, 24);
    expect(a).toEqual(extendDistinct(CATEGORICAL_DARK, 24));
    expect(a.slice(0, 8)).toEqual(CATEGORICAL_DARK);
    expect(extendDistinct(CATEGORICAL_DARK, 32).slice(0, 24)).toEqual(a);
  });
});

describe('SERIES_COLORS', () => {
  it('前 8 档 = dataviz 验证类别配色,共 32 档,全为合法 hex 且互不相同', () => {
    expect(SERIES_COLORS.length).toBe(32);
    expect(SERIES_COLORS.slice(0, 8)).toEqual(CATEGORICAL_DARK);
    for (const x of SERIES_COLORS) expect(x).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(SERIES_COLORS).size).toBe(32);
  });

  // 一个 tab 最多 OIS 24 期限 + 差值线同屏,任意两条都得肉眼分得开。旧生成器 #7≈#17 只有 11、#0≈#24 只有 19。
  it('补出的颜色与表内任一色的色差都 ≥ 75', () => {
    const worst = Math.min(
      ...SERIES_COLORS.slice(8).flatMap((c, i) =>
        SERIES_COLORS.filter((_, j) => j !== i + 8).map((o) => colorDistance(c, o)),
      ),
    );
    expect(worst).toBeGreaterThanOrEqual(75);
  });
});
