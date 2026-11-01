import { expect, test } from 'bun:test';
import { clampLagRange } from './AnalysisPanel';

test('clampLagRange:夹进 ±750、取整、保证 min < max', () => {
  expect(clampLagRange(-40, 180)).toEqual({ min: -40, max: 180 });
  expect(clampLagRange(-99999, 99999)).toEqual({ min: -750, max: 750 });
  expect(clampLagRange(200, -10.4)).toEqual({ min: -10, max: 200 });
  expect(clampLagRange(5, 5)).toEqual({ min: 5, max: 6 });
  expect(clampLagRange(9999, 9999)).toEqual({ min: 749, max: 750 });
});
