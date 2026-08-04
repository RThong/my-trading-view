/**
 * 带超时的 fetch:公网数据源默认不设 deadline,挂住的连接会让无人值守的 job
 * 永久卡在 running(配合 getJobHealth 就成了「静默卡死」)。用原生 AbortSignal.timeout
 * 给每个请求兜一个硬上限,超时即抛 TimeoutError → job 记 failed,下次触发重试。
 *
 * 默认无重试:多数源能回填,下次触发重来即可。**快照型源例外**(见 withRetry)。
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** 标记「不该重试」的错误:源明确拒绝了(参数错、找不到标的),重试不会自愈。 */
export class NonRetryableError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 有限重试(再试 1 次,默认 1.5s 后)。**只给快照型源用** —— 那类源不可回填,
 * 一次网络抖动 = 那天的数据永久缺一格。可回填的源不要用:下次触发自然补上,重试只是白等。
 *
 * ⚠️ **判据是黑名单:除 NonRetryableError 外一律重试。所以分类责任在调用方** ——
 * 用之前必须先把「不会自愈的失败」都标成 NonRetryableError,否则会对着同一个答复白等 1.5s。
 * 要标的不只是 HTTP 4xx,**业务判定同样要标**:比如「没拿到已收盘的快照点」「核心标的缺失」
 * 这类源已经明确答复的情形,再打一次结果不变。分类只能放在源那侧 —— 只有它知道自己的
 * error 字段和业务规则意味着什么;这里没法靠猜错误形状来做白名单(猜不中就变成不重试)。
 *
 * 次数写死 1 次:快照型源要的是「躲过一次抖动」,不是重试到底
 * (job 本身每天多次触发,那才是第二层兜底)。delayMs 可调只为测试别真睡 1.5s。
 */
export async function withRetry<T>(fn: () => Promise<T>, delayMs = 1500): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NonRetryableError) throw e;
    await sleep(delayMs);
    return fn();
  }
}
