import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshApp, reopenApp, line } from './helpers.mjs';
import { getDb } from '../src/services/database.js';
import * as customers from '../src/services/customerService.js';
import * as docs from '../src/services/invoiceService.js';
import * as studio from '../src/services/studioService.js';
import * as backup from '../src/services/backupService.js';
import { todayISO } from '../src/utils/formatting.js';

let snapshot, invId, quoteId, pid;

before(async () => {
  await freshApp();
  const c = await customers.createCustomer({ name: 'Initech' });
  quoteId = await docs.saveDocument('quotation', { customer_id: c.id, issue_date: todayISO(), currency: 'USD', status: 'sent', items: [line('TPS reports', 10, 5000)] });
  invId = await docs.convertQuotationToInvoice(quoteId);
  await docs.recordPayment(invId, { amount_minor: 10000 });
  pid = await studio.createProject({ name: 'Lab' });
  await studio.createTable(pid, { name: 'samples', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'label', type: 'TEXT' }] });
  await studio.insertRow(pid, 'samples', { label: "O'Reilly" });
});

test('backup contains every table, projects, and a valid checksum', async () => {
  snapshot = await backup.createBackup();
  const { doc } = snapshot;
  assert.equal(doc.tables.invoices.length, 1);
  assert.equal(doc.tables.invoice_items.length, 1);
  assert.equal(doc.tables.payments.length, 1);
  assert.equal(doc.projects.length, 1);
  const v = await backup.validateBackup(snapshot.json);
  assert.ok(v.ok, v.errors.join());
  await backup.recordBackup({ ...snapshot, location: 'test' });
  assert.equal((await backup.backupHistory()).length, 1);
});

test('validation catches tampering, foreign files and broken relationships', async () => {
  const tampered = JSON.parse(snapshot.json);
  tampered.tables.invoices[0].total_minor = 1;
  assert.match((await backup.validateBackup(tampered)).errors[0], /Checksum/);
  assert.match((await backup.validateBackup('{"hello":1}')).errors[0], /not a LEDGER X backup/);
  assert.match((await backup.validateBackup('not json')).errors[0], /not valid JSON/);
  const newer = { ...JSON.parse(snapshot.json), schema_version: 999 };
  assert.match((await backup.validateBackup(newer)).errors.join(), /newer version/);
  const orphan = JSON.parse(snapshot.json);
  orphan.tables.payments[0].invoice_id = 'missing';
  orphan.checksum = await backup.sha256(backup.canonicalJSON({ tables: orphan.tables, settings: orphan.settings, projects: orphan.projects }));
  assert.match((await backup.validateBackup(orphan)).errors.join(), /references missing invoices/);
});

test('merge restore never overwrites existing records', async () => {
  await docs.saveDocument('invoice', { ...(await docs.getDocument('invoice', invId)), id: invId, notes: 'edited after backup', items: (await docs.getDocument('invoice', invId)).items });
  const r = await backup.restoreBackup(snapshot.json, { mode: 'merge' });
  assert.equal(r.inserted.invoices, 0);
  assert.equal(r.skipped.invoices, 1);
  assert.equal((await docs.getDocument('invoice', invId)).notes, 'edited after backup');
});

test('restore into an empty install recreates data with relationships intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerx-restore-'));
  await freshApp({ dir });
  const r = await backup.restoreBackup(snapshot.json);
  assert.equal(r.inserted.invoices, 1);
  assert.equal(r.projects, 1);
  const inv = await docs.getDocument('invoice', invId);
  assert.equal(inv.customer.name, 'Initech');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.quotation.id, quoteId, 'invoice ↔ quotation link preserved');
  assert.equal((await docs.getDocument('quotation', quoteId)).converted_invoice_id, invId);
  assert.deepEqual(await getDb().all('PRAGMA foreign_key_check'), []);
  const [p] = await studio.listProjects();
  assert.equal((await studio.queryRows(p.id, 'samples')).rows[0].label, "O'Reilly");
  // Restored rows are queued for sync.
  assert.ok((await getDb().get("SELECT COUNT(*) AS n FROM sync_queue WHERE table_name = 'invoices' AND status = 'pending'")).n === 1);
  // Survives restart.
  const db = await reopenApp(dir);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM invoice_items')).n, 1);
});

test('replace restore takes a safety backup first', async () => {
  await customers.createCustomer({ name: 'Created after backup' });
  const r = await backup.restoreBackup(snapshot.json, { mode: 'replace' });
  assert.ok(r.safetyBackup);
  assert.ok(r.safety.doc.tables.customers.some((c) => c.name === 'Created after backup'));
  assert.ok(!(await customers.listCustomers()).some((c) => c.name === 'Created after backup'));
});

test('SQL export → import round-trips a Studio project', async () => {
  const [p] = await studio.listProjects();
  const sql = await backup.exportProjectSQL(p.id);
  assert.match(sql, /INSERT INTO "samples"/);
  const { id } = await backup.importProjectSQL('Lab copy', sql);
  assert.equal((await studio.queryRows(id, 'samples')).rows[0].label, "O'Reilly");
  const n = await backup.importCSVIntoTable(id, 'samples', 'label\n"a, b"\nc\n');
  assert.equal(n, 2);
  assert.equal((await studio.queryRows(id, 'samples')).total, 3);
  const csv = await backup.exportStudioTableCSV(id, 'samples');
  assert.match(csv, /"a, b"/);
});
