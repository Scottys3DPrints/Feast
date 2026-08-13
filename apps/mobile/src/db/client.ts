import * as SQLite from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { newDeviceId } from '@feast/core';
import { LATEST_VERSION, MIGRATIONS } from './migrations';
import * as schema from './schema';

/**
 * The SQLite connection — SPEC §4.6, §6.2.
 *
 * FTS5 is enabled through the `expo-sqlite` config plugin (`enableFTS: true` in
 * app.config.ts), which means **this requires a dev build; Expo Go will not run it**.
 * The failure mode is a migration throwing "no such module: fts5" at first launch.
 */

const DB_NAME = 'feast.db';

export const sqlite = SQLite.openDatabaseSync(DB_NAME, { enableChangeListener: true });

export const db = drizzle(sqlite, { schema });

/**
 * Apply migrations by `PRAGMA user_version`. Runs synchronously at startup, before
 * the first render — §10's `_layout.tsx` "DB migration gate".
 */
export function migrate(): void {
  sqlite.execSync('PRAGMA journal_mode = WAL;');
  sqlite.execSync('PRAGMA foreign_keys = ON;');

  const row = sqlite.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= LATEST_VERSION) return;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    // Each migration is one transaction: a half-applied schema is worse than none,
    // and the FTS5 table plus its three triggers must land together or not at all.
    sqlite.execSync('BEGIN');
    try {
      for (const statement of migration.statements) {
        sqlite.execSync(statement);
      }
      sqlite.execSync(`PRAGMA user_version = ${migration.version}`);
      sqlite.execSync('COMMIT');
    } catch (error) {
      sqlite.execSync('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ─── sync_meta helpers ──────────────────────────────────────────────────────────

export function getMeta(key: string): string | null {
  const row = sqlite.getFirstSync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    key,
  ]);
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  sqlite.runSync(
    'INSERT INTO sync_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/**
 * A stable per-install id. It suffixes every fractional `orderKey` and stamps every
 * syncable row (§12.4/§12.5), so it must survive app restarts but not reinstalls.
 */
export function getDeviceId(): string {
  let id = getMeta('device_id');
  if (!id) {
    id = newDeviceId();
    setMeta('device_id', id);
  }
  return id;
}
