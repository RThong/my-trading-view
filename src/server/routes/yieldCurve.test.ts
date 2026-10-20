import { describe, expect, it } from 'bun:test';
import { fillFromPrev, yieldCurveRoute } from './yieldCurve';

describe('yieldCurveRoute source 校验', () => {
  it('未知 source → 400,不静默兜底成 treasury', async () => {
    const res = await yieldCurveRoute.request('/?source=breakeven');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('breakeven');
  });

  it('原型链上的名字(toString / __proto__ / constructor)同样 400', async () => {
    const statuses = await Promise.all(
      ['toString', '__proto__', 'constructor'].map(
        async (s) => (await yieldCurveRoute.request(`/?source=${s}`)).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400]);
  });
});

describe('fillFromPrev', () => {
  const p = (value: number) => [{ date: '2026-10-16', value }];

  it('现拉失败的期限用上一份顶上,记入 fallback;上一份也没有的照旧 unavailable', () => {
    const prev = { tenors: ['1Y', '10Y', '30Y'], series: { '1Y': p(4), '10Y': p(5) }, unavailable: ['30Y'] };
    const fresh = { tenors: ['1Y', '10Y', '30Y'], series: { '1Y': p(4.1) }, unavailable: ['10Y', '30Y'] };

    expect(fillFromPrev(fresh, prev)).toEqual({
      tenors: ['1Y', '10Y', '30Y'],
      series: { '1Y': p(4.1), '10Y': p(5) },
      unavailable: ['30Y'],
      fallback: ['10Y'],
    });
  });

  it('没有上一份 → 原样返回', () => {
    const fresh = { tenors: ['1Y'], series: {}, unavailable: ['1Y'] };
    expect(fillFromPrev(fresh, null)).toBe(fresh);
  });
});
