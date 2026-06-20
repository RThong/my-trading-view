/**
 * 一次性回填所有来自 CBOE 的指数,覆盖从 HISTORY_START_DATE 到今天的区间。
 * 在首次把 VIX 系列的数据源从 Yahoo 切到 CBOE 时使用:因为只要这些 symbol
 * 已经存在一些来自 Yahoo 的数据行,增量式的每日 job 就不会再去拉历史。
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
