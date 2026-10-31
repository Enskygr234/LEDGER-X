import { getDb } from './database.js';
import { insertRecord, updateRecord, softDelete, audit } from '../storage/syncQueue.js';
import { validate, required, maxLen, currency, date } from '../utils/validation.js';

export async function listExpenses({ from = '0000', to = '9999', search = '' } = {}) {
  const p = [from, `${to}￿`];
  let extra = '';
  if (search) { extra = ' AND (description LIKE ? OR vendor LIKE ? OR category LIKE ?)'; p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  return getDb().all(`SELECT * FROM expenses WHERE deleted_at IS NULL AND spent_at BETWEEN ? AND ?${extra} ORDER BY spent_at DESC`, p);
}

export async function saveExpense(input) {
  const d = {
    description: input.description?.trim(), vendor: input.vendor?.trim() || null, category: input.category?.trim() || null,
    amount_minor: input.amount_minor, currency: input.currency, spent_at: input.spent_at,
  };
  validate(d, {
    description: [required('Description'), maxLen(200, 'Description')],
    amount_minor: [(v) => (!Number.isSafeInteger(v) || v <= 0 ? 'Amount must be greater than zero' : null)],
    currency: [currency()],
    spent_at: [required('Date'), date('Date')],
  });
  return getDb().tx(async (t) => {
    if (input.id) { await updateRecord(t, 'expenses', input.id, d); await audit(t, 'expense', input.id, 'update', d.description); return input.id; }
    const row = await insertRecord(t, 'expenses', d);
    await audit(t, 'expense', row.id, 'create', d.description);
    return row.id;
  });
}

export async function deleteExpense(id) {
  return getDb().tx(async (t) => { await softDelete(t, 'expenses', id); await audit(t, 'expense', id, 'delete'); });
}
