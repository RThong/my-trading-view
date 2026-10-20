import { describe, expect, it } from 'bun:test';
import { claimRefresh, serverRefreshMs } from './useServerRefresh';

describe('serverRefreshMs', () => {
  it('后台刷新中 5s;不完整 5 分钟;都不是则不轮询;refreshing 优先', () => {
    expect(serverRefreshMs({ refreshing: true })).toBe(5000);
    expect(serverRefreshMs({ partial: true })).toBe(5 * 60 * 1000);
    expect(serverRefreshMs({ refreshing: true, partial: true })).toBe(5000);
    expect(serverRefreshMs({})).toBe(0);
  });
});

describe('claimRefresh(同 key 多实例节流)', () => {
  it('一个间隔内同 key 只放行一次;到下一个间隔再放行;不同 key 互不影响', () => {
    const ms = 5000;
    const t0 = 1_000_000;
    // N 个挂载实例同一时刻到点 → 只有第一个真发
    expect([0, 1, 2].map(() => claimRefresh('/k', ms, t0))).toEqual([true, false, false]);
    expect(claimRefresh('/other', ms, t0)).toBe(true);
    // 各实例 setInterval 起点有先后(几百 ms 抖动),下一轮照样只放行一次
    expect(claimRefresh('/k', ms, t0 + ms - 300)).toBe(true);
    expect(claimRefresh('/k', ms, t0 + ms)).toBe(false);
  });
});
