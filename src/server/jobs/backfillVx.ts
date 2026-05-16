/**
 * One-shot backfill of VIX futures front-month settlement (symbol 'VX1') from
 * the entire CBOE VX history (2013 to today). Subsequent updates are handled
 * by the daily job which only re-fetches recent contracts.
 *
 *   bun run backfill:vx
 */

import { openDb, migrate } from '../storage/db';
import { insertQuotes } from '../storage/repository';
import { fetchVxFrontMonthSeries } from '../fetchers/cboeVx';

async function main(): Promise<void> {
  const db = openDb();
  try {
    migrate(db);
    const t0 = Date.now();
    console.log('Backfilling VIX futures (VX1) from CBOE...');
    const rows = await fetchVxFrontMonthSeries({
      freshSince: '1900-01-01', // grab everything
      concurrency: 12,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`  ${done}/${total} contracts fetched (${((done / total) * 100).toFixed(0)}%)`);
        }
      },
    });
    insertQuotes(db, rows, 'cboe');
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Inserted ${rows.length} VX1 rows in ${dt}s`);
    if (rows.length > 0) {
      console.log(`  earliest: ${rows[0].tradeDate}  (close ${rows[0].close})`);
      console.log(`  latest:   ${rows[rows.length - 1].tradeDate}  (close ${rows[rows.length - 1].close})`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
