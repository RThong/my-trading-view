import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { missingCoreCds } from '../analytics/rateCurves';
import { fetchIceCds, fetchIceCdx, parseIceCds, parseIceCdx, type CdsSnapshot } from '../fetchers/iceCds';
import { readArchived, type ArchiveRun } from '../fetchers/snapshotArchive';

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
// 清算日不像日期(端点结构变了)就整份不写,免得写出 obs_date 为空的行;本机实抓时这一份记缺失(当天重跑)
function dated(s: CdsSnapshot | null): CdsSnapshot | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s : null;
}

function storeIce(db: Database, rawSnap: CdsSnapshot | null, rawIndex: CdsSnapshot | null): number {
  const [snap, index] = [dated(rawSnap), dated(rawIndex)];
  const rows = [
    ...(snap?.points ?? []).map((p) => ({ seriesId: `ICE_CDS_${p.ticker}`, obsDate: snap!.date, value: p.price })),
    ...(index?.points ?? []).map((p) => ({ seriesId: `ICE_${p.ticker}`, obsDate: index!.date, value: p.price })),
  ];
  insertMarketSeries(db, rows);
  return rows.length;
}

/** 把 Actions 存档(见 fetchers/snapshotArchive)里的 ICE 文件补进库:本机没开 / 没网的那几天靠它。
 *  结算价按清算日存、同日重写值不变,所以每轮把存档里的都重写一遍即可。 */
export function ingestArchivedIce(db: Database, runs: ArchiveRun[]): number {
  return runs
    .map((run) => {
      // 一轮里有坏文件只跳过这一轮,不挡后面的轮次
      try {
        const has = (n: string) => run.names.has(n);
        const snap = has('icc-single-names') ? parseIceCds(JSON.parse(readArchived(run, 'icc-single-names'))) : null;
        const index = has('icc-indexes') ? parseIceCdx(JSON.parse(readArchived(run, 'icc-indexes'))) : null;
        return storeIce(db, snap, index);
      } catch (err) {
        console.warn(`ICE 存档 ${run.dir} 写库失败,跳过:${(err as Error).message}`);
        return 0;
      }
    })
    .reduce((a, b) => a + b, 0);
}

export async function updateIceCds(
  db: Database,
  fetchSnap: () => Promise<CdsSnapshot> = fetchIceCds,
  fetchIndex: () => Promise<CdsSnapshot> = fetchIceCdx,
): Promise<{ total: number; missing: string[] }> {
  const [snapR, indexR] = await Promise.allSettled([fetchSnap(), fetchIndex()]);
  const raw = snapR.status === 'fulfilled' ? snapR.value : null;
  const rawIndex = indexR.status === 'fulfilled' ? indexR.value : null;
  const total = storeIce(db, raw, rawIndex);
  const [snap, index] = [dated(raw), dated(rawIndex)];
  // 单名是这个 job 的主体:挂了照旧整轮抛(daily 记 failed 带原因),只是 CDX 已经先写进去了。
  // 两边同时挂(同在 www.ice.com,被拦 / 整站故障时常一起挂)要把 CDX 的原因也带上,否则状态板看不出 CDX 也缺了
  if (snapR.status === 'rejected')
    throw indexR.status === 'rejected'
      ? new Error(`单名:${(snapR.reason as Error).message};CDX:${(indexR.reason as Error).message}`)
      : snapR.reason;

  const gotCdx = new Set(index?.points.map((p) => p.ticker));
  const cdxWhy =
    indexR.status === 'rejected'
      ? `(${(indexR.reason as Error).message})`
      : index
        ? ''
        : `(清算日不合法:${rawIndex?.date || '空'})`;
  return {
    total,
    missing: [
      ...(snap ? [] : [`单名清算日不合法:${raw?.date || '空'}`]),
      ...missingCoreCds(new Set(snap?.points.map((p) => p.ticker))),
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
