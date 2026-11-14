import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { missingCoreCds } from '../analytics/rateCurves';
import { fetchIceCds, fetchIceCdx, type CdsSnapshot } from '../fetchers/iceCds';

const CDX_TICKERS = ['CDX_IG', 'CDX_HY'];

/**
 * 抓 ICE 单名 CDS 当日 EOD 结算价 → market_series 的 ICE_CDS_{ticker}。
 * 存原始价(真值源);spread(bp)换算在读时做(见 yieldCurve 路由 cdsPriceToSpreadBp)。
 * 端点仅当日单快照、无历史 → 靠每天跑一次积累时间序列。幂等,同日重跑覆盖。
 * 同一轮顺带抓 CDX 北美 IG / HY 指数主力 → ICE_CDX_IG / ICE_CDX_HY(同样只有当天快照、漏一天补不回)。
 * missing = 缺失的 core 标的(默认展示的 7 家)+ 缺的 CDX(端点挂了带上原因),供 daily 决定 success/failed
 * (failed 当天后续触发点会重跑)。两个端点互不挡:一边挂了另一边照常写;单名端点挂了写完 CDX 再抛。
 * 直接运行:bun run src/server/jobs/iceCdsSnapshot.ts
 */
export async function updateIceCds(
  db: Database,
  fetchSnap: () => Promise<CdsSnapshot> = fetchIceCds,
  fetchIndex: () => Promise<CdsSnapshot> = fetchIceCdx,
): Promise<{ total: number; missing: string[] }> {
  const [snapR, indexR] = await Promise.allSettled([fetchSnap(), fetchIndex()]);
  const snap = snapR.status === 'fulfilled' ? snapR.value : null;
  const index = indexR.status === 'fulfilled' ? indexR.value : null;
  insertMarketSeries(db, [
    ...(snap?.points ?? []).map((p) => ({ seriesId: `ICE_CDS_${p.ticker}`, obsDate: snap!.date, value: p.price })),
    ...(index?.points ?? []).map((p) => ({ seriesId: `ICE_${p.ticker}`, obsDate: index!.date, value: p.price })),
  ]);
  // 单名是这个 job 的主体:挂了照旧整轮抛(daily 记 failed 带原因),只是 CDX 已经先写进去了。
  // 两边同时挂(同在 www.ice.com,被拦 / 整站故障时常一起挂)要把 CDX 的原因也带上,否则状态板看不出 CDX 也缺了
  if (snapR.status === 'rejected')
    throw indexR.status === 'rejected'
      ? new Error(`单名:${(snapR.reason as Error).message};CDX:${(indexR.reason as Error).message}`)
      : snapR.reason;

  const gotCdx = new Set(index?.points.map((p) => p.ticker));
  const cdxWhy = indexR.status === 'rejected' ? `(${(indexR.reason as Error).message})` : '';
  return {
    total: snap!.points.length + (index?.points.length ?? 0),
    missing: [
      ...missingCoreCds(new Set(snap!.points.map((p) => p.ticker))),
      ...CDX_TICKERS.filter((t) => !gotCdx.has(t)).map((t) => t + cdxWhy),
    ],
  };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateIceCds(db);
  db.close();
  console.log(`ICE CDS snapshot stored: ${total} names.`);
}
