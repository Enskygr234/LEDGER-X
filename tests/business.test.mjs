import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, reopenApp, line } from './helpers.mjs';
import { getDb } from '../src/services/database.js';
import { migrate, currentVersion, LATEST_VERSION, MIGRATIONS } from '../src/storage/migrations.js';
import { openDatabase, setDriverFactory } from '../src/storage/sqlite.js';
import { createNodeDriverFactory } from '../src/storage/adapters/nodeDriver.js';
import * as customers from '../src/services/customerService.js';
import * as products from '../src/services/productService.js';
import * as docs from '../src/services/invoiceService.js';
import * as analytics from '../src/services/analyticsService.js';
import { todayISO } from '../src/utils/formatting.js';

let dir;
before(async () => { ({ dir } = await freshApp()); });

test('migrations: fresh install reaches latest version and re-running is a no-op', async () => {
  assert.equal(await currentVersion(getDb()), LATEST_VERSION);
  assert.deepEqual(await migrate(getDb()), []);
});

test('migrations: upgrading an older database preserves its data', async () => {
  setDriverFactory(createNodeDriverFactory(null)); // isolated in-memory db
  const old = await openDatabase('upgrade_test');
  await migrate(old, { upTo: 1 });
  assert.equal(await currentVersion(old), 1);
  const now = new Date().toISOString();
  await old.run("INSERT INTO customers (id, name, created_at, updated_at) VALUES ('c1', 'Legacy Ltd', ?, ?)", [now, now]);
  const applied = await migrate(old);
  assert.deepEqual(applied, MIGRATIONS.slice(1).map((m) => m.version));
  assert.equal((await old.get("SELECT name FROM customers WHERE id = 'c1'")).name, 'Legacy Ltd');
  assert.ok(await old.get("SELECT 1 FROM sqlite_master WHERE name = 'sync_queue'"));
  setDriverFactory(createNodeDriverFactory(dir));
});

test('customer validation', async () => {
  await assert.rejects(customers.createCustomer({ name: '  ' }), /Name is required/);
  await assert.rejects(customers.createCustomer({ name: 'X', email: 'nope' }), /valid email/);
});

let acme, widget, consulting;
test('create customers and products', async () => {
  acme = await customers.createCustomer({ name: 'Acme Corp', email: 'billing@acme.test', phone: '+1 555 0100' });
  assert.match(acme.code, /^C-\d{4}$/);
  widget = await products.createProduct({ name: 'Widget', sku: 'W-1', unit_price_minor: 1999, currency: 'USD', tax_rate_bp: 1800, kind: 'product', unit: 'pcs' });
  consulting = await products.createProduct({ name: 'Consulting', unit_price_minor: 12000, currency: 'USD', tax_rate_bp: 0, kind: 'service', unit: 'h', category: 'Services' });
  await assert.rejects(products.createProduct({ name: 'Dup', sku: 'W-1', unit_price_minor: 1, currency: 'USD', unit: 'pcs' }), /UNIQUE/);
  assert.equal((await products.listProducts({ kind: 'service' })).length, 1);
  assert.deepEqual(await products.listCategories(), ['Services']);
});

let invoiceId;
test('invoice create computes totals server-side and numbers sequentially', async () => {
  invoiceId = await docs.saveDocument('invoice', {
    customer_id: acme.id, issue_date: todayISO(), due_date: '2099-01-01', currency: 'USD', status: 'pending',
    items: [
      { ...line('Widget', 3, 1999, { tax_rate_bp: 1800 }), product_id: widget.id },
      { ...line('Consulting', 1.5, 12000, { discount_type: 'percent', discount_value: 1000 }), product_id: consulting.id },
    ],
  });
  const inv = await docs.getDocument('invoice', invoiceId);
  assert.equal(inv.number, 'INV-0001');
  assert.equal(inv.subtotal_minor, 5997 + 18000);
  assert.equal(inv.discount_minor, 1800);
  assert.equal(inv.tax_minor, 1079); // 59.97 * 18% = 10.7946
  assert.equal(inv.total_minor, 5997 + 16200 + 1079);
  assert.equal(inv.status, 'pending');
  assert.equal(inv.items.length, 2);
  assert.equal(inv.customer_snapshot.name, 'Acme Corp');
  const second = await docs.duplicateDocument('invoice', invoiceId);
  const dup = await docs.getDocument('invoice', second);
  assert.equal(dup.number, 'INV-0002');
  assert.equal(dup.status, 'draft');
  assert.equal(dup.total_minor, inv.total_minor);
});

test('invoice validation rejects bad input', async () => {
  await assert.rejects(docs.saveDocument('invoice', { customer_id: acme.id, issue_date: todayISO(), currency: 'USD', items: [] }), /at least one line/);
  await assert.rejects(docs.saveDocument('invoice', { customer_id: acme.id, issue_date: '2026-05-10', due_date: '2026-05-01', currency: 'USD', items: [line('x', 1, 1)] }), /cannot be before/);
  await assert.rejects(docs.saveDocument('invoice', { customer_id: acme.id, issue_date: todayISO(), currency: 'XXQ', items: [line('x', 1, 1)] }), /currency/);
});

test('editing reconciles line items (update / add / remove)', async () => {
  const inv = await docs.getDocument('invoice', invoiceId);
  const [first] = inv.items;
  await docs.saveDocument('invoice', {
    ...inv, id: invoiceId, status: 'pending',
    items: [{ ...first, quantity_milli: 1000 }, line('Setup fee', 1, 5000)],
  });
  const after = await docs.getDocument('invoice', invoiceId);
  assert.equal(after.items.length, 2);
  assert.equal(after.items[0].id, first.id, 'kept item keeps its id');
  assert.equal(after.total_minor, 1999 + 360 + 5000);
  const deletedItems = await getDb().all('SELECT * FROM invoice_items WHERE invoice_id = ? AND deleted_at IS NOT NULL', [invoiceId]);
  assert.equal(deletedItems.length, 1, 'removed line is soft-deleted for sync');
});

test('payments drive status and protect history', async () => {
  const inv = await docs.getDocument('invoice', invoiceId);
  await assert.rejects(docs.recordPayment(invoiceId, { amount_minor: inv.total_minor + 1 }), /exceeds/);
  let r = await docs.recordPayment(invoiceId, { amount_minor: 2000, method: 'Bank transfer' });
  assert.equal(r.status, 'partially_paid');
  await assert.rejects(docs.deleteDocument('invoice', invoiceId), /Cancel it instead/);
  await assert.rejects(docs.saveDocument('invoice', { ...inv, id: invoiceId, items: [line('tiny', 1, 100)] }), /lower than the amount already paid/);
  r = await docs.recordPayment(invoiceId, { amount_minor: inv.total_minor - 2000 });
  assert.equal(r.status, 'paid');
  const p = (await docs.getDocument('invoice', invoiceId)).payments[1];
  await docs.deletePayment(p.id);
  assert.equal((await docs.getDocument('invoice', invoiceId)).status, 'partially_paid');
});

test('overdue detection', async () => {
  const id = await docs.saveDocument('invoice', { customer_id: acme.id, issue_date: '2026-01-01', due_date: '2026-01-15', currency: 'USD', status: 'pending', items: [line('Old work', 1, 1000)] });
  assert.equal((await docs.getDocument('invoice', id)).status, 'overdue');
});

test('quotation lifecycle and conversion keeps both records linked', async () => {
  const qid = await docs.saveDocument('quotation', {
    customer_id: acme.id, issue_date: todayISO(), expiry_date: '2099-12-31', currency: 'USD', status: 'sent',
    items: [line('Website', 1, 250000, { tax_rate_bp: 1800 })],
  });
  const q = await docs.getDocument('quotation', qid);
  assert.equal(q.number, 'QUO-0001');
  const invId = await docs.convertQuotationToInvoice(qid);
  const q2 = await docs.getDocument('quotation', qid);
  const inv = await docs.getDocument('invoice', invId);
  assert.equal(q2.status, 'accepted');
  assert.equal(q2.converted_invoice_id, invId);
  assert.equal(inv.quotation_id, qid);
  assert.equal(inv.total_minor, q.total_minor);
  assert.equal(inv.items[0].description, 'Website');
  await assert.rejects(docs.convertQuotationToInvoice(qid), /already been converted/);
  assert.equal((await docs.listDocuments('quotation')).length, 1, 'quotation is preserved');
});

test('customer removal archives instead of destroying history', async () => {
  const lonely = await customers.createCustomer({ name: 'No Docs Ltd' });
  assert.equal(await customers.removeCustomer(lonely.id), 'deleted');
  assert.equal(await customers.removeCustomer(acme.id), 'archived');
  const listed = await customers.listCustomers();
  assert.ok(!listed.some((c) => c.id === acme.id), 'archived hidden by default');
  assert.ok((await customers.listCustomers({ includeArchived: true })).some((c) => c.id === acme.id));
  const prof = await customers.customerProfile(acme.id);
  assert.ok(prof.invoices.length >= 3, 'invoices still linked');
  assert.ok(prof.quotations.length === 1);
  assert.ok(prof.balances[0].balance_minor > 0);
  assert.ok(prof.transactions.some((t) => t.kind === 'payment'));
  // Hard delete is impossible while invoices reference the customer.
  await assert.rejects(getDb().run('DELETE FROM customers WHERE id = ?', [acme.id]), /FOREIGN KEY/);
  await customers.restoreCustomer(acme.id);
});

test('analytics reflect the real records', async () => {
  const range = analytics.resolveRange('all');
  const m = await analytics.dashboardMetrics({ currency: 'USD', ...range });
  const all = await getDb().all("SELECT * FROM invoices WHERE deleted_at IS NULL AND status NOT IN ('draft','cancelled')");
  assert.equal(m.invoiced_minor, all.reduce((a, i) => a + i.total_minor, 0));
  assert.equal(m.outstanding_minor, all.filter((i) => i.status !== 'paid').reduce((a, i) => a + i.total_minor - i.paid_minor, 0));
  assert.equal(m.invoices_draft, 1);
  const top = await analytics.topProducts({ currency: 'USD', ...range });
  assert.ok(top.find((t) => t.name === 'Website'));
  const months = await analytics.monthlyRevenue({ currency: 'USD', ...range });
  assert.equal(months.reduce((a, x) => a + x.invoiced_minor, 0), m.invoiced_minor);
});

test('offline persistence: data survives closing and reopening the database', async () => {
  const before = await docs.listDocuments('invoice');
  const db = await reopenApp(dir);
  const after = await db.all('SELECT id FROM invoices WHERE deleted_at IS NULL');
  assert.equal(after.length, before.length);
  assert.equal(await currentVersion(db), LATEST_VERSION);
  const queued = await db.get("SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'");
  assert.ok(queued.n > 0, 'pending sync operations are durable');
});
