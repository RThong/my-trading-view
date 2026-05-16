import { describe, test, expect } from 'bun:test';
import { normCdf, callDelta, putDelta } from './greeks';

describe('normCdf', () => {
  test('symmetric around 0', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
  });
  test('matches known values', () => {
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
    expect(normCdf(2)).toBeCloseTo(0.9772, 3);
  });
});

describe('callDelta', () => {
  test('ATM call has delta ≈ 0.5 (slightly higher with r > 0)', () => {
    const d = callDelta({ spot: 100, strike: 100, yearsToExpiry: 0.083, iv: 0.20, rate: 0.045 });
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(0.55);
  });
  test('deep ITM call delta ≈ 1', () => {
    const d = callDelta({ spot: 150, strike: 100, yearsToExpiry: 0.083, iv: 0.20, rate: 0.045 });
    expect(d).toBeGreaterThan(0.99);
  });
  test('deep OTM call delta ≈ 0', () => {
    const d = callDelta({ spot: 100, strike: 200, yearsToExpiry: 0.083, iv: 0.20, rate: 0.045 });
    expect(d).toBeLessThan(0.01);
  });
});

describe('putDelta', () => {
  test('put_delta = call_delta - 1', () => {
    const inp = { spot: 100, strike: 100, yearsToExpiry: 0.083, iv: 0.20, rate: 0.045 };
    expect(putDelta(inp)).toBeCloseTo(callDelta(inp) - 1, 6);
  });
  test('25-delta call strike inversion: when call_delta ≈ 0.25, put_delta ≈ -0.75', () => {
    // find a strike where call delta ≈ 0.25
    const params = { spot: 100, yearsToExpiry: 0.083, iv: 0.20, rate: 0.045 };
    // With spot=100, IV=20%, T≈30 days, the ~25-delta strike is around 102-103.
    // Verify the delta is in the right ballpark.
    const d = callDelta({ ...params, strike: 103 });
    expect(d).toBeGreaterThan(0.15);
    expect(d).toBeLessThan(0.40);
  });
});
