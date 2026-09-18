import { fetchWithTimeout } from './http';

// Computable GPU Index(CGI):公开 REST,匿名只读,免 key。滚动窗口(不可回溯补更早的历史)。
// 采集器与算法开源:github.com/getcomputable/gpu-index(Apache-2.0,CHANGELOG 记每次换代的生效时间)。
// ⚠️ 粒度**不是固定 15 分钟**,保留窗口也**不是** /v1/methodology 自称的 90 天 —— 两者都在变,别写死:
//   2026-09-18 实测窗口 H100/H200 回到 08-23(26 天)、B200 到 08-16(33 天)、B300 到 08-10(39 天),
//   比 2026-09 初实测的 17/24/30 天更长(窗口在变长,所以余量只会更宽松,不会更紧)。
//   粒度实测改过三档(6h → 1h → 15min),各 SKU 切换日还不同(H100 在 08-24 进 1h、08-28 进 15min;
//   B200/B300 在 08-24 才从 6h 进 1h)。下面 HISTORY_LIMIT/MAX_PAGES 的余量因此远远够用(实测
//   limit=2880 时 next_cursor 直接是 null,一页就取完全部历史),但别照「15 分钟 × N 天」去推容量。
// 官方发布的 SKU 只有这 4 个(GET /v1/methodology 的 skus 字段实测确认;H100/H200 内部即 SXM 口径,
// BROAD 变体虽在 GitHub config 里但未对外发布,请求返回 404 unknown_sku)。
//
// 方法论会换代,每个观测点自带 `methodology_id`(如 `h100_sxm_v1_calc_v16`),我们**故意不读**:
// 2026-09-18 逐日量过两次换代(09-03 H100/H200 加席 Hyperbolic v8→v10;09-15 四条线全上一小时 EWMA
// 平滑 + carried vote,v10→v16 / v14→v17),**换代日的日均值变化量小于相邻普通日的变化量** ——
// 断点埋在日内噪音里不可识别,加标注等于加噪音。换代日那天会混两代 id(切换不卡日界)。
// 真要重查:curl 全量 history,按 UTC 日聚合后看 methodology_id 变的那天有没有台阶。
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

/**
 * 每 SKU 每天一个 period rate = 当日(UTC)全部 ok 观测点的**算术**平均。
 * ⚠️ 方法论口径是「时间平均」,两者相等的前提是当日采样间隔均匀 —— 这个前提**已经破过一次**:
 * H100 在 2026-08-23 只有 20 个点(非整日),当日均值确实被细粒度那半天加权过重、静默偏移。
 * 真要挡住得按相邻点间隔做梯形加权;不做是因为偏移的那天正随滚动窗口滑出去,且只影响窗口最老一格。
 * 别把「换粒度恰好卡在日界」当成保证 —— 它只在后来那两次成立。
 */
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

// 文档写 limit 上限 20000,实测服务端在 2950~2999 之间才是真上限(2950 → 200、3000 → 400 invalid_request)。
// 取 2880 踩在实测安全线内。实测这个值已经一页取完全部保留历史(next_cursor 为 null)。
const HISTORY_LIMIT = 2880;
// 接口 newest-first + cursor 分页。当前一页就够(见上),留 5 页是为了「源哪天延长保留窗口 / 再调细粒度」
// 时不会因只翻一页而永久漏掉旧历史 —— 这个上限是防呆,不是按当前数据量算出来的。
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
