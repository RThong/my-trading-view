import { describe, expect, test } from 'bun:test';
import { Magnet } from 'lucide-react';
import { modeOf, runPlugins } from './index';
import type { PointCtx, PointPlugin } from './types';

const ctx: PointCtx = {
  x: 0,
  y: 0,
  bar: null,
  toY: () => null,
  anchor: null,
  shift: false,
  onlyTime: false,
  dragging: false,
};
const p = { time: '2026-03-13', value: 100 };
// 两个只改数值的假插件,看得出执行顺序
function plugin(id: string, f: (v: number) => number): PointPlugin {
  return {
    id,
    name: id,
    icon: Magnet,
    modes: [{ id: 'a', name: 'a', hint: '' }],
    apply: (pt) => ({ ...pt, value: f(pt.value) }),
  };
}
const add = plugin('add', (v) => v + 1);
const dbl = plugin('dbl', (v) => v * 2);

describe('runPlugins', () => {
  test('全关:原样返回(同一个对象)', () => {
    expect(runPlugins(p, ctx, {}, [add, dbl])).toBe(p);
    expect(runPlugins(p, ctx, { add: { on: false, mode: 'a' } }, [add, dbl])).toBe(p);
  });

  test('按数组顺序执行;关掉中间一个,其余顺序不变', () => {
    const on = { on: true, mode: 'a' };
    expect(runPlugins(p, ctx, { add: on, dbl: on }, [add, dbl]).value).toBe(202);
    expect(runPlugins(p, ctx, { add: on, dbl: on }, [dbl, add]).value).toBe(201);
    expect(runPlugins(p, ctx, { dbl: on }, [add, dbl]).value).toBe(200);
  });
});

test('modeOf:存档里的模式不在声明里就用第一个', () => {
  expect(modeOf({ add: { on: true, mode: 'zzz' } }, add)).toBe('a');
  expect(modeOf({}, add)).toBe('a');
});
