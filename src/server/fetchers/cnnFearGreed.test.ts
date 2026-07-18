import { test, expect } from 'bun:test';
import { parseFearGreed } from './cnnFearGreed';

test('解析历史序列 x(ms)→date、y→value', () => {
  const body = {
    fear_and_greed_historical: {
      data: [
        { x: 1577836800000, y: 55.5 }, // 2020-01-01T00:00:00Z
        { x: 1577923200000, y: 60 }, // 2020-01-02
      ],
    },
  };
  expect(parseFearGreed(body)).toEqual([
    { date: '2020-01-01', value: 55.5 },
    { date: '2020-01-02', value: 60 },
  ]);
});

test('缺历史字段 → 空数组', () => {
  expect(parseFearGreed({})).toEqual([]);
});

test('同日重复点 → 去重保留最后一个(CNN 末尾常重复当天)', () => {
  const body = {
    fear_and_greed_historical: {
      data: [
        { x: 1577836800000, y: 55 }, // 2020-01-01
        { x: 1577923200000, y: 60 }, // 2020-01-02
        { x: 1577923200000 + 3_600_000, y: 62 }, // 同为 2020-01-02(晚 1 小时)
      ],
    },
  };
  expect(parseFearGreed(body)).toEqual([
    { date: '2020-01-01', value: 55 },
    { date: '2020-01-02', value: 62 }, // 保留最后一个
  ]);
});
