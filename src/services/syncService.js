/**
 * Offline-first synchronisation with Supabase.
 *
 *  1. Every local write is saved first and queued (storage/syncQueue.js).
 *  2. When online and signed in, queued rows are pushed with optimistic
 *     concurrency: `PATCH … WHERE id = ? AND version = <version we based our
 *     edit on>`. The server trigger also enforces version = old + 1.
 *  3. Remote changes are pulled incrementally by `server_updated_at` cursor.
 *  4. When both sides changed a record, a field-level 3-way merge runs
 *     against the last server copy we saw (`sync_shadow`). Non-overlapping
 *     edits merge automatically; overlapping edits become a conflict the
 *     user resolves in Settings → Sync → Conflicts. Nothing is overwritten
 *     blindly.
 *  5. Failed operations stay in the queue with attempt counts and errors.
 */
import { getDb } from './database.js';
import { SYNCED_TABLES, LOCAL_ONLY_COLUMNS, pendingEntries, queueStats, enqueue, clock, audit } from '../storage/syncQueue.js';
import { quoteIdent } from '../storage/sqlite.js';
import { computeDocument, derivePaymentStatus } from '../utils/calculations.js';

const META = new Set(['id', 'user_id', 'created_at', 'updated_at', 'version', 'sync_state', 'server_updated_at']);
const NUMBERED = { invoices: 'invoice', quotations: 'quote' };
// Fields derived from child rows (items, payments). They never conflict: they
// are recomputed from the merged children after every sync (reconcileTotals).
const TOTALS = ['subtotal_minor', 'discount_minor', 'tax_minor', 'total_minor'];
const DERIVED = { invoices: new Set([...TOTALS, 'paid_minor']), quotations: new Set(TOTALS) };
const USER_STATUSES = new Set(['draft', 'cancelled']);

function isDerived(table, field, l, r) {
  if (DERIVED[table]?.has(field)) return true;
  // Payment-driven invoice statuses are derived; draft/cancelled are user decisions.
  return table === 'invoices' && field === 'status' && !USER_STATUSES.has(l) && !USER_STATUSES.has(r);
}

// ---------------------------------------------------------------- status

const status = { state: 'disabled', lastSyncAt: null, lastError: null, pending: 0, failed: 0, conflicts: 0, running: false };
const statusListeners = new Set();
export const getSyncStatus = () => ({ ...status });
export const onSyncStatus = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of statusListeners) { try { fn(getSyncStatus()); } catch { /* ignore */ } }
}

export async function refreshCounts(db = getDb()) {
  const q = await queueStats(db);
  const c = await db.get('SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL');
  const last = await db.get("SELECT value FROM app_settings WHERE key = 'sync.last_at'");
  setStatus({ pending: q.pending, failed: q.failed, conflicts: Number(c.n), lastSyncAt: last ? JSON.parse(last.value) : null });
  return getSyncStatus();
}

// ---------------------------------------------------------------- helpers

const columnCache = new Map();
async function localColumns(t, table) {
  if (!columnCache.has(table)) columnCache.set(table, (await t.all(`PRAGMA table_info(${quoteIdent(table)})`)).map((c) => c.name));
  return columnCache.get(table);
}

function toRemote(row, userId) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!LOCAL_ONLY_COLUMNS.has(k)) out[k] = v;
  out.user_id = userId;
  return out;
}

function dataFields(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) if (!META.has(k)) out[k] = v;
  return out;
}

const norm = (v) => (v === undefined ? null : v);
function same(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return true;
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

/**
 * Field-level three-way merge. Returns { merged, ambiguous: [field] }.
 * `base` is the last server state we synced (may be null).
 */
export function threeWayMerge(base, local, remote, table = null) {
  const l = dataFields(local);
  const r = dataFields(remote);
  const b = base ? dataFields(base) : null;
  const merged = {};
  const ambiguous = [];
  for (const f of new Set([...Object.keys(l), ...Object.keys(r)])) {
    if (same(l[f], r[f])) merged[f] = r[f] ?? null;
    else if (b && same(l[f], b[f])) merged[f] = r[f] ?? null; // only remote changed
    else if (b && same(r[f], b[f])) merged[f] = l[f] ?? null; // only local changed
    else if (table && isDerived(table, f, l[f], r[f])) merged[f] = r[f] ?? null;
    else { ambiguous.push(f); merged[f] = l[f] ?? null; }
  }
  return { merged, ambiguous };
}

async function getShadow(t, table, id) {
  const s = await t.get('SELECT data FROM sync_shadow WHERE table_name = ? AND row_id = ?', [table, id]);
  return s ? JSON.parse(s.data) : null;
}
async function setShadow(t, table, row) {
  await t.run(
    `INSERT INTO sync_shadow (table_name, row_id, version, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(table_name, row_id) DO UPDATE SET version = excluded.version, data = excluded.data`,
    [table, row.id, row.version, JSON.stringify(row)]);
}

/** Upsert a row locally *without* queueing it (it came from the server). */
async function writeLocal(t, table, row, syncState) {
  const cols = (await localColumns(t, table)).filter((c) => c in row || c === 'sync_state');
  const data = { ...row, sync_state: syncState };
  const sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ')}`;
  const vals = cols.map((c) => data[c]);
  try {
    await t.run(sql, vals);
  } catch (e) {
    if (NUMBERED[table] && /UNIQUE/i.test(e.message) && row.number) {
      // Another, still-local document already uses this number: renumber ours.
      await renumberLocal(t, table, row.number, row.id);
      await t.run(sql, vals);
    } else throw e;
  }
}

async function renumberLocal(t, table, number, exceptId) {
  const clash = await t.get(`SELECT id FROM ${quoteIdent(table)} WHERE number = ? AND id <> ? AND deleted_at IS NULL`, [number, exceptId || '']);
  if (!clash) return null;
  const p = await t.get('SELECT * FROM business_profiles WHERE deleted_at IS NULL ORDER BY version DESC, created_at LIMIT 1');
  const prefix = table === 'invoices' ? p.invoice_prefix : p.quote_prefix;
  const seqCol = table === 'invoices' ? 'next_invoice_seq' : 'next_quote_seq';
  let seq = Number(p[seqCol]);
  let next;
  for (;;) {
    next = `${prefix}${String(seq).padStart(4, '0')}`;
    const taken = await t.get(`SELECT 1 FROM ${quoteIdent(table)} WHERE number = ? AND deleted_at IS NULL`, [next]);
    if (!taken && next !== number) break;
    seq += 1;
  }
  const now = clock.now();
  await t.run(`UPDATE ${quoteIdent(table)} SET number = ?, updated_at = ?, sync_state = CASE sync_state WHEN 'conflict' THEN 'conflict' ELSE 'pending' END WHERE id = ?`, [next, now, clash.id]);
  await t.run(`UPDATE business_profiles SET ${seqCol} = ?, updated_at = ?, sync_state = 'pending' WHERE id = ?`, [seq + 1, now, p.id]);
  await enqueue(t, table, clash.id, 'upsert');
  await enqueue(t, 'business_profiles', p.id, 'upsert');
  await audit(t, NUMBERED[table], clash.id, 'renumber', `${number} -> ${next} (number taken on another device)`);
  return next;
}

async function markQueue(t, table, id, statusValue, error = null) {
  await t.run(
    `UPDATE sync_queue SET status = ?, attempts = attempts + ?, last_error = ?, updated_at = ? WHERE table_name = ? AND row_id = ? AND status <> 'done'`,
    [statusValue, statusValue === 'done' ? 0 : 1, error, clock.now(), table, id]);
}

/** Local and remote both changed: merge or record a conflict. */
async function reconcile(t, table, local, remote, touched) {
  const base = await getShadow(t, table, local.id);
  const { merged, ambiguous } = threeWayMerge(base, local, remote, table);
  if (!ambiguous.length) {
    const row = { ...remote, ...merged, id: local.id, created_at: local.created_at, version: remote.version };
    const equalsRemote = Object.keys(merged).every((k) => same(merged[k], remote[k]));
    row.updated_at = equalsRemote ? remote.updated_at : clock.now();
    await writeLocal(t, table, row, equalsRemote ? 'synced' : 'pending');
    await setShadow(t, table, remote);
    if (equalsRemote) await markQueue(t, table, local.id, 'done');
    else await enqueue(t, table, local.id, 'upsert');
    touched?.add(`${table}:${local.id}`);
    return 'merged';
  }
  const existing = await t.get('SELECT id FROM sync_conflicts WHERE table_name = ? AND row_id = ? AND resolved_at IS NULL', [table, local.id]);
  if (existing) {
    await t.run('UPDATE sync_conflicts SET remote_data = ?, local_data = ?, fields = ? WHERE id = ?',
      [JSON.stringify(remote), JSON.stringify(local), JSON.stringify(ambiguous), existing.id]);
    await markQueue(t, table, local.id, 'failed', 'conflict');
    return 'conflict-existing';
  } else {
    await t.run(
      'INSERT INTO sync_conflicts (table_name, row_id, local_data, remote_data, base_data, fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [table, local.id, JSON.stringify(local), JSON.stringify(remote), base ? JSON.stringify(base) : null, JSON.stringify(ambiguous), clock.now()]);
  }
  await t.run(`UPDATE ${quoteIdent(table)} SET sync_state = 'conflict' WHERE id = ?`, [local.id]);
  await markQueue(t, table, local.id, 'failed', 'conflict');
  return 'conflict';
}

// ---------------------------------------------------------------- push

async function pushOne(db, remote, userId, entry, stats) {
  const { table_name: table, row_id: id } = entry;
  const local = await db.get(`SELECT * FROM ${quoteIdent(table)} WHERE id = ?`, [id]);
  if (!local) { await db.tx((t) => markQueue(t, table, id, 'done')); return; }
  if (local.sync_state === 'conflict') return; // waits for user resolution
  const payload = toRemote(local, userId);
  let result = null;
  let serverRow = null;
  try {
    if (Number(local.version) === 0) {
      try {
        result = await remote.insert(table, { ...payload, version: 1 });
      } catch (e) {
        if (!e.isUniqueViolation) throw e;
        serverRow = await remote.fetchOne(table, id);
        if (!serverRow && NUMBERED[table]) {
          // Document number already used in this account by another device.
          // The pull phase brings that document down and renumbers ours
          // (see writeLocal → renumberLocal); the final push pass uploads it.
          stats.deferred += 1;
          return;
        }
        if (!serverRow) throw e;
      }
    } else {
      result = await remote.updateIfVersion(table, { ...payload, version: Number(local.version) + 1 }, Number(local.version));
      if (!result) serverRow = await remote.fetchOne(table, id);
      if (!result && !serverRow) result = await remote.insert(table, { ...payload, version: Number(local.version) + 1 });
    }
  } catch (e) {
    if (e.isNetwork) throw e;
    if (e.isUniqueViolation && NUMBERED[table]) { stats.deferred += 1; return; }
    await db.tx((t) => markQueue(t, table, id, 'failed', String(e.message || e).slice(0, 300)));
    stats.failed += 1;
    return;
  }

  await db.tx(async (t) => {
    const fresh = await t.get(`SELECT * FROM ${quoteIdent(table)} WHERE id = ?`, [id]);
    if (result) {
      const changedSince = fresh.updated_at !== local.updated_at;
      await t.run(`UPDATE ${quoteIdent(table)} SET version = ?, user_id = ?, sync_state = ? WHERE id = ?`,
        [result.version, userId, changedSince ? 'pending' : 'synced', id]);
      await setShadow(t, table, result);
      if (!changedSince) await markQueue(t, table, id, 'done');
      stats.pushed += 1;
    } else if (serverRow) {
      const r = await reconcile(t, table, fresh, serverRow, stats.touched);
      if (r === 'conflict') stats.conflicts += 1; else if (r === 'merged') stats.merged += 1;
    }
  });
}

// ---------------------------------------------------------------- pull

async function applyRemote(t, table, r, stats) {
  const local = await t.get(`SELECT * FROM ${quoteIdent(table)} WHERE id = ?`, [r.id]);
  if (!local) {
    if (table === 'business_profiles') await adoptRemoteProfile(t, r);
    await writeLocal(t, table, r, 'synced');
    await setShadow(t, table, r);
    stats.pulled += 1;
    stats.touched.add(`${table}:${r.id}`);
    return;
  }
  if (Number(r.version) <= Number(local.version)) return; // already have it (or our own echo)
  if (local.sync_state === 'synced') {
    await writeLocal(t, table, { ...r, created_at: local.created_at }, 'synced');
    await setShadow(t, table, r);
    stats.pulled += 1;
    stats.touched.add(`${table}:${r.id}`);
    return;
  }
  const res = await reconcile(t, table, local, r, stats.touched);
  if (res === 'conflict') stats.conflicts += 1; else if (res === 'merged') stats.merged += 1;
}

/** First sync on a device: a never-synced default profile yields to the account's profile. */
async function adoptRemoteProfile(t, remote) {
  const locals = await t.all('SELECT * FROM business_profiles WHERE deleted_at IS NULL AND version = 0 AND id <> ?', [remote.id]);
  for (const l of locals) {
    // Keep the higher document counters so numbers never repeat.
    remote.next_invoice_seq = Math.max(Number(remote.next_invoice_seq), Number(l.next_invoice_seq));
    remote.next_quote_seq = Math.max(Number(remote.next_quote_seq), Number(l.next_quote_seq));
    const now = clock.now();
    await t.run("UPDATE business_profiles SET deleted_at = ?, updated_at = ?, sync_state = 'synced' WHERE id = ?", [now, now, l.id]);
    await t.run("UPDATE sync_queue SET status = 'done', updated_at = ? WHERE table_name = 'business_profiles' AND row_id = ?", [now, l.id]);
    if (l.name !== 'My Business') {
      await t.run(
        'INSERT INTO sync_conflicts (table_name, row_id, local_data, remote_data, base_data, fields, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
        ['business_profiles', remote.id, JSON.stringify({ ...l, id: remote.id }), JSON.stringify(remote),
          JSON.stringify(Object.keys(dataFields(l)).filter((f) => !same(l[f], remote[f]) && !/seq$/.test(f))), now]);
    }
  }
}

async function pullTable(db, remote, table, stats) {
  const key = `sync.cursor.${table}`;
  const saved = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  let cursor = saved ? JSON.parse(saved.value) : null;
  for (let page = 0; page < 200; page++) {
    const rows = await remote.pull(table, cursor, 500);
    if (!rows.length) break;
    await db.tx(async (t) => {
      for (const r of rows) await applyRemote(t, table, r, stats);
    });
    const last = rows[rows.length - 1].server_updated_at;
    const advanced = last !== cursor;
    cursor = last;
    await db.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(cursor), clock.now()]);
    if (rows.length < 500 || !advanced) break;
  }
}

/** After merges, make sure document headers still match their line items. */
async function reconcileTotals(db, touched) {
  const docs = new Set();
  for (const k of touched) {
    const [table, id] = k.split(':');
    if (table === 'invoices' || table === 'quotations') docs.add(`${table}:${id}`);
    if (table === 'payments') {
      const r = await db.get('SELECT invoice_id AS p FROM payments WHERE id = ?', [id]);
      if (r?.p) docs.add(`invoices:${r.p}`);
    }
    if (table === 'invoice_items' || table === 'quotation_items') {
      const fk = table === 'invoice_items' ? 'invoice_id' : 'quotation_id';
      const r = await db.get(`SELECT ${fk} AS p FROM ${table} WHERE id = ?`, [id]);
      if (r?.p) docs.add(`${table === 'invoice_items' ? 'invoices' : 'quotations'}:${r.p}`);
    }
  }
  let fixed = 0;
  for (const k of docs) {
    const [table, id] = k.split(':');
    const itemsTable = table === 'invoices' ? 'invoice_items' : 'quotation_items';
    const fk = table === 'invoices' ? 'invoice_id' : 'quotation_id';
    await db.tx(async (t) => {
      const doc = await t.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      if (!doc || doc.deleted_at) return;
      const items = await t.all(`SELECT * FROM ${itemsTable} WHERE ${fk} = ? AND deleted_at IS NULL`, [id]);
      if (!items.length) return;
      const totals = computeDocument(items);
      const patch = {};
      for (const k of TOTALS) if (totals[k] !== doc[k]) patch[k] = totals[k];
      if (table === 'invoices') {
        const paid = Number((await t.get('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE invoice_id = ? AND deleted_at IS NULL', [id])).s);
        if (paid !== doc.paid_minor) patch.paid_minor = paid;
        const nextStatus = derivePaymentStatus({ ...doc, ...patch, paid_minor: paid });
        if (nextStatus !== doc.status) patch.status = nextStatus;
      }
      if (Object.keys(patch).length) {
        const now = clock.now();
        const cols = Object.keys(patch);
        await t.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?,
          sync_state = CASE sync_state WHEN 'conflict' THEN 'conflict' ELSE 'pending' END WHERE id = ?`,
        [...cols.map((c) => patch[c]), now, id]);
        await enqueue(t, table, id, 'upsert');
        fixed += 1;
      }
    });
  }
  return fixed;
}

// ---------------------------------------------------------------- public API

/**
 * Run one full synchronisation cycle. `remote` implements
 * pull / fetchOne / insert / updateIfVersion (SupabaseRemote in the app).
 */
export async function syncNow({ remote, userId, db = getDb() }) {
  if (!remote || !userId) { setStatus({ state: 'disabled' }); return { skipped: 'not-signed-in' }; }
  if (status.running) return { skipped: 'already-running' };
  setStatus({ running: true, state: 'syncing', lastError: null });
  const stats = { pushed: 0, pulled: 0, merged: 0, conflicts: 0, failed: 0, deferred: 0, totalsFixed: 0, touched: new Set() };
  try {
    // The account's business profile comes down first so a fresh device adopts
    // it instead of uploading its placeholder profile.
    await pullTable(db, remote, 'business_profiles', stats);
    // Push (local edits are the freshest information we have) …
    for (let pass = 0; pass < 3; pass++) {
      const entries = await pendingEntries(db, 1000);
      if (!entries.length) break;
      const before = stats.pushed + stats.merged;
      for (const e of entries) await pushOne(db, remote, userId, e, stats);
      if (stats.pushed + stats.merged === before) break;
    }
    // … then pull everything that changed remotely, parents before children.
    for (const table of SYNCED_TABLES) await pullTable(db, remote, table, stats);
    stats.totalsFixed = await reconcileTotals(db, stats.touched);
    // Merged rows may need pushing back.
    const again = await pendingEntries(db, 1000);
    for (const e of again) await pushOne(db, remote, userId, e, stats);
    const now = clock.now();
    await db.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('sync.last_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [JSON.stringify(now), now]);
    await refreshCounts(db);
    setStatus({ state: status.conflicts ? 'conflict' : stats.failed ? 'error' : 'idle', lastError: stats.failed ? `${stats.failed} change(s) failed to upload` : null });
  } catch (e) {
    await refreshCounts(db);
    setStatus({ state: e.isNetwork ? 'offline' : 'error', lastError: e.isNetwork ? 'Offline — changes are saved locally' : String(e.message || e) });
    stats.error = String(e.message || e);
  } finally {
    setStatus({ running: false });
  }
  const { touched, ...rest } = stats;
  return rest;
}

export async function listConflicts(db = getDb()) {
  const rows = await db.all('SELECT * FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY id');
  return rows.map((r) => ({ ...r, local: JSON.parse(r.local_data), remote: JSON.parse(r.remote_data), base: r.base_data ? JSON.parse(r.base_data) : null, fields: JSON.parse(r.fields) }));
}

/**
 * Resolve a conflict. `choice` is 'local' | 'remote' | { field: 'local'|'remote' }.
 * Non-ambiguous fields keep their automatic merge result.
 */
export async function resolveConflict(conflictId, choice, db = getDb()) {
  return db.tx(async (t) => {
    const c = await t.get('SELECT * FROM sync_conflicts WHERE id = ? AND resolved_at IS NULL', [conflictId]);
    if (!c) throw new Error('Conflict not found');
    const table = c.table_name;
    const remote = JSON.parse(c.remote_data);
    const local = (await t.get(`SELECT * FROM ${quoteIdent(table)} WHERE id = ?`, [c.row_id])) || JSON.parse(c.local_data);
    const localData = JSON.parse(c.local_data);
    const base = c.base_data ? JSON.parse(c.base_data) : null;
    const { merged } = threeWayMerge(base, { ...localData, ...dataFields(local) }, remote, table);
    for (const f of JSON.parse(c.fields)) {
      const pick = typeof choice === 'string' ? choice : (choice[f] || 'local');
      merged[f] = pick === 'remote' ? remote[f] ?? null : (local[f] ?? localData[f] ?? null);
    }
    const equalsRemote = Object.keys(merged).every((k) => same(merged[k], remote[k]));
    const row = { ...remote, ...merged, id: c.row_id, version: remote.version, updated_at: equalsRemote ? remote.updated_at : clock.now() };
    if (local.created_at) row.created_at = local.created_at;
    await writeLocal(t, table, row, equalsRemote ? 'synced' : 'pending');
    await setShadow(t, table, remote);
    if (equalsRemote) await markQueue(t, table, c.row_id, 'done');
    else {
      await t.run("UPDATE sync_queue SET status = 'pending', last_error = NULL WHERE table_name = ? AND row_id = ? AND status <> 'done'", [table, c.row_id]);
      await enqueue(t, table, c.row_id, 'upsert');
    }
    await t.run('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?',
      [clock.now(), typeof choice === 'string' ? choice : JSON.stringify(choice), conflictId]);
    await audit(t, table, c.row_id, 'conflict_resolved', typeof choice === 'string' ? choice : 'per-field');
  });
}

export async function retryFailed(db = getDb()) {
  await db.run("UPDATE sync_queue SET status = 'pending', updated_at = ? WHERE status = 'failed' AND (last_error IS NULL OR last_error <> 'conflict')", [clock.now()]);
  return refreshCounts(db);
}

export async function queueDetails(db = getDb()) {
  return db.all("SELECT * FROM sync_queue WHERE status <> 'done' ORDER BY id DESC LIMIT 200");
}

/** Housekeeping: drop completed queue entries older than 7 days. */
export async function pruneQueue(db = getDb()) {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await db.run("DELETE FROM sync_queue WHERE status = 'done' AND updated_at < ?", [cutoff]);
}

/** For tests. */
export function _resetColumnCache() { columnCache.clear(); }
