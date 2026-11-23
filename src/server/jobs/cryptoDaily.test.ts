import { expect, test } from 'bun:test';
import { cryptoOwnsArchiveSync } from './cryptoDaily';

test('cryptoOwnsArchiveSync:只在 JST 周日、周一(daily 不跑的两天)由 crypto 同步存档;按日本时间切日', () => {
  // 2026-11-22 是周日、11-23 周一、11-24 周二(JST)
  expect(cryptoOwnsArchiveSync(new Date('2026-11-22T02:00:00Z'))).toBe(true);
  expect(cryptoOwnsArchiveSync(new Date('2026-11-23T13:00:00Z'))).toBe(true);
  expect(cryptoOwnsArchiveSync(new Date('2026-11-24T02:00:00Z'))).toBe(false);
  expect(cryptoOwnsArchiveSync(new Date('2026-11-21T13:00:00Z'))).toBe(false); // JST 周六 22 点
  expect(cryptoOwnsArchiveSync(new Date('2026-11-23T15:30:00Z'))).toBe(false); // UTC 还是周一,JST 已是周二 00:30
});
