import { describe, expect, test } from 'bun:test';
import { mergeSpans } from './dayBand';

describe('mergeSpans', () => {
  test('每根盖「中心 ± 半根间距」;相邻的并成一块,隔开的分开', () => {
    // 间距 10:x=100、110 相邻(周六周日),x=170 隔了几根
    expect(mergeSpans([100, 110, 170], 10)).toEqual([
      { left: 95, right: 115 },
      { left: 165, right: 175 },
    ]);
    expect(mergeSpans([], 10)).toEqual([]);
  });
});
