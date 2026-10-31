import { getDb } from './database.js';
import { insertRecord, updateRecord, softDelete, audit, clock } from '../storage/syncQueue.js';
import { validate, required, maxLen, email, phone } from '../utils/validation.js';

const FIELDS = ['code', 'name', 'email', 'phone', 'address', 'tax_id', 'notes'];

function clean(input) {
  const out = {};
  for (const f of FIELDS) {
    if (input[f] === undefined) continue;
    const v = typeof input[f] === 'string' ? input[f].trim() : input[f];
    out[f] = v === '' ? null : v;
  }
  return out;
}

function check(data) {
  validate(data, {
    name: [required('Name'), maxLen(160, 'Name')],
    email: [email()],
    phone: [phone()],
    code: [maxLen(32, 'Customer ID')],
    notes: [maxLen(4000, 'Notes')],
  });
}

export async function listCustomers({ search = '', includeArchived = false, limit = 500 } = {}) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (!includeArchived) where.push('c.archived_at IS NULL');
  if (search) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.code LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  params.push(limit);
  return getDb().all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id AND i.deleted_at IS NULL) AS invoice_count,
       (SELECT COALESCE(SUM(i.total_minor - i.paid_minor), 0) FROM invoices i
          WHERE i.customer_id = c.id AND i.deleted_at IS NULL AND i.status NOT IN ('draft','cancelled')) AS balance_minor
     FROM customers c WHERE ${where.join(' AND ')}
     ORDER BY c.name COLLATE NOCASE LIMIT ?`,
    params,
  );
}

export async function getCustomer(id) {
  return getDb().get('SELECT * FROM customers WHERE id = ?', [id]);
}

export async function createCustomer(input) {
  const data = clean(input);
  check(data);
  return getDb().tx(async (t) => {
    if (!data.code) {
      const n = await t.get('SELECT COUNT(*) AS n FROM customers');
      data.code = `C-${String(Number(n.n) + 1).padStart(4, '0')}`;
      while (await t.get('SELECT 1 FROM customers WHERE code = ? AND deleted_at IS NULL', [data.code])) {
        data.code = `C-${Math.floor(Math.random() * 90000 + 10000)}`;
      }
    }
    const row = await insertRecord(t, 'customers', data);
    await audit(t, 'customer', row.id, 'create', data.name);
    return row;
  });
}

export async function updateCustomer(id, input) {
  const data = clean(input);
  const current = await getCustomer(id);
  if (!current || current.deleted_at) throw new Error('Customer not found');
  check({ ...current, ...data });
  return getDb().tx(async (t) => {
    await updateRecord(t, 'customers', id, data);
    await audit(t, 'customer', id, 'update', data.name || current.name);
    return { ...current, ...data };
  });
}

export async function customerLinks(id, db = getDb()) {
  const inv = await db.get('SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND deleted_at IS NULL', [id]);
  const quo = await db.get('SELECT COUNT(*) AS n FROM quotations WHERE customer_id = ? AND deleted_at IS NULL', [id]);
  return { invoices: Number(inv.n), quotations: Number(quo.n) };
}

/**
 * Remove a customer without destroying financial history:
 *  - customers referenced by invoices/quotations are *archived* (hidden from
 *    pickers, still resolvable from their documents);
 *  - customers with no documents are soft-deleted (tombstone is synced).
 * Returns 'archived' | 'deleted'.
 */
export async function removeCustomer(id) {
  return getDb().tx(async (t) => {
    const links = await customerLinks(id, t);
    if (links.invoices + links.quotations > 0) {
      await updateRecord(t, 'customers', id, { archived_at: clock.now() });
      await audit(t, 'customer', id, 'archive', `${links.invoices} invoices, ${links.quotations} quotations preserved`);
      return 'archived';
    }
    await softDelete(t, 'customers', id);
    await audit(t, 'customer', id, 'delete');
    return 'deleted';
  });
}

export async function restoreCustomer(id) {
  return getDb().tx(async (t) => {
    await updateRecord(t, 'customers', id, { archived_at: null });
    await audit(t, 'customer', id, 'unarchive');
  });
}

export async function customerProfile(id) {
  const db = getDb();
  const customer = await getCustomer(id);
  if (!customer) return null;
  const invoices = await db.all(
    'SELECT * FROM invoices WHERE customer_id = ? AND deleted_at IS NULL ORDER BY issue_date DESC, number DESC', [id]);
  const quotations = await db.all(
    'SELECT * FROM quotations WHERE customer_id = ? AND deleted_at IS NULL ORDER BY issue_date DESC, number DESC', [id]);
  const payments = await db.all(
    `SELECT p.*, i.number AS invoice_number, i.currency FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE i.customer_id = ? AND p.deleted_at IS NULL ORDER BY p.paid_at DESC`, [id]);
  // Balances per currency (a customer may be invoiced in several currencies).
  const balances = await db.all(
    `SELECT currency, SUM(total_minor) AS billed_minor, SUM(paid_minor) AS paid_minor, SUM(total_minor - paid_minor) AS balance_minor
     FROM invoices WHERE customer_id = ? AND deleted_at IS NULL AND status NOT IN ('draft','cancelled') GROUP BY currency`, [id]);
  const transactions = [
    ...invoices.filter((i) => i.status !== 'draft').map((i) => ({ kind: 'invoice', date: i.issue_date, ref: i.number, amount_minor: i.total_minor, currency: i.currency, id: i.id })),
    ...payments.map((p) => ({ kind: 'payment', date: p.paid_at.slice(0, 10), ref: p.invoice_number, amount_minor: -p.amount_minor, currency: p.currency, id: p.invoice_id })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  return { customer, invoices, quotations, payments, balances, transactions };
}

export function customerSnapshot(c) {
  if (!c) return null;
  return { id: c.id, code: c.code, name: c.name, email: c.email, phone: c.phone, address: c.address, tax_id: c.tax_id };
}
