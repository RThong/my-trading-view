/**
 * 带超时的 fetch:公网数据源默认不设 deadline,挂住的连接会让无人值守的 job
 * 永久卡在 running(配合 getJobHealth 就成了「静默卡死」)。用原生 AbortSignal.timeout
 * 给每个请求兜一个硬上限,超时即抛 TimeoutError → job 记 failed,下次触发重试。
 *
 * ponytail: 单一超时、无重试/退避。若某源经常临界超时,再按源调 timeoutMs 或加有限重试。
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
