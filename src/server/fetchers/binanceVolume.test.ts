import { describe, expect, test } from 'bun:test';
import { dailyQuoteVolume } from './binanceVolume';

const DAY = 86_400_000;
const START = Date.UTC(2017, 7, 17);
function k(i: number, quote: string): [number, string, string, string, string, string, number, string] {
  const open = START + i * DAY;
  return [open, '1', '1', '1', '1', '1', open + DAY - 1, quote];
}

describe('dailyQuoteVolume', () => {
  // now 落在第 3 天(下标 2)中午:前两天已收盘,第 3 天还在累计
  const now = START + 2 * DAY + 12 * 3_600_000;

  test('USDT → 亿美元;当天的那根不出点(按开盘时间判,不信源的收盘时间)', () => {
    expect(dailyQuoteVolume([k(0, '150000000'), k(1, '250000000.5'), k(2, '1')], now)).toEqual([
      { date: '2017-08-17', value: 1.5 },
      { date: '2017-08-18', value: 2.500000005 },
    ]);
    // 源把当天那根的收盘时间写错成过去,也照样不出点
    const early = k(2, '1');
    early[6] = START;
    expect(dailyQuoteVolume([k(0, '1'), k(1, '1'), early], now)).toHaveLength(2);
  });

  test('缺一天 / 不从 2017-08-17 开始 / 尾部截短 / 坏值 → 抛错', () => {
    expect(() => dailyQuoteVolume([k(0, '1'), k(2, '1')], now + 2 * DAY)).toThrow('不连续');
    expect(() => dailyQuoteVolume([k(1, '1')], now)).toThrow('不连续');
    expect(() => dailyQuoteVolume([k(0, '1')], now + 5 * DAY)).toThrow('不是昨天');
    expect(() => dailyQuoteVolume([k(0, '1'), k(1, `1${'0'.repeat(400)}`)], now)).toThrow('坏行');
    expect(() => dailyQuoteVolume([k(0, ''), k(1, '1')], now)).toThrow('坏行');
    expect(() => dailyQuoteVolume([k(0, '-1'), k(1, '1')], now)).toThrow('坏行');
  });
});
