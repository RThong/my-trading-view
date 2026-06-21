import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../config';

const CURRENT_SCHEMA_VERSION = 3; // v3:期权两表加 source 列(provenance,不进主键)、删掉 25Δ 的 is_mock

export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
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

export function migrate(db: Database): void {
  // 先就地改造旧表(列探测;新库或已是新结构则跳过),再跑 schema.sql 补建缺失表/索引。
  migrateOptionSource(db);

  const schemaPath = resolve(import.meta.dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);

  const row = db.query('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  if ((row?.v ?? 0) < CURRENT_SCHEMA_VERSION) {
    db.run(
      'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)',
      [CURRENT_SCHEMA_VERSION, new Date().toISOString()],
    );
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
