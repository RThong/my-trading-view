import { useEffect } from 'react';

/**
 * 服务端回的是旧数据(`refreshing`:缓存过期、后台刷新中)或不完整的(`partial`:有源没拉到、等重试)时,
 * 定时再取一次;状态变了(拿到新数据)间隔跟着变,两者都不成立即停。见 server/routes/swrCache。
 *
 * ⚠️ 不用 SWR 的 `refreshInterval: (data) => …`:swr 2.4 只在**挂载那一刻**算一次间隔(源码 Polling 段的
 * effect 依赖里没有 data),那时数据还没到 → 0 → 永不轮询。正好是「服务端重启后刷新页面」这个最该轮询的场景。
 * 用 setInterval 而不是逐次 setTimeout:SWR 拿到深度相等的数据不换引用,按 data 重排定时器会断档。
 */
type ServerFlags = { refreshing?: boolean; partial?: boolean };

/** 轮询间隔(ms,0 = 不轮询)。refreshing:后台刷新一般几秒~几十秒就完;partial:服务端 10 分钟一试,这边 5 分钟取一次把重试带起来。 */
export const serverRefreshMs = (flags: ServerFlags): number =>
  flags.refreshing ? 5000 : flags.partial ? 5 * 60 * 1000 : 0;

// 同一个 key 上次真正发出重取的时刻。keep-alive 的 tab 只藏不卸,同一 key 常有 N 个实例同时挂着,
// 每个实例各开一个定时器;而 SWR 的 mutate 会先清掉在途标记、**不去重**(swr 2.4 MUTATE_EVENT → revalidate()),
// 不节流就是 N 倍请求(regime 一次 9MB)。按 key 节流后,一个间隔里只有最先到点的那个实例真发。
const lastFired = new Map<string, number>();

/** 是否该由这次到点真发:距同 key 上次发出不足一个间隔(留 10% 抖动余量)就跳过。 */
export function claimRefresh(key: string, ms: number, now = Date.now()): boolean {
  if (now - (lastFired.get(key) ?? Number.NEGATIVE_INFINITY) < ms * 0.9) return false;
  lastFired.set(key, now);
  return true;
}

export function useServerRefresh(key: string, flags: ServerFlags, revalidate: () => unknown) {
  const ms = serverRefreshMs(flags);

  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => {
      if (claimRefresh(key, ms)) void revalidate();
    }, ms);
    return () => clearInterval(id);
  }, [key, ms, revalidate]);
}
