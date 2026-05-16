/**
 * One-shot backfill of all CBOE-sourced indices from 1995-01-01 to today.
 * Use this when first switching the VIX family from Yahoo to CBOE, since
 * the incremental daily job won't pull history if some Yahoo-sourced rows
 * already exist for those symbols.
 *
 *   bun run backfill:cboe-indices
 */

import { openDb, migrate } from '../storage/db';
import { insertQuotes } from '../storage/repository';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { CBOE_INDEX_SYMBOLS } from '../config';

async function main(): Promise<void> {
  const db = openDb();
  try {
    migrate(db);
    let total = 0;
    for (const spec of CBOE_INDEX_SYMBOLS) {
      const t0 = Date.now();
      const rows = await fetchCboeIndexAsQuotes({
        cboeSymbol: spec.cboeSymbol,
        storedSymbol: spec.symbol,
        sinceDate: '1995-01-01',
      });
      insertQuotes(db, rows, 'cboe');
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const first = rows[0]?.tradeDate ?? '?';
      const last = rows[rows.length - 1]?.tradeDate ?? '?';
      console.log(`  ${spec.symbol.padEnd(8)}  ${rows.length.toString().padStart(5)} rows  ${first} → ${last}  (${dt}s)`);
      total += rows.length;
    }
    console.log(`\nDone. ${total} rows total across ${CBOE_INDEX_SYMBOLS.length} indices.`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
