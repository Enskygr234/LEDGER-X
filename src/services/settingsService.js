import { getDb } from './database.js';
import { clock, insertRecord, updateRecord, softDelete, audit } from '../storage/syncQueue.js';
import { validate, required, maxLen, email, currency, intRange, phone } from '../utils/validation.js';

export async function getSetting(key, fallback = null) {
  const row = await getDb().get('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export async function setSetting(key, value) {
  await getDb().run(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), clock.now()],
  );
}

export async function getBusinessProfile(db = getDb()) {
  return db.get('SELECT * FROM business_profiles WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1');
}

const PROFILE_FIELDS = ['name', 'legal_name', 'email', 'phone', 'website', 'address', 'tax_id', 'logo_data_url',
  'default_currency', 'default_tax_rate_bp', 'payment_details', 'invoice_prefix', 'quote_prefix'];

export async function saveBusinessProfile(input) {
  const data = {};
  for (const f of PROFILE_FIELDS) if (input[f] !== undefined) data[f] = typeof input[f] === 'string' ? input[f].trim() : input[f];
  validate(data, {
    name: [required('Business name'), maxLen(120, 'Business name')],
    email: [email()],
    phone: [phone()],
    default_currency: [currency()],
    default_tax_rate_bp: [intRange(0, 100000, 'Default tax rate')],
    invoice_prefix: [maxLen(12, 'Invoice prefix')],
    quote_prefix: [maxLen(12, 'Quotation prefix')],
  });
  if (data.logo_data_url && data.logo_data_url.length > 400_000) throw new Error('Logo image is too large (max ~300 KB)');
  return getDb().tx(async (t) => {
    const existing = await getBusinessProfile(t);
    if (existing) {
      await updateRecord(t, 'business_profiles', existing.id, data);
      await audit(t, 'business_profile', existing.id, 'update', data.name);
      return { ...existing, ...data };
    }
    const row = await insertRecord(t, 'business_profiles', data);
    await audit(t, 'business_profile', row.id, 'create', data.name);
    return row;
  });
}

export async function ensureBusinessProfile() {
  const p = await getBusinessProfile();
  if (p) return p;
  let cur = 'USD';
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const map = { TR: 'TRY', GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', JP: 'JPY', IN: 'INR', CA: 'CAD', AU: 'AUD', CH: 'CHF', AE: 'AED', SA: 'SAR', BR: 'BRL', MX: 'MXN' };
    cur = map[region] || 'USD';
  } catch { /* default */ }
  return saveBusinessProfile({ name: 'My Business', default_currency: cur, default_tax_rate_bp: 0 });
}

/** Allocate the next document number atomically inside a transaction. */
export async function nextDocumentNumber(t, kind /* 'invoice' | 'quote' */) {
  const p = await getBusinessProfile(t);
  if (!p) throw new Error('Business profile missing');
  const seqCol = kind === 'invoice' ? 'next_invoice_seq' : 'next_quote_seq';
  const prefix = kind === 'invoice' ? p.invoice_prefix : p.quote_prefix;
  const table = kind === 'invoice' ? 'invoices' : 'quotations';
  let seq = Number(p[seqCol]);
  // Skip numbers already in use (e.g. records pulled from another device).
  for (;;) {
    const number = `${prefix}${String(seq).padStart(4, '0')}`;
    const taken = await t.get(`SELECT 1 FROM ${table} WHERE number = ? AND deleted_at IS NULL`, [number]);
    if (!taken) {
      await updateRecord(t, 'business_profiles', p.id, { [seqCol]: seq + 1 });
      return number;
    }
    seq += 1;
  }
}

// ---- Tax rates (configurable; no country rules hardcoded) ----
export async function listTaxRates() {
  return getDb().all('SELECT * FROM tax_rates WHERE deleted_at IS NULL ORDER BY rate_bp');
}
export async function saveTaxRate({ id, name, rate_bp, is_default = 0 }) {
  validate({ name, rate_bp }, { name: [required('Name'), maxLen(40, 'Name')], rate_bp: [required('Rate'), intRange(0, 100000, 'Rate')] });
  return getDb().tx(async (t) => {
    if (is_default) {
      const others = await t.all('SELECT id FROM tax_rates WHERE is_default = 1 AND deleted_at IS NULL');
      for (const o of others) if (o.id !== id) await updateRecord(t, 'tax_rates', o.id, { is_default: 0 });
    }
    if (id) { await updateRecord(t, 'tax_rates', id, { name: name.trim(), rate_bp, is_default: is_default ? 1 : 0 }); return id; }
    return (await insertRecord(t, 'tax_rates', { name: name.trim(), rate_bp, is_default: is_default ? 1 : 0 })).id;
  });
}
export async function deleteTaxRate(id) {
  return getDb().tx((t) => softDelete(t, 'tax_rates', id));
}
