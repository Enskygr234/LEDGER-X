/**
 * LEDGER X — SQLite access layer.
 *
 * A `SqlDatabase` wraps a low-level *driver* (native Capacitor SQLite, sql.js,
 * node:sqlite in tests, or the dev bridge) and exposes one async API:
 *
 *   run(sql, params)  -> { changes, lastId }
 *   all(sql, params)  -> row objects
 *   get(sql, params)  -> first row | undefined
 *   exec(sql)         -> runs a multi-statement script (no params)
 *   tx(async t => …)  -> serialised transaction; `t` has the same API
 *
 * All statements are executed with bound parameters. Nothing in the
 * application layer concatenates user input into SQL; identifiers that must
 * be dynamic (Database Studio table/column names) go through `quoteIdent`.
 */

/** Normalise JS values for SQLite binding. */
export function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** Quote an SQL identifier safely (double quotes, embedded quotes doubled). */
export function quoteIdent(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new Error('Invalid identifier');
  }
  if (/[\u0000-\u001f]/.test(name)) throw new Error('Invalid identifier');
  return '"' + name.replace(/"/g, '""') + '"';
}

class Mutex {
  constructor() { this._last = Promise.resolve(); }
  lock() {
    let release;
    const next = new Promise((r) => (release = r));
    const prev = this._last;
    this._last = prev.then(() => next);
    return prev.then(() => release);
  }
}

class TxHandle {
  constructor(db) { this._db = db; }
  run(sql, params) { return this._db._driver.run(sql, (params || []).map(bindValue)); }
  all(sql, params) { return this._db._driver.all(sql, (params || []).map(bindValue)); }
  async get(sql, params) { return (await this.all(sql, params))[0]; }
  exec(sql) { return this._db._driver.exec(sql); }
  // Nested transactions simply join the outer one.
  tx(fn) { return fn(this); }
  get name() { return this._db.name; }
}

export class SqlDatabase {
  constructor(name, driver) {
    this.name = name;
    this._driver = driver;
    this._mutex = new Mutex();
    this._listeners = new Set();
  }

  async _locked(fn) {
    const release = await this._mutex.lock();
    try { return await fn(); } finally { release(); }
  }

  run(sql, params) {
    return this._locked(async () => {
      const r = await this._driver.run(sql, (params || []).map(bindValue));
      if (this._driver.persist) await this._driver.persist();
      return r;
    });
  }
  all(sql, params) { return this._locked(() => this._driver.all(sql, (params || []).map(bindValue))); }
  async get(sql, params) { return (await this.all(sql, params))[0]; }
  exec(sql) {
    return this._locked(async () => {
      await this._driver.exec(sql);
      if (this._driver.persist) await this._driver.persist();
    });
  }

  /** Run `fn` inside BEGIN/COMMIT. Rolls back on any thrown error. */
  tx(fn) {
    return this._locked(async () => {
      await this._driver.exec('BEGIN IMMEDIATE');
      const handle = new TxHandle(this);
      try {
        const result = await fn(handle);
        await this._driver.exec('COMMIT');
        if (this._driver.persist) await this._driver.persist();
        this._emit();
        return result;
      } catch (err) {
        try { await this._driver.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    });
  }

  /** Run `fn` with exclusive access to the connection but without a transaction. */
  exclusive(fn) {
    return this._locked(() => fn(new TxHandle(this)));
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) { try { fn(); } catch { /* ignore */ } } }

  async sizeBytes() {
    const pc = await this.get('PRAGMA page_count');
    const ps = await this.get('PRAGMA page_size');
    return Number(Object.values(pc || {})[0] || 0) * Number(Object.values(ps || {})[0] || 0);
  }

  close() { return this._driver.close(); }
}

/**
 * Driver registry. `openDatabase(name)` picks the right driver for the
 * current platform. Tests call `setDriverFactory` with a node:sqlite factory.
 */
let driverFactory = null;
const openDbs = new Map();

export function setDriverFactory(factory) { driverFactory = factory; openDbs.clear(); }

export async function openDatabase(name) {
  if (openDbs.has(name)) return openDbs.get(name);
  if (!driverFactory) throw new Error('No SQLite driver configured');
  const p = (async () => {
    const driver = await driverFactory(name);
    const db = new SqlDatabase(name, driver);
    await db.exec('PRAGMA foreign_keys = ON');
    return db;
  })();
  openDbs.set(name, p);
  try { return await p; } catch (e) { openDbs.delete(name); throw e; }
}

export async function closeDatabase(name) {
  const p = openDbs.get(name);
  if (!p) return;
  openDbs.delete(name);
  const db = await p;
  await db.close();
}

export async function deleteDatabaseFile(name) {
  await closeDatabase(name);
  if (driverFactory && driverFactory.remove) await driverFactory.remove(name);
}

export function currentDriverKind() { return driverFactory?.kind || 'none'; }
