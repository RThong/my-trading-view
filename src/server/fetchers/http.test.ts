import { describe, expect, test } from 'bun:test';
import { NonRetryableError, withRetry } from './http';

describe('withRetry', () => {
  test('瞬时失败重试一次后成功', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('The operation timed out.');
        return 'ok';
      },
      1, // 测试里别真等 1.5s
    );

    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });

  test('次数用尽后把最后一个错抛出来', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      }, 1),
    ).rejects.toThrow('boom 2');
    expect(calls).toBe(2);
  });

  test('NonRetryableError 不重试 —— 源明确拒绝,再打一次还是同样答复', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new NonRetryableError('bad instrument');
      }, 1),
    ).rejects.toThrow('bad instrument');
    expect(calls).toBe(1);
  });
});
