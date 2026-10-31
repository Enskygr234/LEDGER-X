/**
 * node:sqlite driver — used by the automated test-suite and by the local
 * development server (scripts/dev-server.mjs). Never bundled into the app.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function normaliseRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

export function createNodeDriverFactory(dir /* null => in-memory */) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const fileFor = (name) => (dir ? path.join(dir, `${name}.sqlite`) : ':memory:');
  const factory = async (name) => {
    const db = new DatabaseSync(fileFor(name));
    return {
      async run(sql, params) {
        const r = db.prepare(sql).run(...params);
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      async all(sql, params) {
        const stmt = db.prepare(sql);
        // Statements that return no columns (DDL, PRAGMA setters) must use run().
        if (stmt.columns && stmt.columns().length === 0) { stmt.run(...params); return []; }
        return stmt.all(...params).map(normaliseRow);
      },
      async exec(sql) { db.exec(sql); },
      async close() { db.close(); },
    };
  };
  factory.kind = dir ? 'node-file' : 'node-memory';
  factory.remove = async (name) => { if (dir) fs.rmSync(fileFor(name), { force: true }); };
  factory.list = async () => (dir ? fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).map((f) => f.slice(0, -7)) : []);
  return factory;
}
