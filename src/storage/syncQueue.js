/**
 * Durable synchronisation queue + record helpers.
 *
 * Every write to a synchronised table goes through `insertRecord`,
 * `updateRecord` or `softDelete`. Those helpers stamp sync metadata, mark the
 * row `pending`, and add (or coalesce) an entry in `sync_queue` in the same
 * transaction as the data change — so a change can never be saved without
 * also being queued for upload.
 */
import { quoteIdent } from './sqlite.js';

export const SYNCED_TABLES = [
  // Order matters: parents before children (foreign keys on the server).
  'business_profiles',
  'tax_rates',
  'customers',
  'products',
  'quotations',
  'quotation_items',
  'invoices',
  'invoice_items',
  'payments',
  'expenses',
];

/** Columns that are local bookkeeping only and never uploaded. */
export const LOCAL_ONLY_COLUMNS = new Set(['sync_state']);

export const clock = {
  now: () => new Date().toISOString(),
};

export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function enqueue(t, table, rowId, op = 'upsert') {
  const now = clock.now();
  const open = await t.get(
    "SELECT id FROM sync_queue WHERE table_name = ? AND row_id = ? AND status <> 'done'",
    [table, rowId],
  );
  if (open) {
    await t.run("UPDATE sync_queue SET op = ?, status = 'pending', updated_at = ? WHERE id = ?", [op, now, open.id]);
  } else {
    await t.run(
      "INSERT INTO sync_queue (table_name, row_id, op, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
      [table, rowId, op, now, now],
    );
  }
}

export async function audit(t, entity, entityId, action, summary) {
  await t.run(
    'INSERT INTO audit_logs (entity, entity_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    [entity, entityId, action, summary || null, clock.now()],
  );
}

function assertSynced(table) {
  if (!SYNCED_TABLES.includes(table)) throw new Error(`Not a synchronised table: ${table}`);
}

export async function insertRecord(t, table, data) {
  assertSynced(table);
  const now = clock.now();
  const row = {
    id: data.id || uuid(),
    ...data,
    created_at: data.created_at || now,
    updated_at: now,
    version: 0,
    sync_state: 'pending',
  };
  const cols = Object.keys(row);
  await t.run(
    `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
  await enqueue(t, table, row.id, 'upsert');
  return row;
}

export async function updateRecord(t, table, id, patch) {
  assertSynced(table);
  const clean = { ...patch };
  for (const k of ['id', 'created_at', 'version', 'sync_state', 'user_id']) delete clean[k];
  clean.updated_at = clock.now();
  clean.sync_state = 'pending';
  const cols = Object.keys(clean);
  const r = await t.run(
    `UPDATE ${quoteIdent(table)} SET ${cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => clean[c]), id],
  );
  if (r.changes === 0) throw new Error(`${table} record not found`);
  await enqueue(t, table, id, 'upsert');
  return clean;
}

export async function softDelete(t, table, id) {
  assertSynced(table);
  const now = clock.now();
  const r = await t.run(
    `UPDATE ${quoteIdent(table)} SET deleted_at = ?, updated_at = ?, sync_state = 'pending' WHERE id = ? AND deleted_at IS NULL`,
    [now, now, id],
  );
  if (r.changes) await enqueue(t, table, id, 'delete');
  return r.changes > 0;
}

export async function queueStats(db) {
  const rows = await db.all('SELECT status, COUNT(*) AS n FROM sync_queue GROUP BY status');
  const out = { pending: 0, failed: 0, done: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function pendingEntries(db, limit = 500) {
  const order = SYNCED_TABLES.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ');
  return db.all(
    `SELECT * FROM sync_queue WHERE status IN ('pending','failed')
     ORDER BY CASE table_name ${order} ELSE 99 END, id LIMIT ?`,
    [limit],
  );
}
