import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../config';

const CURRENT_SCHEMA_VERSION = 2; // v2:瘦身为只剩期权,丢弃 quote_eod / macro_series

export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  return db;
}

export function migrate(db: Database): void {
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
