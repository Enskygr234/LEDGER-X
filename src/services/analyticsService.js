/**
 * Read-only reporting queries. Every figure is computed from the local SQLite
 * database at call time — there is no cached or synthetic analytics data.
 *
 * Money is aggregated per currency; callers pick a currency (normally the
 * business default) and get `otherCurrencies` listed so nothing is silently
 * mixed.
 */
import { getDb } from './database.js';
import { todayISO, addDaysISO } from '../utils/formatting.js';
import { currentVersion } from '../storage/migrations.js';

const BILLABLE = "status NOT IN ('draft','cancelled') AND deleted_at IS NULL";

export function resolveRange(preset, custom = {}) {
  const today = todayISO();
  switch (preset) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDaysISO(today, -6), to: today };
    case '30d': return { from: addDaysISO(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom': return { from: custom.from || '0000-01-01', to: custom.to || today };
    default: return { from: '0000-01-01', to: '9999-12-31' };
  }
}

function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 120) break;
  }
  return out;
}

export async function dashboardMetrics({ currency, from, to }) {
  const db = getDb();
  const rangeP = [currency, from, to];
  const inv = await db.get(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
       SUM(CASE WHEN status IN ('pending','partially_paid','overdue') THEN 1 ELSE 0 END) AS unpaid,
       SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
       COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN total_minor END), 0) AS invoiced_minor
     FROM invoices WHERE deleted_at IS NULL AND currency = ? AND issue_date BETWEEN ? AND ?`, rangeP);
  const collected = await db.get(
    `SELECT COALESCE(SUM(p.amount_minor), 0) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL AND i.currency = ? AND substr(p.paid_at, 1, 10) BETWEEN ? AND ?`, rangeP);
  const outstanding = await db.get(
    `SELECT COALESCE(SUM(total_minor - paid_minor), 0) AS s FROM invoices
     WHERE ${BILLABLE} AND currency = ? AND status <> 'paid'`, [currency]);
  const customers = await db.get('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND archived_at IS NULL');
  const products = await db.get('SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL');
  const others = await db.all('SELECT DISTINCT currency FROM invoices WHERE deleted_at IS NULL AND currency <> ?', [currency]);

  // Previous period of equal length, for comparison.
  let previous = null;
  if (from > '0001') {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const pTo = addDaysISO(from, -1);
    const pFrom = addDaysISO(pTo, -(days - 1));
    const prev = await db.get(
      `SELECT COALESCE(SUM(total_minor), 0) AS s FROM invoices WHERE ${BILLABLE} AND currency = ? AND issue_date BETWEEN ? AND ?`,
      [currency, pFrom, pTo]);
    previous = { from: pFrom, to: pTo, invoiced_minor: Number(prev.s) };
  }

  return {
    currency,
    invoiced_minor: Number(inv.invoiced_minor),
    collected_minor: Number(collected.s),
    outstanding_minor: Number(outstanding.s),
    invoices_total: Number(inv.total || 0),
    invoices_paid: Number(inv.paid || 0),
    invoices_unpaid: Number(inv.unpaid || 0),
    invoices_overdue: Number(inv.overdue || 0),
    invoices_draft: Number(inv.drafts || 0),
    customers: Number(customers.n),
    products: Number(products.n),
    previous,
    otherCurrencies: others.map((o) => o.currency),
  };
}

export async function monthlyRevenue({ currency, from, to }) {
  const db = getDb();
  const today = todayISO();
  const realFrom = from > '0001' ? from : (await db.get('SELECT MIN(issue_date) AS d FROM invoices WHERE deleted_at IS NULL'))?.d || addDaysISO(today, -150);
  const realTo = to < '9999' ? to : today;
  const start = realFrom.slice(0, 7) < addDaysISO(realTo, -365 * 3).slice(0, 7) ? addDaysISO(realTo, -365 * 3) : realFrom;
  const invoiced = await db.all(
    `SELECT substr(issue_date, 1, 7) AS m, SUM(total_minor) AS s FROM invoices
     WHERE ${BILLABLE} AND currency = ? AND issue_date BETWEEN ? AND ? GROUP BY m`, [currency, start, realTo]);
  const collected = await db.all(
    `SELECT substr(p.paid_at, 1, 7) AS m, SUM(p.amount_minor) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL AND i.currency = ? AND substr(p.paid_at, 1, 10) BETWEEN ? AND ? GROUP BY m`,
    [currency, start, realTo]);
  const expenses = await db.all(
    `SELECT substr(spent_at, 1, 7) AS m, SUM(amount_minor) AS s FROM expenses
     WHERE deleted_at IS NULL AND currency = ? AND substr(spent_at, 1, 10) BETWEEN ? AND ? GROUP BY m`, [currency, start, realTo]);
  const mi = new Map(invoiced.map((r) => [r.m, Number(r.s)]));
  const mc = new Map(collected.map((r) => [r.m, Number(r.s)]));
  const me = new Map(expenses.map((r) => [r.m, Number(r.s)]));
  return monthsBetween(start, realTo).map((m) => ({ month: m, invoiced_minor: mi.get(m) || 0, collected_minor: mc.get(m) || 0, expenses_minor: me.get(m) || 0 }));
}

export async function statusDistribution({ currency, from, to }) {
  const rows = await getDb().all(
    `SELECT status, COUNT(*) AS n, SUM(total_minor) AS s FROM invoices
     WHERE deleted_at IS NULL AND currency = ? AND issue_date BETWEEN ? AND ? GROUP BY status`, [currency, from, to]);
  return rows.map((r) => ({ status: r.status, count: Number(r.n), total_minor: Number(r.s) }));
}

export async function topCustomers({ currency, from, to, limit = 5 }) {
  return getDb().all(
    `SELECT COALESCE(c.name, json_extract(i.customer_snapshot, '$.name')) AS name, i.customer_id AS id,
       COUNT(*) AS invoices, SUM(i.total_minor) AS total_minor, SUM(i.paid_minor) AS paid_minor
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.status NOT IN ('draft','cancelled') AND i.deleted_at IS NULL AND i.currency = ? AND i.issue_date BETWEEN ? AND ?
     GROUP BY i.customer_id ORDER BY total_minor DESC LIMIT ?`, [currency, from, to, limit]);
}

export async function topProducts({ currency, from, to, limit = 5 }) {
  return getDb().all(
    `SELECT COALESCE(p.name, it.description) AS name, it.product_id AS id,
       SUM(it.quantity_milli) AS quantity_milli, SUM(it.line_total_minor) AS total_minor
     FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id LEFT JOIN products p ON p.id = it.product_id
     WHERE it.deleted_at IS NULL AND i.deleted_at IS NULL AND i.status NOT IN ('draft','cancelled')
       AND i.currency = ? AND i.issue_date BETWEEN ? AND ?
     GROUP BY COALESCE(it.product_id, it.description) ORDER BY total_minor DESC LIMIT ?`, [currency, from, to, limit]);
}

export async function customerActivity({ from, to }) {
  return getDb().all(
    `SELECT substr(issue_date, 1, 7) AS month, COUNT(DISTINCT customer_id) AS active_customers, COUNT(*) AS documents
     FROM (SELECT customer_id, issue_date FROM invoices WHERE deleted_at IS NULL AND issue_date BETWEEN ? AND ?
           UNION ALL SELECT customer_id, issue_date FROM quotations WHERE deleted_at IS NULL AND issue_date BETWEEN ? AND ?)
     GROUP BY month ORDER BY month`, [from, to, from, to]);
}

export async function recentInvoices(limit = 5) {
  return getDb().all(
    `SELECT i.*, COALESCE(c.name, json_extract(i.customer_snapshot, '$.name')) AS customer_name
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.deleted_at IS NULL
     ORDER BY i.updated_at DESC LIMIT ?`, [limit]);
}

export async function recentTransactions(limit = 6) {
  return getDb().all(
    `SELECT p.id, p.amount_minor, p.paid_at, p.method, i.number, i.currency, i.id AS invoice_id,
       COALESCE(c.name, json_extract(i.customer_snapshot, '$.name')) AS customer_name
     FROM payments p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customers c ON c.id = i.customer_id
     WHERE p.deleted_at IS NULL ORDER BY p.paid_at DESC LIMIT ?`, [limit]);
}

export async function expenseTotals({ currency, from, to }) {
  const r = await getDb().get(
    'SELECT COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL AND currency = ? AND substr(spent_at,1,10) BETWEEN ? AND ?',
    [currency, from, to]);
  return { total_minor: Number(r.s), count: Number(r.n) };
}

export async function businessDbStats() {
  const db = getDb();
  return { schemaVersion: await currentVersion(db), sizeBytes: await db.sizeBytes() };
}

const BUSINESS_TABLES = ['customers', 'products', 'invoices', 'invoice_items', 'quotations', 'quotation_items', 'payments', 'expenses', 'tax_rates'];

/** Records created per month across business tables (database growth). */
export async function databaseGrowth() {
  const union = BUSINESS_TABLES.map((t) => `SELECT substr(created_at, 1, 7) AS m FROM ${t}`).join(' UNION ALL ');
  const rows = await getDb().all(`SELECT m AS month, COUNT(*) AS n FROM (${union}) GROUP BY m ORDER BY m`);
  let cum = 0;
  return rows.map((r) => ({ month: r.month, added: Number(r.n), total: (cum += Number(r.n)) }));
}

/** Row counts and last modification per business table. */
export async function tableActivity() {
  const out = [];
  for (const t of BUSINESS_TABLES) {
    const r = await getDb().get(`SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM ${t}`);
    const cols = await getDb().all(`PRAGMA table_info(${t})`);
    out.push({ table: t, rows: Number(r.n), last: r.last, columns: cols.length });
  }
  return out;
}

export async function currenciesInUse() {
  const rows = await getDb().all('SELECT currency, COUNT(*) AS n FROM invoices WHERE deleted_at IS NULL GROUP BY currency ORDER BY n DESC');
  return rows.map((r) => r.currency);
}
