import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, type MacroRow } from '../storage/repository';
import { createFredFetcher } from '../fetchers/fred';
import { CREDIT_RATING, CREDIT_TERM } from '../../shared/rateCurveDefs';
import { HISTORY_START_DATE } from '../config';

/** 信用 tab 用到的全部 ICE BofA 利差:HY 总指数 + 评级梯队 + 期限梯队。series_id 就用 FRED 的 id */
export const CREDIT_SPREAD_IDS = [
  'BAMLH0A0HYM2',
  ...CREDIT_RATING.map((c) => c.series),
  ...CREDIT_TERM.map((c) => c.series),
];

type FetchSeries = (id: string, since: string) => Promise<MacroRow[]>;

/**
 * ICE BofA 利差 → market_series(本地镜像)。
 * 为什么要落库:FRED 从 2026-04 起这批序列只留最近 3 年(序列说明原文 "will only include 3 years of observations"),
 * 窗口每天往前挪,ALFRED 旧 vintage 也一并截了 —— 不存,最早那天每天丢一天。读时现拉优先、库兜底(preferLive)。
 * 每轮全量覆盖写(值会被 ICE 事后修订,upsert 盖掉);没有删除路径:窗口外的旧日子只在库里。
 * 直接运行:bun run src/server/jobs/creditSpreadSnapshot.ts
 */
export async function updateCreditSpreads(
  db: Database,
  fetchSeries: FetchSeries = defaultFetch,
): Promise<{ total: number; succeeded: number; failures: string[] }> {
  const settled = await Promise.allSettled(CREDIT_SPREAD_IDS.map((id) => fetchSeries(id, HISTORY_START_DATE)));
  const rows = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  // 200 但零行也算失败:FRED 改名 / 下架时常是这样,不报就悄悄断更
  const failures = settled.flatMap((s, i) =>
    s.status === 'rejected'
      ? [`${CREDIT_SPREAD_IDS[i]}: ${(s.reason as Error).message}`]
      : s.value.length
        ? []
        : [`${CREDIT_SPREAD_IDS[i]}: 无数据`],
  );

  insertMarketSeries(db, rows);

  return { total: rows.length, succeeded: CREDIT_SPREAD_IDS.length - failures.length, failures };
}

function defaultFetch(id: string, since: string): Promise<MacroRow[]> {
  return createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' }).fetchSeries(id, since);
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, succeeded, failures } = await updateCreditSpreads(db);
  db.close();
  console.log(`信用利差落库:${succeeded}/${CREDIT_SPREAD_IDS.length} 条成功,共 ${total} 行。`);
  if (failures.length) console.log(`失败:${failures.join('; ')}`);
}
