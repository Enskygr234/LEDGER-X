/**
 * End-to-end synchronisation scenarios across two simulated devices that
 * share one (fake) Supabase project. Mirrors the brief's test plan:
 * offline create → restart → sync → second device → concurrent edits → conflicts.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqlDatabase, setDriverFactory } from '../src/storage/sqlite.js';
import { createNodeDriverFactory } from '../src/storage/adapters/nodeDriver.js';
import { migrate } from '../src/storage/migrations.js';
import { useDb, MAIN_DB } from '../src/services/database.js';
import { saveBusinessProfile, getBusinessProfile } from '../src/services/settingsService.js';
import { SupabaseClient, SupabaseRemote } from '../src/services/supabaseClient.js';
import * as customers from '../src/services/customerService.js';
import * as docs from '../src/services/invoiceService.js';
import { syncNow, listConflicts, resolveConflict, threeWayMerge, getSyncStatus } from '../src/services/syncService.js';
import { createFakeSupabase } from './fakeSupabase.mjs';
import { line } from './helpers.mjs';
import { todayISO } from '../src/utils/formatting.js';

const server = createFakeSupabase();
const URL_ = 'https://test-project.supabase.co';
const ANON = 'anon-key-for-tests-0123456789';

async function openDevice(dir) {
  const driver = await createNodeDriverFactory(dir)(MAIN_DB);
  const db = new SqlDatabase(MAIN_DB, driver);
  await db.exec('PRAGMA foreign_keys = ON');
  await migrate(db);
  return db;
}

async function makeDevice(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ledgerx-${name}-`));
  const db = await openDevice(dir);
  useDb(db);
  if (!(await getBusinessProfile())) await saveBusinessProfile({ name: 'My Business', default_currency: 'USD' });
  const dev = { name, dir, db, token: null, userId: null };
  dev.client = new SupabaseClient({ url: URL_, anonKey: ANON, fetchImpl: server.fetch, getAccessToken: async () => dev.token });
  dev.remote = new SupabaseRemote(dev.client);
  dev.use = () => useDb(dev.db);
  dev.sync = async () => { dev.use(); return syncNow({ remote: dev.remote, userId: dev.userId, db: dev.db }); };
  dev.login = async (email, password, signup = false) => {
    const r = signup ? await dev.client.signUp(email, password) : await dev.client.signInWithPassword(email, password);
    dev.token = r.access_token; dev.userId = r.user.id;
  };
  return dev;
}

let A, B;
let invoiceId, customerId;

before(async () => {
  setDriverFactory(createNodeDriverFactory(null));
  A = await makeDevice('A');
});

test('1–3. create an invoice offline, restart the app, it is still there', async () => {
  A.use();
  await saveBusinessProfile({ name: 'Northwind Studio', default_currency: 'USD' });
  const c = await customers.createCustomer({ name: 'Globex', email: 'ap@globex.test' });
  customerId = c.id;
  invoiceId = await docs.saveDocument('invoice', {
    customer_id: c.id, issue_date: todayISO(), due_date: '2099-01-01', currency: 'USD', status: 'pending',
    items: [line('Design sprint', 2, 150000, { tax_rate_bp: 2000 }), line('Hosting', 12, 2500)],
  });
  // "Close" and reopen the database file.
  await A.db.close();
  A.db = await openDevice(A.dir);
  A.use();
  const inv = await docs.getDocument('invoice', invoiceId);
  assert.equal(inv.number, 'INV-0001');
  assert.equal(inv.total_minor, 360000 + 30000);
  const q = await A.db.all("SELECT table_name FROM sync_queue WHERE status = 'pending'");
  assert.ok(q.some((r) => r.table_name === 'invoices') && q.some((r) => r.table_name === 'invoice_items'));
  assert.equal((await A.db.get("SELECT sync_state FROM invoices WHERE id = ?", [invoiceId])).sync_state, 'pending');
});

test('sync without an account is a no-op (local-only mode)', async () => {
  const r = await syncNow({ remote: null, userId: null, db: A.db });
  assert.equal(r.skipped, 'not-signed-in');
});

test('4–5. connect an account and synchronise: everything uploads with user_id', async () => {
  await A.login('owner@northwind.test', 'correct horse battery', true);
  const r = await A.sync();
  assert.equal(r.failed, 0, JSON.stringify(r));
  assert.ok(r.pushed >= 5);
  const remoteInv = server.rows('invoices');
  assert.equal(remoteInv.length, 1);
  assert.equal(remoteInv[0].user_id, A.userId);
  assert.equal(remoteInv[0].version, 1);
  assert.equal(server.rows('invoice_items').length, 2);
  assert.ok(!('sync_state' in remoteInv[0]), 'local bookkeeping is not uploaded');
  const local = await A.db.get('SELECT version, sync_state FROM invoices WHERE id = ?', [invoiceId]);
  assert.deepEqual(local, { version: 1, sync_state: 'synced' });
  assert.equal((await A.db.get("SELECT COUNT(*) AS n FROM sync_queue WHERE status <> 'done'")).n, 0);
  // Idempotent: a second sync changes nothing.
  const again = await A.sync();
  assert.equal(again.pushed, 0);
  assert.equal(again.pulled, 0);
});

test('6–7. a second device logs in and receives the records, adopting the account profile', async () => {
  B = await makeDevice('B');
  await B.login('owner@northwind.test', 'correct horse battery');
  const r = await B.sync();
  assert.equal(r.failed, 0);
  B.use();
  const inv = await docs.getDocument('invoice', invoiceId);
  assert.ok(inv, 'invoice arrived');
  assert.equal(inv.items.length, 2);
  assert.equal(inv.total_minor, 390000);
  assert.equal(inv.customer.name, 'Globex');
  const profiles = await B.db.all('SELECT name FROM business_profiles WHERE deleted_at IS NULL');
  assert.deepEqual(profiles.map((p) => p.name), ['Northwind Studio'], 'default profile replaced by the account profile');
  assert.equal((await getBusinessProfile()).next_invoice_seq, 2, 'numbering continues');
});

test('row level security: another user sees nothing', async () => {
  const C = await makeDevice('C');
  await C.login('intruder@evil.test', 'another password!', true);
  const rows = await C.remote.pull('invoices', null);
  assert.equal(rows.length, 0);
  await assert.rejects(C.client.insert('invoices', { ...server.rows('invoices')[0], id: 'x', user_id: A.userId }), /row-level security/);
  const patched = await C.client.update('invoices', `id=eq.${invoiceId}&version=eq.1`, { notes: 'hacked', version: 2 });
  assert.deepEqual(patched, []);
  assert.notEqual(server.rows('invoices')[0].notes, 'hacked');
});

test('8–9a. concurrent edits to different fields merge automatically', async () => {
  A.use();
  let inv = await docs.getDocument('invoice', invoiceId);
  await docs.saveDocument('invoice', { ...inv, id: invoiceId, notes: 'Thanks for your business', items: inv.items });
  B.use();
  inv = await docs.getDocument('invoice', invoiceId);
  await docs.saveDocument('invoice', { ...inv, id: invoiceId, due_date: '2099-02-01', items: inv.items });
  await A.sync();
  const rb = await B.sync(); // B's push hits a version mismatch → 3-way merge
  assert.equal(rb.conflicts, 0);
  assert.ok(rb.merged >= 1);
  await A.sync();
  for (const dev of [A, B]) {
    const row = await dev.db.get('SELECT notes, due_date, sync_state, version FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(row.notes, 'Thanks for your business', dev.name);
    assert.equal(row.due_date, '2099-02-01', dev.name);
    assert.equal(row.sync_state, 'synced', dev.name);
  }
  const srv = server.rows('invoices')[0];
  assert.equal(srv.notes, 'Thanks for your business');
  assert.equal(srv.due_date, '2099-02-01');
});

test('9b. overlapping edits become a conflict, are never silently overwritten, and resolve', async () => {
  A.use();
  let inv = await docs.getDocument('invoice', invoiceId);
  await docs.saveDocument('invoice', { ...inv, id: invoiceId, notes: 'Pay within 14 days', items: inv.items });
  B.use();
  inv = await docs.getDocument('invoice', invoiceId);
  await docs.saveDocument('invoice', { ...inv, id: invoiceId, notes: 'Pay within 30 days', items: inv.items });
  await A.sync();
  const rb = await B.sync();
  assert.equal(rb.conflicts, 1);
  assert.equal(getSyncStatus().state, 'conflict');
  // Neither side lost its value.
  assert.equal((await B.db.get('SELECT notes FROM invoices WHERE id = ?', [invoiceId])).notes, 'Pay within 30 days');
  assert.equal(server.rows('invoices')[0].notes, 'Pay within 14 days');
  const [c] = await listConflicts(B.db);
  assert.deepEqual(c.fields, ['notes']);
  assert.equal(c.remote.notes, 'Pay within 14 days');
  // Conflicted rows are not pushed until resolved.
  const before = server.rows('invoices')[0].version;
  await B.sync();
  assert.equal(server.rows('invoices')[0].version, before);
  B.use();
  await resolveConflict(c.id, { notes: 'local' }, B.db);
  await B.sync();
  await A.sync();
  assert.equal((await A.db.get('SELECT notes FROM invoices WHERE id = ?', [invoiceId])).notes, 'Pay within 30 days');
  assert.equal(server.rows('invoices')[0].notes, 'Pay within 30 days');
  assert.equal((await listConflicts(B.db)).length, 0);
});

test('3-way merge semantics', () => {
  const base = { id: 1, a: 1, b: 1, c: 1 };
  const { merged, ambiguous } = threeWayMerge(base, { id: 1, a: 2, b: 1, c: 5 }, { id: 1, a: 1, b: 3, c: 6 });
  assert.deepEqual(merged, { a: 2, b: 3, c: 5 });
  assert.deepEqual(ambiguous, ['c']);
});

test('payments recorded on two devices both survive (financial history preserved)', async () => {
  A.use();
  await docs.recordPayment(invoiceId, { amount_minor: 100000, method: 'Card' });
  B.use();
  await docs.recordPayment(invoiceId, { amount_minor: 50000, method: 'Cash' });
  await A.sync();
  await B.sync();
  await A.sync();
  assert.equal(server.rows('payments').length, 2);
  for (const dev of [A, B]) {
    const n = await dev.db.get('SELECT COUNT(*) AS n, SUM(amount_minor) AS s FROM payments WHERE invoice_id = ? AND deleted_at IS NULL', [invoiceId]);
    assert.deepEqual([n.n, n.s], [2, 150000], dev.name);
  }
  // paid_minor/status are derived: recomputed from the merged payments, never a conflict.
  assert.equal((await listConflicts(B.db)).length, 0);
  for (const dev of [A, B]) {
    const inv = await dev.db.get('SELECT paid_minor, status, sync_state FROM invoices WHERE id = ?', [invoiceId]);
    assert.deepEqual(inv, { paid_minor: 150000, status: 'partially_paid', sync_state: 'synced' }, dev.name);
  }
  assert.equal(server.rows('invoices').find((i) => i.id === invoiceId).paid_minor, 150000);
});

test('the same invoice number created offline on both devices is renumbered, not lost', async () => {
  A.use();
  const a = await docs.saveDocument('invoice', { customer_id: customerId, issue_date: todayISO(), currency: 'USD', status: 'pending', items: [line('A work', 1, 1000)] });
  B.use();
  const b = await docs.saveDocument('invoice', { customer_id: customerId, issue_date: todayISO(), currency: 'USD', status: 'pending', items: [line('B work', 1, 2000)] });
  const na = (await A.db.get('SELECT number FROM invoices WHERE id = ?', [a])).number;
  const nb = (await B.db.get('SELECT number FROM invoices WHERE id = ?', [b])).number;
  assert.equal(na, nb, 'both devices picked the same next number offline');
  await A.sync();
  const r = await B.sync();
  assert.equal(r.failed, 0, JSON.stringify(r));
  await A.sync();
  const srv = server.rows('invoices').filter((i) => !i.deleted_at);
  const numbers = srv.map((i) => i.number);
  assert.equal(new Set(numbers).size, numbers.length, 'numbers unique on server');
  assert.ok(srv.find((i) => i.id === a) && srv.find((i) => i.id === b), 'both invoices exist');
  const audit = await B.db.get("SELECT summary FROM audit_logs WHERE action = 'renumber'");
  assert.match(audit.summary, /taken on another device/);
});

test('offline: failures stay queued and retry later; deletes propagate as tombstones', async () => {
  A.use();
  const tmp = await customers.createCustomer({ name: 'Temp Customer' });
  server.setOnline(false);
  const r = await A.sync();
  assert.match(r.error, /Network/);
  assert.equal(getSyncStatus().state, 'offline');
  assert.ok((await A.db.get("SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending' AND row_id = ?", [tmp.id])).n === 1);
  server.setOnline(true);
  await A.sync();
  assert.ok(server.rows('customers').find((c) => c.id === tmp.id));
  await customers.removeCustomer(tmp.id);
  await A.sync();
  await B.sync();
  const onB = await B.db.get('SELECT deleted_at FROM customers WHERE id = ?', [tmp.id]);
  assert.ok(onB.deleted_at, 'soft delete reached device B');
});

test('server-side edits by another client are pulled; unknown errors are kept for retry', async () => {
  server.editDirect('customers', customerId, { phone: '+1 555 0199' });
  await A.sync();
  assert.equal((await A.db.get('SELECT phone FROM customers WHERE id = ?', [customerId])).phone, '+1 555 0199');
  // An expired/revoked token aborts the cycle but never drops queued work.
  A.use();
  await customers.updateCustomer(customerId, { notes: 'VIP' });
  const good = A.token;
  A.token = 'expired';
  const r1 = await A.sync();
  assert.ok(r1.error);
  assert.equal(getSyncStatus().state, 'error');
  assert.ok(await A.db.get("SELECT 1 FROM sync_queue WHERE row_id = ? AND status = 'pending'", [customerId]));
  A.token = good;
  // A row the server rejects is marked failed with attempts + error, and retried later.
  server.reject('customers');
  const r2 = await A.sync();
  assert.ok(r2.failed >= 1);
  const q = await A.db.get("SELECT status, attempts, last_error FROM sync_queue WHERE row_id = ? AND status <> 'done'", [customerId]);
  assert.equal(q.status, 'failed');
  assert.ok(q.attempts >= 1);
  assert.match(q.last_error, /simulated/);
  server.reject('customers', false);
  const { retryFailed } = await import('../src/services/syncService.js');
  await retryFailed(A.db);
  await A.sync();
  assert.equal(server.rows('customers').find((c) => c.id === customerId).notes, 'VIP');
  assert.equal((await A.db.get("SELECT COUNT(*) AS n FROM sync_queue WHERE status <> 'done'")).n, 0);
});

test('client: requests carry apikey + bearer token and refuse plain http', async () => {
  assert.ok(server.log.some((l) => l.startsWith('GET /rest/v1/invoices?select=*&server_updated_at=gte.')));
  assert.throws(() => new SupabaseClient({ url: 'http://evil.example', anonKey: ANON }), /HTTPS/);
});
