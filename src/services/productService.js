import { getDb } from './database.js';
import { insertRecord, updateRecord, softDelete, audit } from '../storage/syncQueue.js';
import { validate, required, maxLen, intRange, currency } from '../utils/validation.js';
import { toCSV } from '../utils/formatting.js';
import { toDecimalString, currencyDigits } from '../utils/calculations.js';

const FIELDS = ['sku', 'name', 'description', 'category', 'kind', 'unit', 'unit_price_minor', 'currency', 'tax_rate_bp', 'is_active'];

function clean(input) {
  const out = {};
  for (const f of FIELDS) {
    if (input[f] === undefined) continue;
    const v = typeof input[f] === 'string' ? input[f].trim() : input[f];
    out[f] = v === '' ? null : v;
  }
  if (out.is_active !== undefined) out.is_active = out.is_active ? 1 : 0;
  return out;
}

function check(d) {
  validate(d, {
    name: [required('Name'), maxLen(160, 'Name')],
    sku: [maxLen(64, 'SKU')],
    kind: [(v) => (!['product', 'service'].includes(v) ? 'Type must be product or service' : null)],
    unit: [required('Unit'), maxLen(16, 'Unit')],
    unit_price_minor: [required('Unit price'), intRange(0, 9e14, 'Unit price')],
    tax_rate_bp: [intRange(0, 100000, 'Tax rate')],
    currency: [currency()],
  });
}

export async function listProducts({ search = '', category = '', kind = '', activeOnly = false } = {}) {
  const where = ['deleted_at IS NULL'];
  const p = [];
  if (search) { where.push('(name LIKE ? OR sku LIKE ? OR description LIKE ?)'); p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (category) { where.push('category = ?'); p.push(category); }
  if (kind) { where.push('kind = ?'); p.push(kind); }
  if (activeOnly) where.push('is_active = 1');
  return getDb().all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE`, p);
}

export async function listCategories() {
  const rows = await getDb().all("SELECT DISTINCT category FROM products WHERE deleted_at IS NULL AND category IS NOT NULL AND category <> '' ORDER BY category");
  return rows.map((r) => r.category);
}

export async function getProduct(id) { return getDb().get('SELECT * FROM products WHERE id = ?', [id]); }

export async function createProduct(input) {
  const d = { kind: 'product', unit: 'pcs', tax_rate_bp: 0, is_active: 1, ...clean(input) };
  check(d);
  return getDb().tx(async (t) => {
    const row = await insertRecord(t, 'products', d);
    await audit(t, 'product', row.id, 'create', d.name);
    return row;
  });
}

export async function updateProduct(id, input) {
  const current = await getProduct(id);
  if (!current || current.deleted_at) throw new Error('Product not found');
  const d = clean(input);
  check({ ...current, ...d });
  return getDb().tx(async (t) => {
    await updateRecord(t, 'products', id, d);
    await audit(t, 'product', id, 'update', d.name || current.name);
    return { ...current, ...d };
  });
}

/** Products referenced by documents keep their line snapshots (description/price live on the item). */
export async function deleteProduct(id) {
  return getDb().tx(async (t) => {
    await softDelete(t, 'products', id);
    await audit(t, 'product', id, 'delete');
  });
}

/** Adjust prices of several products by a percentage (bp, may be negative). */
export async function adjustPrices(ids, percentBp) {
  return getDb().tx(async (t) => {
    for (const id of ids) {
      const p = await t.get('SELECT unit_price_minor FROM products WHERE id = ?', [id]);
      if (!p) continue;
      const v = BigInt(p.unit_price_minor) * BigInt(10000 + percentBp);
      const next = Number((v * 2n + 10000n) / 20000n); // half-up
      await updateRecord(t, 'products', id, { unit_price_minor: Math.max(0, next) });
    }
    await audit(t, 'product', null, 'bulk_price', `${ids.length} products by ${percentBp / 100}%`);
  });
}

export async function exportProductsCSV() {
  const rows = await listProducts();
  return toCSV(rows.map((r) => ({
    sku: r.sku, name: r.name, kind: r.kind, category: r.category, unit: r.unit,
    unit_price: toDecimalString(r.unit_price_minor, currencyDigits(r.currency)), currency: r.currency,
    tax_rate_percent: toDecimalString(r.tax_rate_bp, 2), active: r.is_active ? 'yes' : 'no', description: r.description,
  })));
}
