/**
 * Browser driver: sql.js (SQLite compiled to WebAssembly) with the database
 * image persisted to IndexedDB after every committed write.
 *
 * Loaded only when running as a plain web app (not on Android, not on the dev
 * server). Requires `vendor/sql-wasm.js` + `vendor/sql-wasm.wasm`, which the
 * build copies from node_modules/sql.js/dist when that package is installed.
 */
const IDB_NAME = 'ledgerx-sqlite';
const STORE = 'images';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
  });
}

let SQLPromise = null;
function loadSqlJs() {
  if (!SQLPromise) {
    SQLPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/sql-wasm.js';
      s.onload = () => window.initSqlJs({ locateFile: (f) => `vendor/${f}` }).then(resolve, reject);
      s.onerror = () => reject(new Error('sql.js is not bundled. Run `npm install` and rebuild.'));
      document.head.appendChild(s);
    });
  }
  return SQLPromise;
}

export function createSqlJsDriverFactory() {
  const factory = async (name) => {
    const SQL = await loadSqlJs();
    const image = await idbGet(name);
    const db = image ? new SQL.Database(new Uint8Array(image)) : new SQL.Database();
    let inTx = false;
    const rows = (sql, params) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const out = [];
        while (stmt.step()) out.push(stmt.getAsObject());
        return out;
      } finally { stmt.free(); }
    };
    return {
      async run(sql, params) {
        db.run(sql, params);
        const changes = db.getRowsModified();
        const last = rows('SELECT last_insert_rowid() AS id', [])[0]?.id || 0;
        return { changes, lastId: Number(last) };
      },
      async all(sql, params) { return rows(sql, params); },
      async exec(sql) {
        const s = sql.trim().toUpperCase();
        if (s.startsWith('BEGIN')) inTx = true;
        if (s === 'COMMIT' || s === 'ROLLBACK') inTx = false;
        db.exec(sql);
      },
      async persist() { if (!inTx) await idbPut(name, db.export()); },
      async close() { await idbPut(name, db.export()); db.close(); },
    };
  };
  factory.kind = 'sqljs-indexeddb';
  factory.remove = (name) => idbDelete(name);
  return factory;
}
