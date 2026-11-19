import { describe, expect, test } from 'bun:test';
import { parseRoute, routeExists, routeHash } from './route';

describe('parseRoute', () => {
  test('内置 / 自建,tab 可省', () => {
    expect(parseRoute('#/options/skew')).toEqual({ custom: false, persp: 'options', tab: 'skew' });
    expect(parseRoute('#/c/a1b2c3d4/e5f6a7b8')).toEqual({ custom: true, persp: 'a1b2c3d4', tab: 'e5f6a7b8' });
    expect(parseRoute('#/c/a1b2c3d4')).toEqual({ custom: true, persp: 'a1b2c3d4' });
    expect(parseRoute('#/credit')).toEqual({ custom: false, persp: 'credit' });
  });

  test('空的 / 只有 c / 写坏的转义 → null', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#/')).toBeNull();
    expect(parseRoute('#/c')).toBeNull();
    expect(parseRoute('#/%E0%A4%A')).toBeNull();
  });
});

test('routeExists:视角在、tab 省略或在才算', () => {
  const tabsOf = (custom: boolean, persp: string) => (!custom && persp === 'credit' ? ['credit', 'lev'] : undefined);

  expect(routeExists({ custom: false, persp: 'credit' }, tabsOf)).toBe(true);
  expect(routeExists({ custom: false, persp: 'credit', tab: 'lev' }, tabsOf)).toBe(true);
  expect(routeExists({ custom: false, persp: 'credit', tab: 'nope' }, tabsOf)).toBe(false);
  expect(routeExists({ custom: true, persp: 'credit' }, tabsOf)).toBe(false);
});

test('routeHash 与 parseRoute 互逆', () => {
  const routes = [
    { custom: false, persp: 'options', tab: 'skew' },
    { custom: true, persp: 'p 1', tab: '中文/斜杠' },
    { custom: true, persp: 'p1' },
  ];

  routes.forEach((r) => {
    expect(parseRoute(routeHash(r))).toEqual(r);
  });
});
