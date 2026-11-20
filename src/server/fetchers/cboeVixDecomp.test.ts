import { test, expect } from 'bun:test';
import { parseDecomp, pick25Delta, NotTradingDayError } from './cboeVixDecomp';

// 7020 / 7590 两点截自 2026-11-18 的真实响应,邻近几点是编的(验「取最近」)
const CURVE = {
  '7015.0': { iv: 0.2417, delta: -0.2482 },
  '7020.0': { iv: 0.2415083851665258, delta: -0.2490466908809617 },
  '7025.0': { iv: 0.2412, delta: -0.2531 },
  '7340.0': { iv: 0.198, delta: -0.49 },
  '7585.0': { iv: 0.1681, delta: 0.2521 },
  '7590.0': { iv: 0.16800014767795807, delta: 0.24839122320215273 },
};

test('pick25Delta:两侧各取 delta 离 ±0.25 最近的行权价,百分数,skew = put − call', () => {
  const v = pick25Delta(CURVE, '2026-11-18');
  expect(v.putIv).toBeCloseTo(24.1508, 3);
  expect(v.callIv).toBeCloseTo(16.8, 3);
  expect(v.skew).toBeCloseTo(7.3508, 3);
});

test('pick25Delta:某一侧离 25Δ 太远(曲线残缺)就报错,不拿 10Δ 冒充', () => {
  expect(() => pick25Delta({ a: { iv: 0.3, delta: -0.1 }, b: { iv: 0.17, delta: 0.25 } }, 'd')).toThrow('25Δ');
});

test('parseDecomp:两天各取自己的曲线;已知的「没数据」回空表,非交易日单独的错误类型,其它错误照抛', () => {
  const body = {
    interpolatedIVs: {
      '2026-11-17': { '2026-12-11_2026-12-18': { ivs: CURVE } },
      '2026-11-18': { '2026-12-18': { ivs: CURVE } },
    },
  };
  expect([...parseDecomp(body, ['2026-11-17', '2026-11-18']).keys()]).toEqual(['2026-11-17', '2026-11-18']);

  expect(parseDecomp({ error: "Data for today's date is not yet available." }, ['a', 'b']).size).toBe(0);
  expect(parseDecomp({ error: 'No interest rate data found for effective date 2022-07-05' }, ['a', 'b']).size).toBe(0);
  expect(() => parseDecomp({ error: 'One or both dates are not trading days.' }, ['a', 'b'])).toThrow(
    NotTradingDayError,
  );
  expect(() => parseDecomp({ error: 'Insufficient data to compute average IV' }, ['a', 'b'])).toThrow('Insufficient');
  expect(() => parseDecomp({ interpolatedIVs: {} }, ['2026-11-17', '2026-11-18'])).toThrow('结构可能变了');
});
