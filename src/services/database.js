/**
 * Application database context: opens the business database, runs
 * migrations and provides an event bus for "data changed" notifications.
 */
import { openDatabase, currentDriverKind } from '../storage/sqlite.js';
import { migrate, currentVersion, LATEST_VERSION } from '../storage/migrations.js';

export const MAIN_DB = 'ledgerx_main';

let mainDb = null;
const listeners = new Set();

export async function initDatabase() {
  const db = await openDatabase(MAIN_DB);
  await migrate(db);
  mainDb = db;
  db.onChange(() => notifyChange());
  return db;
}

export function getDb() {
  if (!mainDb) throw new Error('Database not initialised');
  return mainDb;
}

/** For tests: install an already-open database as the main one. */
export function useDb(db) { mainDb = db; }

export function onDataChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notifyChange(topic = '*') { for (const fn of listeners) { try { fn(topic); } catch { /* ignore */ } } }

export async function databaseInfo() {
  const db = getDb();
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  let records = 0;
  const counts = [];
  for (const { name } of tables) {
    const r = await db.get(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
    counts.push({ name, count: Number(r.n) });
    records += Number(r.n);
  }
  return {
    name: MAIN_DB,
    driver: currentDriverKind(),
    schemaVersion: await currentVersion(db),
    latestVersion: LATEST_VERSION,
    sizeBytes: await db.sizeBytes(),
    tableCount: tables.length,
    records,
    counts,
  };
}
