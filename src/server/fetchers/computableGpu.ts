import { fetchWithTimeout } from './http';

// Computable GPU Index(CGI):公开 REST,匿名只读,免 key。15 分钟粒度,滚动窗口(不可回溯补历史更早的)。
// 官方发布的 SKU 只有这 4 个(GET /v1/methodology 的 skus 字段实测确认;H100/H200 内部即 SXM 口径,
// BROAD 变体虽在 GitHub config 里但未对外发布,请求返回 404 unknown_sku)。
const BASE = 'https://api.getcomputable.com/v1/index';
export const CGI_SKUS = ['H100', 'H200', 'B200', 'B300'] as const;
export type CgiSku = (typeof CGI_SKUS)[number];

type CgiHistoryPoint = {
  observed_at: string;
  value_usd_gpu_hr: number | null;
  status: string;
};

type CgiHistoryPage = { data: { values: CgiHistoryPoint[]; next_cursor: string | null } };

export type CgiDailyPoint = { date: string; value: number };

const doFetch0 = fetchWithTimeout;

/** 每 SKU 每天一个 period rate = 当日(UTC)全部 ok 观测点的时间平均(方法论定义的 period rate 口径)。 */
export function toDailyAverages(points: CgiHistoryPoint[]): CgiDailyPoint[] {
  const byDate = new Map<string, number[]>();
  for (const p of points) {
    if (p.status !== 'ok' || p.value_usd_gpu_hr == null) continue;
    const date = p.observed_at.slice(0, 10);
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(p.value_usd_gpu_hr);
  }
  return [...byDate.entries()]
    .map(([date, vs]) => ({ date, value: vs.reduce((a, b) => a + b, 0) / vs.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 文档写 limit 上限 20000,实测服务端在 2950~2999 之间才是真上限(超了直接 400 invalid_request)。
// 取 2880 = 30 天 × 15 分钟粒度,踩在实测安全线内、留够余量。
const HISTORY_LIMIT = 2880;
// 接口 newest-first + cursor 分页;90 天窗口 ÷ 15 分钟 ≈ 8640 点 ≈ 3 页,5 页留够余量,
// 兜住「job 断了一阵子、要一次性把服务端还留着的旧历史补全」这种场景,不会因只翻一页而永久漏掉。
const MAX_PAGES = 5;

/** 幂等覆盖,不做增量抓取(每次都从最新往回翻到没有更旧数据为止)。 */
export async function fetchGpuIndexDaily(sku: CgiSku, doFetch = doFetch0): Promise<CgiDailyPoint[]> {
  const points: CgiHistoryPoint[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = `limit=${HISTORY_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await doFetch(`${BASE}/${sku}/history?${qs}`);
    if (!res.ok) throw new Error(`Computable GPU Index(${sku})下载失败:${res.status}`);
    const body = (await res.json()) as CgiHistoryPage;
    points.push(...body.data.values);
    cursor = body.data.next_cursor;
    if (!cursor) break;
  }
  return toDailyAverages(points);
}
