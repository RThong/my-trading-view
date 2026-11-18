import { expect, test } from 'bun:test';
import { type BarPrice, PriceScaleMode } from 'lightweight-charts';
import { axisSpace, axisUnit, fmtTick, layoutHeads, linearTicks, logTicks, textOn, unitPriceFormat } from './axisDecor';

test('轴单位:上万 ×1,000、上千万 ×1M,更小不缩', () => {
  expect(axisUnit(9_999)).toBeUndefined();
  expect(axisUnit(24_000)).toEqual({ div: 1e3, label: '×1,000' });
  expect(axisUnit(3e7)).toEqual({ div: 1e6, label: '×1M' });
});

test('刻度:线性按 1/2/5 步长;对数每个数量级取 1/2/5,太密只取 1,窄到一个数量级内退回线性', () => {
  expect(linearTicks(20, 120, 5)).toEqual([20, 40, 60, 80, 100, 120]);
  expect(linearTicks(0.3, 0.9, 3)).toEqual([0.4, 0.6, 0.8]);
  expect(logTicks(2, 600, 20)).toEqual([2, 5, 10, 20, 50, 100, 200, 500]);
  expect(logTicks(2, 600, 4)).toEqual([10, 100]);
  expect(logTicks(3, 9, 3)).toEqual(linearTicks(3, 9, 3));
  expect(fmtTick(24)).toBe('24');
  expect(fmtTick(2.375)).toBe('2.38');
});

test('色块字色:深色底白字、浅色底黑字(同图表库原生标签);认不出的颜色退回白字', () => {
  expect(textOn('#f05a14')).toBe('#ffffff');
  expect(textOn('#1d3fd6')).toBe('#ffffff');
  expect(textOn('#facc15')).toBe('#000000');
  expect(textOn('#a3e635')).toBe('#000000');
  expect(textOn('red')).toBe('#ffffff');
});

test('刻度上的数:百分比 / 起点 100 按可视区第一根换算、可换回价格;普通写价格(上万按单位缩);缺基准退回写价格', () => {
  const pct = axisSpace(PriceScaleMode.Percentage, 80, undefined);
  expect(pct.toLabel(88)).toBeCloseTo(10);
  expect(pct.fromLabel(10)).toBeCloseTo(88);
  expect(pct.text(-12.5)).toBe('-12.5%');

  const idx = axisSpace(PriceScaleMode.IndexedTo100, 80, undefined);
  expect(idx.toLabel(88)).toBeCloseTo(110);
  expect(idx.fromLabel(110)).toBeCloseTo(88);
  expect(idx.text(110)).toBe('110');

  const plain = axisSpace(PriceScaleMode.Normal, 80, axisUnit(20_000));
  expect(plain.toLabel(18_000)).toBe(18_000);
  expect(plain.text(18_000)).toBe('18');

  expect(axisSpace(PriceScaleMode.Percentage, undefined, undefined).text(88)).toBe('88');
  expect(axisSpace(PriceScaleMode.Logarithmic, undefined, undefined).ticks(1, 1000, 8)).toEqual(logTicks(1, 1000, 8));
});

test('layoutHeads:放得下就写在自己那根轴上方;太长往里挪、不压外侧那个,最里面的伸进图表区(负数)', () => {
  // 原生那截 0~40,外侧一根从 40 起;字宽 30 都放得下
  const at = (outerW: number) =>
    layoutHeads(
      [
        { want: 8, w: 30 },
        { want: 47, w: outerW },
      ],
      92,
    );
  expect(at(30)).toEqual([8, 47]);
  // 外侧的太长:往左挪到右端放得下,里面那个再往左让(隔 6)
  expect(at(60)).toEqual([-4, 32]);
  // 单独一个超长的(「×1,00000」):右端顶住画布,左边伸进图表区
  expect(layoutHeads([{ want: 8, w: 80 }], 60)).toEqual([-20]);
});

test('unitPriceFormat:没单位但轴顶有单位那一行时,照默认两位小数写,只去掉落进那一行的刻度', () => {
  const f = unitPriceFormat(undefined, (p) => p > 100);
  if (f.type !== 'custom') throw new Error('应为 custom');
  const p = (n: number) => n as BarPrice;
  expect(f.formatter(p(-1.5))).toBe('\u22121.50');
  expect(f.tickmarksFormatter?.([p(50), p(150)])).toEqual(['50.00', '']);
  expect(unitPriceFormat(undefined).type).toBe('price');
});
