import { expect, test } from 'bun:test';
import { dotGaps, forwardAt, hikesByTenor, oisForwards } from './policyPath';

// 2026-09-24 Eris 实盘(data/mtv.db 里的 ERIS_OIS_*)。
const AS_OF = '2026-09-24';
// 同日 FRED SOFR 定盘值(基准)。
const SOFR = 3.88;
const PAR = {
  '1M': 3.9003998958,
  '3M': 4.0661788984,
  '6M': 4.2606691765,
  '9M': 4.4368483148,
  '12M': 4.5790040982,
  '18M': 4.6836497598,
  '2Y': 4.7500812195,
  '3Y': 4.766944671,
  '4Y': 4.7559803251,
  '5Y': 4.7500551757,
};

const seg = (to: string) => oisForwards(PAR, AS_OF).find((s) => s.toTenor === to)!;

test('自检:6–9M / 9–12M 远期与 12M 累计次数', () => {
  // 任务单给的 4.79 / 5.0 是线性近似 (r₂t₂ − r₁t₁)/(t₂ − t₁),比 DF 口径多乘了 (1 + r₁t₁),
  // 高出 10~16bp;这里钉的是 DF 口径的真值。
  expect(seg('9M').rate).toBeCloseTo(4.69, 1);
  expect(seg('12M').rate).toBeCloseTo(4.84, 1);

  const linear = (r1: number, t1: number, r2: number, t2: number) => (r2 * t2 - r1 * t1) / (t2 - t1);
  expect(linear(4.2607, 0.5, 4.4368, 0.75)).toBeCloseTo(4.79, 2);
  expect(linear(4.4368, 0.75, 4.579, 1)).toBeCloseTo(5.0, 1);

  const h12 = hikesByTenor(PAR, AS_OF, '12M', SOFR)!;
  expect(h12).toBeGreaterThan(3.5);
  expect(h12).toBeLessThan(5);
});

test('首段远期 = 1M 利率本身;各段首尾相接', () => {
  const segs = oisForwards(PAR, AS_OF);

  expect(segs[0].rate).toBeCloseTo(PAR['1M'], 6);
  expect(segs.map((s) => s.toTenor)).toEqual(['1M', '3M', '6M', '9M', '12M', '18M', '2Y', '3Y', '4Y', '5Y']);
  expect(segs.slice(1).map((s) => s.from)).toEqual(segs.slice(0, -1).map((s) => s.to));
});

test('平坦曲线:>1Y 的 bootstrap 远期仍接近 par(年付息与单利的口径差 < 15bp)', () => {
  const flat = Object.fromEntries(Object.keys(PAR).map((k) => [k, 4]));
  const far = oisForwards(flat, AS_OF).filter((s) => s.from >= '2027-09-24');
  expect(Math.max(...far.map((s) => Math.abs(s.rate - 4)))).toBeLessThan(0.15);
});

test('缺一档则从那一档截断,不拿错的 DF 往后推', () => {
  const { '18M': _, ...holey } = PAR;
  // 2Y 本身不依赖 18M,但不跳档:跳了 12M→2Y 就成一段,段宽悄悄翻倍
  expect(oisForwards(holey, AS_OF).at(-1)!.toTenor).toBe('12M');
});

test('forwardAt:中点插值 —— 2026 年底对上期货的 ~4.3%(直接取段值会是 4.41)', () => {
  const segs = oisForwards(PAR, AS_OF);

  expect(forwardAt(segs, '2026-12-31')).toBeCloseTo(4.27, 1);
  // 首段中点之前取首段值;曲线之外 null
  expect(forwardAt(segs, AS_OF)).toBeCloseTo(segs[0].rate, 9);
  expect(forwardAt(segs, '2040-01-01')).toBeNull();
  expect(forwardAt(segs, '2026-01-01')).toBeNull();
});

test('dotGaps:基差被消掉,正 = 市场比联储鹰', () => {
  const segs = oisForwards(PAR, AS_OF);
  const f = forwardAt(segs, '2027-12-31')!;
  const [g] = dotGaps(segs, [{ date: '2027-12-31', value: 4.1 }], { base: SOFR, mid: 3.875 });

  expect(g.market).toBeCloseTo(3.875 + f - SOFR, 9);
  expect(g.gapBp).toBeCloseTo((g.market - 4.1) * 100, 9);
  expect(dotGaps(segs, [{ date: '2040-12-31', value: 3 }], { base: SOFR, mid: 3.875 })).toEqual([]);
});
