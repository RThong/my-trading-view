import { describe, expect, test } from 'bun:test';
import { parseGex } from './squeezemetrics';

const HEAD = 'date,price,dix,gex';

describe('parseGex', () => {
  test('取 gex 列,美元 → 亿美元,负值照留', () => {
    const csv = `${HEAD}\n2026-03-27,6400.1,0.41,-7240000000.5\n2026-11-13,7561.67,0.4449708621040202,6127404508.979999\n`;
    const p = parseGex(csv);
    expect(p.map((x) => x.date)).toEqual(['2026-03-27', '2026-11-13']);
    expect(p[0].value).toBeCloseTo(-72.400000005, 6);
    expect(p[1].value).toBeCloseTo(61.27404509, 6);
  });

  test('表头变了 / 坏行 / 不存在的日期 / 不升序 → 抛错', () => {
    expect(() => parseGex('date,price,gex,dix\n2026-11-13,1,2,3')).toThrow('表头变了');
    expect(() => parseGex(`${HEAD}\n2026-11-13,1,0.4,`)).toThrow('坏行');
    expect(() => parseGex(`${HEAD}\n2026-02-30,1,0.4,5`)).toThrow('坏行');
    expect(() => parseGex(`${HEAD}\n2026-11-13,1,0.4,1e9999`)).toThrow('坏行');
    expect(() => parseGex(`${HEAD}\n2026-11-13,1,0.4,5\n2026-11-12,1,0.4,5`)).toThrow('严格升序');
    expect(() => parseGex(`${HEAD}\n2026-11-13,1,0.4,5\n2026-11-13,1,0.4,6`)).toThrow('严格升序');
  });
});
