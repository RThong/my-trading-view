// 前端取数的共用件:各面板 useSWR 的 fetcher 与选项。

/** EOD 数据一会话内视为不变:关掉全部自动重验。模块级常量,引用稳定。 */
export const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

/** 各面板 SWR 共用的 fetcher:非 2xx 要抛错,SWR 才会进 error 态而不是把错误页当数据。 */
export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}
