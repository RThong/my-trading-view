import { describe, expect, test } from 'bun:test';
import { snapTime, snapToBar, WEAK_PX } from './magnet';

// 纵轴:数值 v 画在 y = 1000 - v(数值越大越靠上)
function toY(v: number) {
  return 1000 - v;
}
const raw = { time: '2026-03-14', value: 500 };
const candle = { time: '2026-03-13', values: [480, 520, 470, 510] };

describe('snapToBar', () => {
  test('弱磁吸:离最近的值在半径内才吸,吸上时日期对齐到那一根', () => {
    const near = 1000 - 510 + WEAK_PX - 1;
    expect(snapToBar(raw, near, candle, toY, false)).toEqual({ time: '2026-03-13', value: 510 });

    const far = 1000 - 495;
    expect(snapToBar(raw, far, candle, toY, false)).toBe(raw);
  });

  test('强磁吸:总是吸到最近的值', () => {
    expect(snapToBar(raw, 1000 - 495, candle, toY, true)).toEqual({ time: '2026-03-13', value: 480 });
  });

  test('那里没数据 / 换算不出像素:原样返回', () => {
    expect(snapToBar(raw, 500, null, toY, true)).toBe(raw);
    expect(snapToBar(raw, 500, { time: '2026-03-13', values: [] }, toY, true)).toBe(raw);
    expect(snapToBar(raw, 500, candle, () => null, true)).toBe(raw);
  });
});

test('snapTime:只对齐日期,数值不动;那里没数据原样返回', () => {
  expect(snapTime(raw, candle)).toEqual({ time: '2026-03-13', value: 500 });
  expect(snapTime(raw, null)).toBe(raw);
});
