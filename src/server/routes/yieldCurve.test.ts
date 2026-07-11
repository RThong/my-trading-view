import { describe, expect, it } from 'bun:test';
import { yieldCurveRoute } from './yieldCurve';

describe('yieldCurveRoute source 校验', () => {
  it('未知 source → 400,不静默兜底成 treasury', async () => {
    const res = await yieldCurveRoute.request('/?source=breakeven');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('breakeven');
  });
});
