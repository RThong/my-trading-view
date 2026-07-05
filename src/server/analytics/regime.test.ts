import { test, expect } from 'bun:test';
import { subtractAligned } from './regime';

test('日频相减:逐日 A - B', () => {
  const a = [{ date: '2020-01-01', value: 10 }, { date: '2020-01-02', value: 12 }];
  const b = [{ date: '2020-01-01', value: 3 }, { date: '2020-01-02', value: 4 }];
  expect(subtractAligned([a, b])).toEqual([
    { date: '2020-01-01', value: 7 },
    { date: '2020-01-02', value: 8 },
  ]);
});

test('周频前向填充到日频:WALCL 只在周一有值,中间日沿用', () => {
  const walcl = [{ date: '2020-01-06', value: 100 }, { date: '2020-01-13', value: 110 }]; // 周频
  const daily = [{ date: '2020-01-06', value: 1 }, { date: '2020-01-08', value: 2 }, { date: '2020-01-13', value: 3 }];
  expect(subtractAligned([walcl, daily])).toEqual([
    { date: '2020-01-06', value: 99 },   // 100 - 1
    { date: '2020-01-08', value: 98 },   // 100(前填) - 2
    { date: '2020-01-13', value: 107 },  // 110 - 3
  ]);
});

test('起点对齐:某序列晚开始,输出从分量齐全日起', () => {
  const a = [{ date: '2020-01-02', value: 5 }];      // 晚一天开始
  const b = [{ date: '2020-01-01', value: 1 }, { date: '2020-01-02', value: 2 }];
  expect(subtractAligned([a, b])).toEqual([{ date: '2020-01-02', value: 3 }]); // 01-01 缺 a,跳过
});

test('三序列净流动性:WALCL - TGA - RRP', () => {
  const w = [{ date: '2020-01-01', value: 100 }];
  const t = [{ date: '2020-01-01', value: 20 }];
  const r = [{ date: '2020-01-01', value: 5 }];
  expect(subtractAligned([w, t, r])).toEqual([{ date: '2020-01-01', value: 75 }]);
});
