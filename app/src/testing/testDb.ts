/** In-memory better-sqlite3 database for tests (Node only, never bundled). */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { migrate } from '@/db/migrations';
import { schema } from '@/db/schema';
import { sqlRunnerFor, type Db } from '@/db/SessionRepository';

export function openTestDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema }) as unknown as Db;
  migrate(sqlRunnerFor(db));
  return { db, raw };
}
