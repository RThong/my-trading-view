import { describe, expect, test } from 'bun:test';
import { measureLabel, measureStats } from './measure';

describe('测量尺', () => {
  test('上涨:涨跌值、涨跌幅、根数、天数', () => {
    const s = measureStats({ time: '2026-03-02', value: 7000 }, { time: '2026-04-16', value: 7152.3 }, 32);
    expect(s.days).toBe(45);
    expect(measureLabel(s)).toEqual(['+152.30 (+2.18%)', '32 根 · 45 天']);
  });

  test('下跌 / 往左量:符号都跟着变', () => {
    const s = measureStats({ time: '2026-04-16', value: 4.25 }, { time: '2026-03-02', value: 4.1 }, -32.4);
    expect(measureLabel(s)).toEqual(['-0.150 (-3.53%)', '-32 根 · -45 天']);
  });

  test('起点为 0(穿零序列):不给涨跌幅;起点为负时涨跌幅符号跟着涨跌走', () => {
    expect(measureLabel(measureStats({ time: '2026-03-02', value: 0 }, { time: '2026-03-03', value: 1.5 }, 1))[0]).toBe(
      '+1.50',
    );
    expect(measureStats({ time: '2026-03-02', value: -2 }, { time: '2026-03-03', value: -1 }, 1).pct).toBe(50);
  });
});
