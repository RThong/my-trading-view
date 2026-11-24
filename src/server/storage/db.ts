import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../config';

const CURRENT_SCHEMA_VERSION = 5; // v5:sec_watermark 加 processed_filed(与 remote_filed 分工见 schema.sql)

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
  ['option_snapshot_25delta', 'option_chain_raw'].forEach((table) => {
    const cols = columns(db, table);
    if (!cols.length) return; // 新库尚无此表
    if (!cols.includes('source')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'moomoo'`);
      db.exec(`UPDATE ${table} SET source = 'deribit' WHERE underlying = 'BTC'`);
    }
    if (cols.includes('is_mock')) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN is_mock`); // 仅 25Δ 表曾有,旧遗留列
    }
  });
}

// v5:sec_watermark 补 processed_filed。旧库那张表已经建过,CREATE IF NOT EXISTS 加不上列。
// 这里只加列不回填:播种交给 job(见 secFundamentals 里那段) —— 它能在**拉 companyfacts 之前**
// 播,拿到的是没被本次申报的比较期污染的 MAX(filed);而且那条路径同时覆盖「旧库」和
// 「watermark 行本来就不存在」两种情形,一处解决。
function migrateSecProcessedFiled(db: Database): void {
  const cols = columns(db, 'sec_watermark');
  if (cols.length && !cols.includes('processed_filed')) {
    db.exec(`ALTER TABLE sec_watermark ADD COLUMN processed_filed TEXT`);
  }
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

  // 一次性历史迁移:只在库版本落后时跑,别挂在每天的 daily job 上无条件重跑(迁移自身幂等,gate 只是省掉每日空转)。
  if (prior < CURRENT_SCHEMA_VERSION) {
    migrateOptionSource(db);
    migrateSecProcessedFiled(db);
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
