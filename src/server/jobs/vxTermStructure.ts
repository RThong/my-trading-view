/**
 * 更新 VIX 期限结构原料到库:VX1(近月)/ VX3(第三近)CBOE 期货结算价 → market_series;
 * 另存每份月度合约的整条曲线(`VX:<到期日>`,见 cboeVx.toContractRows)。
 * 价差 VX1−VX3 由 /api/regime 读时算(computeSpread;本 job 不算 derived)。
 *
 * 增量:按已存最新日期续抓(freshSince 只下未到期 + 近期到期的合约);库空 → 全量回填。
 * upsert 幂等,可重复跑。直接运行 = 立即更新一次(库空即全量回填):
 *   bun run src/server/jobs/vxTermStructure.ts
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate, getMarketSeriesByPrefix } from '../storage/repository';
import { VX_CONTRACT_PREFIX, fetchVxTermStructure } from '../fetchers/cboeVx';
import type { QuoteRow } from '../storage/repository';

export async function updateVxTermStructure(db: Database): Promise<{ total: number }> {
  // 增量起点:VX1 已存最新日期(VX1/VX3 同源同步,取 VX1 即可);库空 → '1900-01-01' 全量。
  // 按合约的曲线是后加的:库里还没有(老库升级 / 从旧备份恢复)→ 整轮走一次全量,全量路径对 VX1/VX3 也是正确的。
  // ponytail: 「有没有」按整族读一遍判(~2 万行,每轮一次);嫌慢再改成 LIMIT 1 的存在性查询。
  const contractsBackfilled = getMarketSeriesByPrefix(db, VX_CONTRACT_PREFIX).length > 0;
  const latest = getLatestMarketDate(db, 'VX1');
  const freshSince = latest && contractsBackfilled ? latest : '1900-01-01';
  const { vx1, vx3, contracts } = await fetchVxTermStructure({ freshSince });

  const write = (rows: QuoteRow[], id: string): number => {
    insertMarketSeries(
      db,
      rows.map((r) => ({ seriesId: id, obsDate: r.tradeDate, value: r.close })),
    );
    return rows.length;
  };
  insertMarketSeries(db, contracts);
  const total = write(vx1, 'VX1') + write(vx3, 'VX3') + contracts.length;
  return { total };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateVxTermStructure(db);
  db.close();
  console.log(`VX term structure updated: ${total} rows upserted.`);
}
