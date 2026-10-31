#!/usr/bin/env node
/**
 * End-to-end UI test in headless Chromium against the dev server (real
 * on-disk SQLite through the dev bridge). Exercises the main user journeys,
 * reloads the page to prove persistence, fails on any console error, and
 * writes phone-sized screenshots to ./screenshots.
 *
 *   npm run build && node --experimental-sqlite scripts/e2e.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = path.join(root, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerx-e2e-'));
const PORT = 5199;
const server = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', path.join(root, 'scripts/dev-server.mjs'), '--port', String(PORT), '--data', data], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const BASE = `http://127.0.0.1:${PORT}/`;
let step = 0;
const log = (s) => console.log(`  ✓ ${s}`);
const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`) }); };
const go = async (hash) => { await page.goto(`${BASE}#${hash}`); await page.waitForSelector('.page .stack, .page .stack-lg, .page form', { timeout: 10000 }); await page.waitForTimeout(300); };
const sheet = () => page.locator('.sheet').last();
const fill = (scope, label, value) => scope.locator('.field').filter({ has: page.locator(`label:text-is("${label}")`) }).locator('input, textarea, select').first().fill(value);
const expectText = async (text) => { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 }); };

try {
  // ---------------- boot & dashboard
  await page.goto(BASE);
  await page.waitForSelector('.bottomnav');
  await expectText('Welcome to LEDGER X');
  await shot('dashboard-empty');
  log('first launch shows onboarding with real (empty) data');

  // ---------------- business profile
  await go('/settings/business');
  await fill(page, 'Business name', 'Northwind Studio');
  await fill(page, 'Email', 'hello@northwind.studio');
  await fill(page, 'Address', 'Bağdat Cd. 123\nKadıköy, İstanbul');
  await fill(page, 'Payment information', 'IBAN TR00 0000 0000 0000 0000 0000 00');
  await page.locator('.field', { has: page.locator('label:text-is("Default tax rate %")') }).locator('input').fill('20');
  await page.getByRole('button', { name: 'Save business profile' }).click();
  await expectText('Business profile saved');
  log('business profile saved');

  // ---------------- customer via quick actions
  await go('/dashboard');
  await page.locator('.fab').click();
  await shot('quick-actions');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await fill(sheet(), 'Name', 'Globex Corporation');
  await fill(sheet(), 'Email', 'not-an-email');
  await sheet().getByRole('button', { name: 'Save' }).click();
  await expectText('Enter a valid email address');
  await fill(sheet(), 'Email', 'ap@globex.test');
  await fill(sheet(), 'Phone', '+1 555 0100');
  await sheet().getByRole('button', { name: 'Save' }).click();
  await expectText('Customer added');
  log('customer created with inline validation');

  // ---------------- products
  await go('/products');
  for (const [name, price, unit, kind] of [['Brand identity design', '2400', 'pcs', 'product'], ['Consulting', '120', 'h', 'service']]) {
    await page.getByRole('button', { name: 'Add product' }).first().click();
    await fill(sheet(), 'Name', name);
    await sheet().locator('select[name=kind]').selectOption(kind);
    await fill(sheet(), 'Unit', unit);
    await fill(sheet(), 'Unit price', price);
    await sheet().getByRole('button', { name: 'Save' }).click();
    await expectText('Product added');
  }
  await page.waitForTimeout(300);
  await shot('products');
  log('products and services added');

  // ---------------- invoice
  await go('/invoices/new');
  await page.locator('select[data-name=customer_id]').selectOption({ label: 'Globex Corporation' });
  await page.getByRole('button', { name: 'Catalog' }).click();
  await sheet().getByText('Brand identity design').click();
  await page.getByRole('button', { name: 'Catalog' }).click();
  await sheet().getByText('Consulting').click();
  const lines = page.locator('.line-card');
  await lines.nth(1).locator('input[data-name=qty]').fill('7.5');
  await lines.nth(1).locator('select[data-name=dtype]').selectOption('percent');
  await lines.nth(1).locator('input.num').nth(3).fill('10');
  await page.locator('select[data-name=status]').selectOption('pending');
  await page.locator('textarea[data-name=notes]').fill('Thank you for your business!');
  await page.waitForTimeout(200);
  // 2400×1 @20% = 2880 ; 7.5h×120 = 900 −10% = 810 @20% = 972 → 3852
  await expectText('$3,852.00');
  await shot('invoice-editor');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expectText('INV-0001');
  await expectText('$3,852.00');
  await shot('invoice-view');
  log('invoice created; totals computed exactly ($3,852.00)');
  const invUrl = page.url();

  // ---------------- payment
  await page.getByRole('button', { name: 'Record payment' }).click();
  await sheet().locator('input[data-name=amount]').fill('1000');
  await sheet().getByRole('button', { name: 'Record payment' }).click();
  await expectText('Payment recorded');
  await expectText('Partially paid');
  log('partial payment recorded; status derived');

  // ---------------- PDF preview
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.waitForSelector('.pdf-pages canvas', { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot('pdf-preview');
  const [download] = await Promise.all([page.waitForEvent('download'), sheet().getByRole('button', { name: 'Save' }).click()]);
  const pdfPath = path.join(shots, 'sample-invoice.pdf');
  await download.saveAs(pdfPath);
  if (fs.statSync(pdfPath).size < 2000) throw new Error('PDF too small');
  await page.keyboard.press('Escape');
  log(`PDF generated, previewed with PDF.js, and saved (${fs.statSync(pdfPath).size} bytes)`);

  // ---------------- persistence across reload ("close and reopen")
  await page.reload();
  await page.waitForSelector('.doc-amount');
  await expectText('INV-0001');
  await expectText('$1,000.00 paid');
  log('invoice and payment persist after reload (real SQLite on disk)');

  // ---------------- quotation → invoice
  await go('/quotations/new');
  await page.locator('select[data-name=customer_id]').selectOption({ label: 'Globex Corporation' });
  await page.locator('input[data-name=description]').first().fill('Website redesign — phase 1');
  await page.locator('input[data-name=price]').first().fill('5000');
  await page.locator('select[data-name=status]').selectOption('sent');
  await page.getByRole('button', { name: 'Create quotation' }).click();
  await expectText('QUO-0001');
  await page.getByRole('button', { name: 'Convert to invoice' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Convert' }).click();
  await expectText('INV-0002');
  await expectText('QUO-0001');
  log('quotation converted to invoice with two-way reference');

  // ---------------- lists & dashboard
  await go('/invoices');
  await shot('invoices');
  await go('/dashboard');
  await page.waitForSelector('.hero');
  await expectText('Northwind Studio');
  await shot('dashboard');
  log('dashboard computes metrics from the local database');

  // ---------------- customer profile
  await go('/customers');
  await page.getByText('Globex Corporation').first().click();
  await expectText('Transaction history');
  await shot('customer-profile');
  log('customer profile with balance, documents and history');

  // ---------------- Database Studio
  await go('/studio');
  await shot('studio');
  await page.getByRole('button', { name: 'New database' }).first().click();
  await fill(sheet(), 'Name', 'Inventory');
  await sheet().getByRole('button', { name: 'Create database' }).click();
  await expectText('No tables yet');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const ta = page.locator('.sql-editor textarea');
  await ta.fill(`CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, country TEXT);
CREATE TABLE parts (id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE, label TEXT NOT NULL, price REAL, in_stock BOOLEAN DEFAULT 1);
CREATE TABLE orders (id INTEGER PRIMARY KEY, part_id INTEGER REFERENCES parts(id), qty INTEGER NOT NULL, ordered_on DATE);
INSERT INTO suppliers (name, country) VALUES ('Bolt Bros', 'DE'), ('Nuts & Co', 'TR'), ('Gearworks', 'US');
INSERT INTO parts (supplier_id, label, price) VALUES (1, 'M6 bolt', 0.12), (1, 'M8 bolt', 0.18), (2, 'Hex nut', 0.05), (3, 'Spur gear', 4.5);
INSERT INTO orders (part_id, qty, ordered_on) VALUES (1, 500, '2026-10-01'), (4, 12, '2026-10-20');`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectText('rows affected');
  await ta.fill('select s.name, count(p.id) as parts, round(avg(p.price),2) as avg_price from suppliers s left join parts p on p.supplier_id = s.id group by s.id order by parts desc');
  await page.getByRole('button', { name: 'Format' }).click();
  await page.getByRole('button', { name: 'Explain' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectText('3 rows');
  await shot('sql-editor');
  log('SQL editor: DDL + DML executed, formatted, explained, results shown');

  await ta.fill('DELETE FROM orders');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.locator('.dialog').waitFor();
  await expectText('Run destructive statements?');
  await shot('sql-destructive-confirm');
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await expectText('nothing was changed');
  await ta.fill("ATTACH DATABASE 'x.db' AS x");
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectText('restricted to the selected database');
  log('destructive query needs confirmation; ATTACH is blocked');

  await page.getByRole('button', { name: 'ER diagram' }).click();
  await page.waitForSelector('.er-wrap svg .er-node');
  const nodes = await page.locator('.er-node').count();
  if (nodes !== 3) throw new Error(`expected 3 ER nodes, got ${nodes}`);
  await page.waitForTimeout(400);
  await shot('er-diagram');
  log('ER diagram renders the real schema (3 tables, FK edges)');

  await page.getByRole('button', { name: 'Tables' }).click();
  await page.getByText('parts', { exact: true }).click();
  await page.waitForSelector('table.grid');
  await shot('table-data');
  await page.getByRole('tab', { name: 'Structure' }).click();
  await expectText('suppliers.id');
  await shot('table-structure');
  log('table data grid and structure view');

  // Business DB is read-only in studio
  await go('/studio/__business__/sql');
  await ta.fill('DELETE FROM invoices');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectText('read-only');
  log('business database is read-only from the SQL editor');

  // ---------------- analytics
  await go('/analytics');
  await page.waitForSelector('.stat-grid');
  await shot('analytics');
  await page.getByRole('tab', { name: 'Database' }).click();
  await expectText('Database growth');
  await shot('analytics-database');
  log('analytics (financial + database) from real records');

  // ---------------- settings, backup, sync
  await go('/settings');
  await shot('settings');
  await go('/settings/data');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Create full backup' }).click()]);
  const bkPath = path.join(os.tmpdir(), 'ledgerx-e2e-backup.json');
  await bk.saveAs(bkPath);
  const parsed = JSON.parse(fs.readFileSync(bkPath, 'utf8'));
  if (parsed.format !== 'ledgerx-backup' || parsed.tables.invoices.length !== 2 || parsed.projects.length !== 1) throw new Error('backup content wrong');
  await expectText('Backup saved');
  log('full backup downloaded with invoices + Studio project');
  await go('/settings/sync');
  await expectText('Cloud sync is off');
  await go('/settings/account');
  await expectText('Connect a cloud account');
  await shot('account');
  log('local-only mode; account connection offered explicitly');

  // ---------------- offline banner
  // (The dev build reaches SQLite over localhost, so we emit the OS network
  // event instead of cutting the browser off entirely.)
  await go('/dashboard');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expectText('You’re offline');
  await page.waitForSelector('.hero');
  await shot('offline');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  log('offline state shown, app keeps working');

  // ---------------- light theme
  await go('/settings');
  await page.getByRole('tab', { name: 'Light' }).click();
  await go('/dashboard');
  await page.waitForSelector('.hero');
  await shot('dashboard-light');
  await go(new URL(invUrl).hash.slice(1));
  await shot('invoice-view-light');
  await page.reload();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'light') throw new Error('theme not persisted');
  log('light theme applied and persisted');

  // Android back-button behaviour is simulated by Escape on overlays
  await page.locator('.fab').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await page.locator('.overlay').count()) throw new Error('overlay did not close');

  const relevant = errors.filter((e) => !/favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  if (relevant.length) throw new Error(`Console errors:\n${relevant.join('\n')}`);
  console.log(`\nE2E passed — ${step} screenshots in screenshots/`);
} catch (e) {
  await page.screenshot({ path: path.join(shots, 'FAILURE.png') }).catch(() => {});
  console.error('\nE2E FAILED:', e.message);
  if (errors.length) console.error('Console errors:\n', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
