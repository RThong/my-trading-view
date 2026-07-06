import { openDb } from './db';

// 一次性:删掉 OIS 改用 Eris 后冗余的 Pensford 序列(保留 FF*/FEDFUNDS 供 Fed 路径)。
// 幂等,可重复跑。运行:bun run src/server/storage/cleanupPensford.ts
if (import.meta.main) {
  const db = openDb();
  const info = db.run(
    `DELETE FROM market_series
     WHERE series_id LIKE 'SOFRSWAP%' OR series_id LIKE 'TREASURY%' OR series_id LIKE 'SOFRTERM%'
        OR series_id IN ('SOFR', 'SOFR_M1', 'SOFR_M3', 'SOFR_M6')`,
  );
  db.close();
  console.log(`Cleaned up ${info.changes} redundant Pensford rows.`);
}
