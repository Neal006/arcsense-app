/**
 * Opens the on-device database (expo-sqlite) and applies migrations.
 * Platform glue only; all behaviour is tested through SessionRepository on
 * better-sqlite3.
 */
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import { migrate } from './migrations';
import { schema } from './schema';
import { SessionRepository, sqlRunnerFor, type Db } from './SessionRepository';

export const DATABASE_NAME = 'arcsense.db';

let repo: SessionRepository | null = null;

export function openRepository(): SessionRepository {
  if (repo) return repo;
  const client = openDatabaseSync(DATABASE_NAME);
  client.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const db = drizzle(client, { schema }) as unknown as Db;
  migrate(sqlRunnerFor(db));
  repo = new SessionRepository(db);
  return repo;
}
