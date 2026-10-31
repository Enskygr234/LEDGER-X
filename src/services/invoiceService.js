/**
 * Invoices and quotations share one document engine. `kind` is
 * 'invoice' | 'quotation'; table names and status sets come from CONFIG.
 */
import { getDb } from './database.js';
import { insertRecord, updateRecord, softDelete, audit, clock } from '../storage/syncQueue.js';
import { computeDocument, derivePaymentStatus } from '../utils/calculations.js';
import { validate, required, date, currency, maxLen, ValidationError } from '../utils/validation.js';
import { nextDocumentNumber } from './settingsService.js';
import { customerSnapshot } from './customerService.js';
import { todayISO, addDaysISO } from '../utils/formatting.js';

export const INVOICE_STATUSES = ['draft', 'pending', 'partially_paid', 'paid', 'overdue', 'cancelled'];
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];

const CONFIG = {
  invoice: { table: 'invoices', items: 'invoice_items', fk: 'invoice_id', dateField: 'due_date', statuses: INVOICE_STATUSES, numberKind: 'invoice' },
  quotation: { table: 'quotations', items: 'quotation_items', fk: 'quotation_id', dateField: 'expiry_date', statuses: QUOTATION_STATUSES, numberKind: 'quote' },
};
const cfg = (kind) => {
  const c = CONFIG[kind];
  if (!c) throw new Error(`Unknown document kind ${kind}`);
  return c;
};

const SORTS = {
  date_desc: 'd.issue_date DESC, d.number DESC',
  date_asc: 'd.issue_date ASC, d.number ASC',
  total_desc: 'd.total_minor DESC',
  total_asc: 'd.total_minor ASC',
  number_desc: 'd.number DESC',
  customer_asc: 'customer_name COLLATE NOCASE ASC',
};

export async function listDocuments(kind, { search = '', status = '', sort = 'date_desc', customerId = '', from = '', to = '', limit = 1000 } = {}) {
  const c = cfg(kind);
  const where = ['d.deleted_at IS NULL'];
  const p = [];
  if (status) { where.push('d.status = ?'); p.push(status); }
  if (customerId) { where.push('d.customer_id = ?'); p.push(customerId); }
  if (from) { where.push('d.issue_date >= ?'); p.push(from); }
  if (to) { where.push('d.issue_date <= ?'); p.push(to); }
  if (search) {
    where.push("(d.number LIKE ? OR COALESCE(cu.name, json_extract(d.customer_snapshot, '$.name')) LIKE ? OR d.notes LIKE ?)");
    p.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  p.push(limit);
  return getDb().all(
    `SELECT d.*, COALESCE(cu.name, json_extract(d.customer_snapshot, '$.name')) AS customer_name
     FROM ${c.table} d LEFT JOIN customers cu ON cu.id = d.customer_id
     WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort] || SORTS.date_desc} LIMIT ?`, p);
}

export async function getDocument(kind, id) {
  const c = cfg(kind);
  const db = getDb();
  const doc = await db.get(`SELECT * FROM ${c.table} WHERE id = ?`, [id]);
  if (!doc) return null;
  doc.items = await db.all(`SELECT * FROM ${c.items} WHERE ${c.fk} = ? AND deleted_at IS NULL ORDER BY position`, [id]);
  doc.customer = doc.customer_id ? await db.get('SELECT * FROM customers WHERE id = ?', [doc.customer_id]) : null;
  doc.customer_snapshot = doc.customer_snapshot ? JSON.parse(doc.customer_snapshot) : null;
  if (kind === 'invoice') {
    doc.payments = await db.all('SELECT * FROM payments WHERE invoice_id = ? AND deleted_at IS NULL ORDER BY paid_at', [id]);
    if (doc.quotation_id) doc.quotation = await db.get('SELECT id, number FROM quotations WHERE id = ?', [doc.quotation_id]);
  } else if (doc.converted_invoice_id) {
    doc.invoice = await db.get('SELECT id, number FROM invoices WHERE id = ?', [doc.converted_invoice_id]);
  }
  doc.tax_breakdown = computeDocument(doc.items).tax_breakdown;
  return doc;
}

function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError({ items: 'Add at least one line item' });
  return items.map((it, i) => {
    const desc = String(it.description || '').trim();
    if (!desc) throw new ValidationError({ items: `Line ${i + 1}: description is required` });
    if (!Number.isSafeInteger(it.quantity_milli) || it.quantity_milli <= 0) throw new ValidationError({ items: `Line ${i + 1}: quantity must be greater than zero` });
    if (!Number.isSafeInteger(it.unit_price_minor) || it.unit_price_minor < 0) throw new ValidationError({ items: `Line ${i + 1}: unit price is invalid` });
    const discount_type = ['none', 'percent', 'amount'].includes(it.discount_type) ? it.discount_type : 'none';
    const discount_value = discount_type === 'none' ? 0 : Number(it.discount_value || 0);
    if (!Number.isSafeInteger(discount_value) || discount_value < 0 || (discount_type === 'percent' && discount_value > 10000)) {
      throw new ValidationError({ items: `Line ${i + 1}: discount is invalid` });
    }
    const tax_rate_bp = Number(it.tax_rate_bp || 0);
    if (!Number.isSafeInteger(tax_rate_bp) || tax_rate_bp < 0 || tax_rate_bp > 100000) throw new ValidationError({ items: `Line ${i + 1}: tax rate is invalid` });
    return {
      id: it.id || null,
      product_id: it.product_id || null,
      description: desc.slice(0, 500),
      unit: it.unit || null,
      quantity_milli: it.quantity_milli,
      unit_price_minor: it.unit_price_minor,
      discount_type, discount_value, tax_rate_bp,
      position: i,
    };
  });
}

/**
 * Create or update a document. `input` = header fields + `items`.
 * Totals are always recomputed here from the items — never trusted from the UI.
 */
export async function saveDocument(kind, input) {
  const c = cfg(kind);
  const header = {
    customer_id: input.customer_id || null,
    issue_date: input.issue_date,
    [c.dateField]: input[c.dateField] || null,
    currency: input.currency,
    notes: input.notes?.trim() || null,
    terms: input.terms?.trim() || null,
  };
  validate(header, {
    customer_id: [required('Customer')],
    issue_date: [required('Date'), date('Date')],
    [c.dateField]: [date(kind === 'invoice' ? 'Due date' : 'Expiry date'),
      (v, d) => (v && d.issue_date && v < d.issue_date ? `${kind === 'invoice' ? 'Due' : 'Expiry'} date cannot be before the issue date` : null)],
    currency: [currency()],
    notes: [maxLen(4000, 'Notes')],
  });
  const items = normaliseItems(input.items);
  const totals = computeDocument(items);
  const status = input.status && c.statuses.includes(input.status) ? input.status : 'draft';

  return getDb().tx(async (t) => {
    const customer = await t.get('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [header.customer_id]);
    if (!customer) throw new ValidationError({ customer_id: 'Customer not found' });
    if (input.product_check !== false) {
      for (const it of items) {
        if (it.product_id && !(await t.get('SELECT 1 FROM products WHERE id = ?', [it.product_id]))) it.product_id = null;
      }
    }
    const fields = {
      ...header,
      customer_snapshot: JSON.stringify(customerSnapshot(customer)),
      subtotal_minor: totals.subtotal_minor,
      discount_minor: totals.discount_minor,
      tax_minor: totals.tax_minor,
      total_minor: totals.total_minor,
    };
    let id = input.id;
    if (id) {
      const existing = await t.get(`SELECT * FROM ${c.table} WHERE id = ? AND deleted_at IS NULL`, [id]);
      if (!existing) throw new Error('Document not found');
      if (kind === 'invoice') {
        if (totals.total_minor < existing.paid_minor) {
          throw new ValidationError({ items: 'Total cannot be lower than the amount already paid' });
        }
        fields.status = derivePaymentStatus({ status, total_minor: totals.total_minor, paid_minor: existing.paid_minor, due_date: header.due_date });
      } else {
        fields.status = status;
      }
      if (input.number && input.number !== existing.number) fields.number = await uniqueNumber(t, c, input.number, id);
      await updateRecord(t, c.table, id, fields);
      // Reconcile line items: update kept, insert new, soft-delete removed.
      const old = await t.all(`SELECT id FROM ${c.items} WHERE ${c.fk} = ? AND deleted_at IS NULL`, [id]);
      const keep = new Set();
      for (const [i, it] of items.entries()) {
        const line = { ...it, ...totals.lines[i] };
        delete line.id;
        if (it.id && old.some((o) => o.id === it.id)) {
          await updateRecord(t, c.items, it.id, line);
          keep.add(it.id);
        } else {
          await insertRecord(t, c.items, { ...line, [c.fk]: id });
        }
      }
      for (const o of old) if (!keep.has(o.id)) await softDelete(t, c.items, o.id);
      await audit(t, kind, id, 'update', `${existing.number} total ${totals.total_minor}`);
    } else {
      fields.number = input.number ? await uniqueNumber(t, c, input.number) : await nextDocumentNumber(t, c.numberKind);
      if (kind === 'invoice') {
        fields.paid_minor = 0;
        fields.quotation_id = input.quotation_id || null;
        fields.status = derivePaymentStatus({ status, total_minor: totals.total_minor, paid_minor: 0, due_date: header.due_date });
      } else {
        fields.status = status;
      }
      const row = await insertRecord(t, c.table, fields);
      id = row.id;
      for (const [i, it] of items.entries()) {
        const line = { ...it, ...totals.lines[i] };
        delete line.id;
        await insertRecord(t, c.items, { ...line, [c.fk]: id });
      }
      await audit(t, kind, id, 'create', `${fields.number} total ${totals.total_minor}`);
    }
    return id;
  });
}

async function uniqueNumber(t, c, number, selfId = null) {
  const n = String(number).trim();
  if (!n || n.length > 40) throw new ValidationError({ number: 'Document number is invalid' });
  const taken = await t.get(`SELECT id FROM ${c.table} WHERE number = ? AND deleted_at IS NULL`, [n]);
  if (taken && taken.id !== selfId) throw new ValidationError({ number: `Number ${n} is already used` });
  return n;
}

export async function duplicateDocument(kind, id) {
  const c = cfg(kind);
  const doc = await getDocument(kind, id);
  if (!doc) throw new Error('Document not found');
  const issue = todayISO();
  const span = doc[c.dateField] && doc.issue_date ? Math.round((Date.parse(doc[c.dateField]) - Date.parse(doc.issue_date)) / 86400000) : 30;
  return saveDocument(kind, {
    customer_id: doc.customer_id,
    issue_date: issue,
    [c.dateField]: addDaysISO(issue, Math.max(0, span)),
    currency: doc.currency,
    notes: doc.notes,
    terms: doc.terms,
    status: 'draft',
    items: doc.items.map(({ id: _id, ...it }) => it),
  });
}

/** Invoices with recorded payments cannot be deleted — cancel them instead. */
export async function deleteDocument(kind, id) {
  const c = cfg(kind);
  return getDb().tx(async (t) => {
    const doc = await t.get(`SELECT * FROM ${c.table} WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!doc) return false;
    if (kind === 'invoice' && doc.paid_minor > 0) {
      throw new Error('This invoice has recorded payments. Cancel it instead of deleting to preserve financial history.');
    }
    const items = await t.all(`SELECT id FROM ${c.items} WHERE ${c.fk} = ? AND deleted_at IS NULL`, [id]);
    for (const it of items) await softDelete(t, c.items, it.id);
    await softDelete(t, c.table, id);
    if (kind === 'invoice' && doc.quotation_id) {
      await updateRecord(t, 'quotations', doc.quotation_id, { converted_invoice_id: null });
    }
    await audit(t, kind, id, 'delete', doc.number);
    return true;
  });
}

export async function setStatus(kind, id, status) {
  const c = cfg(kind);
  if (!c.statuses.includes(status)) throw new Error('Invalid status');
  if (kind === 'invoice' && ['paid', 'partially_paid'].includes(status)) {
    throw new Error('Record a payment to mark an invoice as paid');
  }
  return getDb().tx(async (t) => {
    const doc = await t.get(`SELECT * FROM ${c.table} WHERE id = ?`, [id]);
    let next = status;
    if (kind === 'invoice' && status === 'pending') next = derivePaymentStatus({ ...doc, status: 'pending' });
    await updateRecord(t, c.table, id, { status: next });
    await audit(t, kind, id, 'status', `${doc.status} -> ${next}`);
    return next;
  });
}

// ---------------- Payments ----------------

async function recomputePaid(t, invoiceId) {
  const inv = await t.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  const sum = await t.get('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE invoice_id = ? AND deleted_at IS NULL', [invoiceId]);
  const paid = Number(sum.s);
  const status = derivePaymentStatus({ ...inv, status: inv.status === 'draft' ? 'pending' : inv.status, paid_minor: paid });
  await updateRecord(t, 'invoices', invoiceId, { paid_minor: paid, status });
  return { paid, status };
}

export async function recordPayment(invoiceId, { amount_minor, paid_at, method, reference, note }) {
  if (!Number.isSafeInteger(amount_minor) || amount_minor <= 0) throw new ValidationError({ amount: 'Enter a payment amount greater than zero' });
  return getDb().tx(async (t) => {
    const inv = await t.get('SELECT * FROM invoices WHERE id = ? AND deleted_at IS NULL', [invoiceId]);
    if (!inv) throw new Error('Invoice not found');
    if (inv.status === 'cancelled') throw new Error('Cannot record a payment on a cancelled invoice');
    if (inv.paid_minor + amount_minor > inv.total_minor) throw new ValidationError({ amount: 'Payment exceeds the outstanding balance' });
    const row = await insertRecord(t, 'payments', {
      invoice_id: invoiceId, amount_minor, paid_at: paid_at || clock.now(), method: method || null, reference: reference || null, note: note || null,
    });
    const r = await recomputePaid(t, invoiceId);
    await audit(t, 'payment', row.id, 'create', `${inv.number} +${amount_minor}`);
    return { payment: row, ...r };
  });
}

export async function deletePayment(paymentId) {
  return getDb().tx(async (t) => {
    const p = await t.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!p) return;
    await softDelete(t, 'payments', paymentId);
    await recomputePaid(t, p.invoice_id);
    await audit(t, 'payment', paymentId, 'delete', `reversed ${p.amount_minor}`);
  });
}

// ---------------- Quotation → invoice ----------------

export async function convertQuotationToInvoice(quotationId, { dueInDays = 30 } = {}) {
  const q = await getDocument('quotation', quotationId);
  if (!q || q.deleted_at) throw new Error('Quotation not found');
  if (q.converted_invoice_id) throw new Error('This quotation has already been converted');
  if (['rejected', 'expired'].includes(q.status)) throw new Error(`A ${q.status} quotation cannot be converted`);
  const issue = todayISO();
  const invoiceId = await saveDocument('invoice', {
    customer_id: q.customer_id,
    issue_date: issue,
    due_date: addDaysISO(issue, dueInDays),
    currency: q.currency,
    notes: q.notes,
    terms: q.terms,
    status: 'pending',
    quotation_id: q.id,
    items: q.items.map(({ id: _id, ...it }) => it),
  });
  await getDb().tx(async (t) => {
    await updateRecord(t, 'quotations', q.id, { status: 'accepted', converted_invoice_id: invoiceId });
    await audit(t, 'quotation', q.id, 'convert', `-> invoice ${invoiceId}`);
  });
  return invoiceId;
}

/** Move invoices past due to 'overdue' and sent quotations past expiry to 'expired'. */
export async function refreshTimeBasedStatuses(today = todayISO()) {
  return getDb().tx(async (t) => {
    const inv = await t.all(
      "SELECT id FROM invoices WHERE deleted_at IS NULL AND status IN ('pending','partially_paid') AND due_date IS NOT NULL AND due_date < ?", [today]);
    for (const r of inv) await updateRecord(t, 'invoices', r.id, { status: 'overdue' });
    const quo = await t.all(
      "SELECT id FROM quotations WHERE deleted_at IS NULL AND status IN ('draft','sent') AND expiry_date IS NOT NULL AND expiry_date < ?", [today]);
    for (const r of quo) await updateRecord(t, 'quotations', r.id, { status: 'expired' });
    return { overdue: inv.length, expired: quo.length };
  });
}
