// 搜索框里的 Yahoo 代码搜索:停止输入 300ms 后才发请求,同一关键字 SWR 去重缓存。
import { useEffect, useState } from 'react';
import useSWR from 'swr';

export type YahooHit = { symbol: string; name: string; type: string; exchange: string };

const DEBOUNCE_MS = 300;
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };
const NO_HITS: YahooHit[] = [];

async function getHits(url: string): Promise<YahooHit[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<YahooHit[]>;
}

/** 关键字能不能拿去问 Yahoo(含英文字母或数字)。 */
export const searchable = (q: string) => /[A-Za-z0-9]/.test(q);

export function useYahooSearch(query: string) {
  const [debounced, setDebounced] = useState(query.trim());

  // 防抖:只是延后同步一个值,计时器是真正的副作用
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Yahoo 只认英文名 / 代码:关键字里一个英文字母或数字都没有(纯中文)就不去问了
  const key = searchable(debounced) ? `/api/yahoo/search?q=${encodeURIComponent(debounced)}` : null;
  const { data = NO_HITS, isLoading, error } = useSWR(key, getHits, SWR_OPTS);

  // 输入还没停下来时也算「搜索中」,免得先闪一下「没有结果」
  return {
    hits: key ? data : NO_HITS,
    isLoading: searchable(query.trim()) && (debounced !== query.trim() || isLoading),
    error: error as Error | undefined,
  };
}
