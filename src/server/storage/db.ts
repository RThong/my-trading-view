import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../config';

const CURRENT_SCHEMA_VERSION = 4; // v4:新增 price_eod(标的 OHLC),market_series 收敛为只放波动率指数

export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // 必须**第一个**设:股票(com.mtv.daily)与加密(com.mtv.crypto)是两个独立 job、同点触发,
  // 会并发开/写同一个库。连 journal_mode=WAL / WAL 恢复(实测见过 SQLITE_BUSY_RECOVERY)本身
  // 都要抢锁 —— busy_timeout 若设在它们之后就兜不住,open 期就会 0ms 崩。放最前,让后续所有
  // 操作(含建表/迁移/批量 upsert)撞锁时等待而非瞬崩。
  db.exec('PRAGMA busy_timeout = 30000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  return db;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

// v3:期权两表的 provenance 改造。给两表补 source 普通列(不动主键),按 underlying
// 回填(BTC→deribit,其余→moomoo);并删掉 25Δ 表早期遗留、现已无用的 is_mock 列,
// 使旧库迁移后与全新库 schema.sql 的 DDL 完全一致。列探测保证幂等(新库无此表则跳过,
// 交给 schema.sql 建;已迁过的库自然跳过)。
function migrateOptionSource(db: Database): void {
  for (const table of ['option_snapshot_25delta', 'option_chain_raw']) {
    const cols = columns(db, table);
    if (!cols.length) continue; // 新库尚无此表
    if (!cols.includes('source')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'moomoo'`);
      db.exec(`UPDATE ${table} SET source = 'deribit' WHERE underlying = 'BTC'`);
    }
    if (cols.includes('is_mock')) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN is_mock`); // 仅 25Δ 表曾有,旧遗留列
    }
  }
}

// v4:market_series 收敛为「只放波动率指数」,标的现货价挪到 price_eod。
// 旧库的 market_series 里混着指数(VIX/VXN/GVZ/OVX/DVOL,留下)和现货
// (SPY/QQQ/GLD/USO/BTC/SPX/NDX 等)。把有读取方的现货按 close 播种进 price_eod
// (open/high/low 留空,下次 job 抓全 OHLC 时 upsert 覆盖),再从 market_series 删掉非指数序列。
// 这样旧库迁完即满足不变式,且 VRP 的 RV 腿(只用 close)无需等回填就能算。
// 须在 schema.sql 建出 price_eod 之后调用。幂等:INSERT OR IGNORE 不覆盖已抓的真 OHLC,
// DELETE 只动现货 id;新库/已迁库再跑都是 no-op。
// v4 要清出 market_series 的「现货序列」白名单(只删这几个,而非"删非指数")。
// 反转成删除名单而非保留名单:这样迁移只精确清掉已知现货,指数 + 未来新增序列
// (如 IV 腿 / Eris OIS 曲线等不能回填的历史)一律不受影响,避免静默误删。
const SPOT_TO_DROP = ['SPY', 'QQQ', 'GLD', 'USO', 'BTC', 'SPX', 'NDX'];
function migrateSpotToPriceEod(db: Database): void {
  // VIX 既是指数又是 .VIX tab 的现货:播种进 price_eod,但保留在 market_series(IV 腿)。
  // SPX/NDX 已无读取方,不播种,仅随 DELETE 清走。
  db.run(
    `INSERT OR IGNORE INTO price_eod (underlying, obs_date, open, high, low, close, source, fetched_at)
     SELECT series_id, obs_date, NULL, NULL, NULL, value, 'migrated', ?
     FROM market_series WHERE series_id IN ('SPY', 'QQQ', 'GLD', 'USO', 'BTC', 'VIX')`,
    [new Date().toISOString()],
  );
  const drop = SPOT_TO_DROP.map((s) => `'${s}'`).join(', ');
  db.run(`DELETE FROM market_series WHERE series_id IN (${drop})`);
}

// 库当前 schema 版本;schema_version 表尚不存在(全新库)时按 0。
function currentVersion(db: Database): number {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!exists) return 0;
  const row = db.query('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  return row?.v ?? 0;
}

export function migrate(db: Database): void {
  const prior = currentVersion(db);

  // 建表/索引:幂等(CREATE IF NOT EXISTS),新库老库每次都跑。
  const schemaPath = resolve(import.meta.dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);

  // 一次性历史迁移:只在从 v4 之前的旧库升级时跑一次。尤其 migrateSpotToPriceEod
  // 里有全量 DELETE —— gate 住版本,别让它挂在每天的 daily job 上无条件重跑。
  // (须在 schema.sql 建出 price_eod 之后;两个迁移自身也都幂等,gate 只是省掉每日空转。)
  if (prior < CURRENT_SCHEMA_VERSION) {
    migrateOptionSource(db);
    migrateSpotToPriceEod(db);
    db.run('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)', [
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    ]);
  }
}

// CLI 入口:`bun run src/server/storage/db.ts migrate`
if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'migrate') {
    const db = openDb();
    migrate(db);
    console.log(`Migrated DB at ${DB_PATH} to schema v${CURRENT_SCHEMA_VERSION}`);
    db.close();
  } else {
    console.error('Usage: bun run src/server/storage/db.ts migrate');
    process.exit(1);
  }
}
