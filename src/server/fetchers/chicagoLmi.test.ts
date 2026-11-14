import { describe, expect, test } from 'bun:test';
import { CFLMI_SERIES, parseCflmi } from './chicagoLmi';

// 真实 JSON 的形状(2026-11 实测):数值是字符串,有的带前导空格;日期是 BLS 参考周(周六)
function json(overrides: Record<string, unknown[][]> = {}) {
  const obs: Record<string, unknown[][]> = {
    [CFLMI_SERIES.separations]: [
      ['2026-10-17', '2.009173'],
      ['2026-09-13', '2.03'],
    ],
    [CFLMI_SERIES.hiring]: [['2026-10-17', '46.17518']],
    [CFLMI_SERIES.flowRate]: [['2026-10-17', ' 4.169763']],
    ...overrides,
  };
  return {
    series: Object.entries(obs).map(([source_id, observations]) => ({
      source_id,
      metadata: { units: '%' },
      observations,
    })),
  };
}

describe('parseCflmi', () => {
  test('三条序列:参考周 → 当月 1 日、升序,字符串数值(含前导空格)转数字', () => {
    const r = parseCflmi(json());
    expect(r.separations).toEqual([
      { date: '2026-09-01', value: 2.03 },
      { date: '2026-10-01', value: 2.009173 },
    ]);
    expect(r.flowRate).toEqual([{ date: '2026-10-01', value: 4.169763 }]);
  });

  test('缺序列 / 坏观测 / 同月两点 → 抛错', () => {
    const { series } = json();
    expect(() => parseCflmi({ series: series.slice(1) })).toThrow('缺序列');
    expect(() => parseCflmi(json({ [CFLMI_SERIES.hiring]: [['2026-10-17', '']] }))).toThrow('坏观测');
    expect(() => parseCflmi(json({ [CFLMI_SERIES.hiring]: [['2026-10', '46']] }))).toThrow('坏观测');
    expect(() => parseCflmi(json({ [CFLMI_SERIES.hiring]: [['2026-13-40', '46']] }))).toThrow('坏观测');
    expect(() => parseCflmi(json({ [CFLMI_SERIES.hiring]: [['2026-02-30', '46']] }))).toThrow('坏观测');
    expect(() =>
      parseCflmi(
        json({
          [CFLMI_SERIES.hiring]: [
            ['2026-10-17', '46'],
            ['2026-10-03', '45'],
          ],
        }),
      ),
    ).toThrow('同月多个观测');
  });
});
