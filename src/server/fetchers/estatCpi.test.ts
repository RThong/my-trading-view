import { describe, expect, test } from 'bun:test';
import { estatTimeToIso, fetchCoreCoreCpiYoy, parseEstatSeries } from './estatCpi';

// 真实响应的形状(截取):倒序、`***` 缺值、单条时 VALUE 不是数组。
const body = (value: unknown, status = 0) => ({
  GET_STATS_DATA: { RESULT: { STATUS: status, ERROR_MSG: 'x' }, STATISTICAL_DATA: { DATA_INF: { VALUE: value } } },
});

describe('estatTimeToIso', () => {
  test('月值 → 当月 1 日;年值 → null', () => {
    expect(estatTimeToIso('2026000808')).toBe('2026-08-01');
    expect(estatTimeToIso('2025100000')).toBeNull();
    expect(estatTimeToIso('2025000000')).toBeNull();
  });
});

describe('parseEstatSeries', () => {
  test('倒序 → 升序;跳过 *** 与年值', () => {
    const v = [
      { '@time': '2026000808', $: '1.9' },
      { '@time': '2026000707', $: '***' },
      { '@time': '2025100000', $: '100.6' },
      { '@time': '2026000606', $: '1.7' },
    ];
    expect(parseEstatSeries(body(v))).toEqual([
      { date: '2026-06-01', value: 1.7 },
      { date: '2026-08-01', value: 1.9 },
    ]);
  });

  test('单条 VALUE 是对象不是数组', () => {
    expect(parseEstatSeries(body({ '@time': '2026000808', $: '1.9' }))).toEqual([{ date: '2026-08-01', value: 1.9 }]);
  });

  test('STATUS 非 0(如 appId 错)→ 抛错;空结果 → 抛错', () => {
    expect(() => parseEstatSeries(body([], 100))).toThrow('e-Stat');
    expect(() => parseEstatSeries(body([]))).toThrow('未解析出');
  });
});

describe('fetchCoreCoreCpiYoy', () => {
  test('网络异常不把含 appId 的 URL 带出来', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      throw new TypeError(`fetch failed: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const err = await fetchCoreCoreCpiYoy('SECRET_APP_ID', '2018-01').catch((e: Error) => e);
      expect(String(err)).not.toContain('SECRET_APP_ID');
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('SECRET_APP_ID');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
