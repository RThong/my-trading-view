import { describe, expect, it } from 'bun:test';
import { buildSeriesColors, SERIES_COLORS, hslToHex } from './palette';

describe('hslToHex', () => {
  it('纯红 (0,100,50) → #ff0000', () => expect(hslToHex(0, 100, 50)).toBe('#ff0000'));
  it('纯绿 (120,100,50) → #00ff00', () => expect(hslToHex(120, 100, 50)).toBe('#00ff00'));
});

describe('buildSeriesColors', () => {
  it('确定性:连调两次完全一致(= 刷新不变色的保证)', () =>
    expect(buildSeriesColors(24)).toEqual(buildSeriesColors(24)));

  it('SERIES_COLORS === buildSeriesColors(24)', () =>
    expect(SERIES_COLORS).toEqual(buildSeriesColors(24)));

  it('长度 = n,每项是合法 hex', () => {
    const c = buildSeriesColors(24);
    expect(c.length).toBe(24);
    for (const x of c) expect(x).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('相邻项互不相等(相邻不同色区 → 相邻期限可分辨)', () => {
    const c = buildSeriesColors(24);
    for (let i = 1; i < c.length; i++) expect(c[i]).not.toBe(c[i - 1]);
  });
});
