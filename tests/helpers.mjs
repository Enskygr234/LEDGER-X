import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDriverFactory, closeDatabase } from '../src/storage/sqlite.js';
import { createNodeDriverFactory } from '../src/storage/adapters/nodeDriver.js';
import { initDatabase, MAIN_DB } from '../src/services/database.js';
import { saveBusinessProfile } from '../src/services/settingsService.js';

/** Fresh on-disk database directory per test file (exercises real persistence). */
export async function freshApp({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerx-')), currency = 'USD' } = {}) {
  setDriverFactory(createNodeDriverFactory(dir));
  const db = await initDatabase();
  if (!(await db.get('SELECT 1 FROM business_profiles'))) {
    await saveBusinessProfile({ name: 'Test Co', default_currency: currency, default_tax_rate_bp: 1800 });
  }
  return { db, dir };
}

export async function reopenApp(dir) {
  await closeDatabase(MAIN_DB);
  setDriverFactory(createNodeDriverFactory(dir));
  return initDatabase();
}

export const line = (description, qty, priceMinor, extra = {}) => ({
  description, quantity_milli: Math.round(qty * 1000), unit_price_minor: priceMinor, tax_rate_bp: 0, discount_type: 'none', discount_value: 0, ...extra,
});
