import { expect, test } from 'bun:test';
import { earliestIso, latestIso } from './isoDate';

test('latestIso:按时间取最晚,和输入顺序无关', () => {
  expect(latestIso(['2026-01-02', '2026-03-04', '2025-12-31'])).toBe('2026-03-04');
  expect(latestIso(['2026-03-04'])).toBe('2026-03-04');
});

test('latestIso:空数组抛错(调用方先判非空)', () => {
  expect(() => latestIso([])).toThrow();
});

test('earliestIso:按时间取最早,和输入顺序无关', () => {
  expect(earliestIso(['2026-01-02', '2025-12-31', '2026-03-04'])).toBe('2025-12-31');
});
