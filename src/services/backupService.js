/**
 * Backup, restore and export.
 *
 * A backup is a single JSON document containing every business table, the
 * Database Studio projects (schema + data) and a SHA-256 checksum. Restores
 * are validated (format, schema version, checksum, referential integrity)
 * before anything is written, and never silently overwrite existing records:
 *  - mode 'merge'   (default) inserts only records that don't exist yet;
 *  - mode 'replace' wipes business data first — the UI requires explicit
 *    confirmation and this function takes an automatic safety backup.
 */
import { getDb } from './database.js';
import { LATEST_VERSION, currentVersion } from '../storage/migrations.js';
import { quoteIdent } from '../storage/sqlite.js';
import { SYNCED_TABLES, enqueue, uuid, clock, audit } from '../storage/syncQueue.js';
import * as studio from './studioService.js';
import { toCSV } from '../utils/formatting.js';

export const APP_VERSION = '1.0.0';
const FORMAT = 'ledgerx-backup';
const EXTRA_TABLES = ['saved_queries'];
const RELATIONS = [
  ['invoices', 'customer_id', 'customers'],
  ['invoices', 'quotation_id', 'quotations'],
  ['quotations', 'customer_id', 'customers'],
  ['invoice_items', 'invoice_id', 'invoices'],
  ['quotation_items', 'quotation_id', 'quotations'],
  ['payments', 'invoice_id', 'invoices'],
];

/** Stable JSON (sorted keys) so the checksum is reproducible. */
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}

export async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createBackup({ kind = 'manual', includeProjects = true } = {}) {
  const db = getDb();
  const tables = {};
  for (const t of [...SYNCED_TABLES, ...EXTRA_TABLES]) tables[t] = await db.all(`SELECT * FROM ${quoteIdent(t)}`);
  const settings = (await db.all("SELECT key, value FROM app_settings WHERE key NOT LIKE 'sync.%' AND key NOT LIKE 'cloud.%'"));
  const projects = [];
  if (includeProjects) {
    for (const p of await db.all('SELECT * FROM database_projects')) {
      const layout = await db.all('SELECT table_name, pos_x, pos_y, note FROM database_tables WHERE project_id = ?', [p.id]);
      projects.push({ project: p, layout, dump: await studio.dumpProject(p.id) });
    }
  }
  const payload = { tables, settings, projects };
  const createdAt = clock.now();
  const doc = {
    format: FORMAT,
    format_version: 1,
    app_version: APP_VERSION,
    schema_version: await currentVersion(db),
    created_at: createdAt,
    record_count: Object.values(tables).reduce((a, r) => a + r.length, 0),
    checksum: await sha256(canonicalJSON(payload)),
    ...payload,
  };
  const json = JSON.stringify(doc);
  const fileName = `ledgerx-backup-${createdAt.replace(/[:.]/g, '-').slice(0, 19)}.json`;
  return { doc, json, fileName, sizeBytes: new TextEncoder().encode(json).length };
}

export async function recordBackup({ fileName, location, sizeBytes, doc, kind = 'manual' }) {
  await getDb().run(
    'INSERT INTO backups (id, created_at, file_name, location, size_bytes, record_count, checksum, schema_version, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid(), doc.created_at, fileName, location || null, sizeBytes, doc.record_count, doc.checksum, doc.schema_version, kind]);
}

export async function backupHistory() {
  return getDb().all('SELECT * FROM backups ORDER BY created_at DESC LIMIT 50');
}

/** Validate a backup without touching the database. Returns { ok, errors, warnings, summary }. */
export async function validateBackup(input) {
  const errors = [];
  const warnings = [];
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); } catch { return { ok: false, errors: ['The file is not valid JSON'], warnings, summary: null }; }
  }
  if (!doc || doc.format !== FORMAT) errors.push('This is not a LEDGER X backup file');
  if (errors.length) return { ok: false, errors, warnings, summary: null };
  if (doc.format_version !== 1) errors.push(`Unsupported backup format version ${doc.format_version}`);
  if (!(doc.schema_version <= LATEST_VERSION)) errors.push(`Backup was made by a newer version of LEDGER X (schema ${doc.schema_version}); update the app first`);
  if (!doc.tables || typeof doc.tables !== 'object') errors.push('Backup has no table data');
  if (!errors.length) {
    const expected = await sha256(canonicalJSON({ tables: doc.tables, settings: doc.settings, projects: doc.projects }));
    if (expected !== doc.checksum) errors.push('Checksum mismatch — the file is corrupted or was modified');
    for (const t of Object.keys(doc.tables)) {
      if (![...SYNCED_TABLES, ...EXTRA_TABLES].includes(t)) warnings.push(`Unknown table ${t} will be ignored`);
      if (!Array.isArray(doc.tables[t])) errors.push(`Table ${t} is malformed`);
      else if (doc.tables[t].some((r) => !r || typeof r.id !== 'string')) errors.push(`Table ${t} has records without an id`);
    }
    // Referential integrity inside the backup.
    const ids = Object.fromEntries(Object.entries(doc.tables).map(([t, rows]) => [t, new Set((rows || []).map((r) => r.id))]));
    for (const [child, col, parent] of RELATIONS) {
      for (const r of doc.tables[child] || []) {
        if (r[col] && !ids[parent]?.has(r[col])) {
          const existsLocally = await getDb().get(`SELECT 1 FROM ${quoteIdent(parent)} WHERE id = ?`, [r[col]]);
          if (!existsLocally) errors.push(`${child} ${r.id} references missing ${parent} ${r[col]}`);
        }
      }
    }
  }
  const summary = doc.tables ? Object.fromEntries(Object.entries(doc.tables).map(([t, r]) => [t, (r || []).length])) : null;
  return { ok: errors.length === 0, errors: errors.slice(0, 20), warnings, summary, createdAt: doc.created_at, projects: (doc.projects || []).length, doc };
}

/**
 * Restore. Returns a report { inserted, skipped, projects }.
 * mode: 'merge' | 'replace'
 */
export async function restoreBackup(input, { mode = 'merge' } = {}) {
  const v = await validateBackup(input);
  if (!v.ok) { const e = new Error(v.errors[0]); e.validation = v; throw e; }
  const doc = v.doc;
  const db = getDb();
  let safety = null;
  if (mode === 'replace') safety = await createBackup({ kind: 'pre-restore' });

  const report = { inserted: {}, skipped: {}, renamed: [], projects: 0, safetyBackup: safety ? safety.fileName : null };
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    await db.tx(async (t) => {
      if (mode === 'replace') {
        for (const table of [...SYNCED_TABLES].reverse()) {
          await t.run(`DELETE FROM ${quoteIdent(table)}`);
          await t.run('DELETE FROM sync_shadow WHERE table_name = ?', [table]);
        }
        await t.run("DELETE FROM sync_queue WHERE status <> 'done'");
        await t.run('DELETE FROM sync_conflicts WHERE resolved_at IS NULL');
      }
      const cols = {};
      for (const table of [...SYNCED_TABLES, ...EXTRA_TABLES]) {
        const rows = doc.tables[table] || [];
        cols[table] = cols[table] || (await t.all(`PRAGMA table_info(${quoteIdent(table)})`)).map((c) => c.name);
        report.inserted[table] = 0;
        report.skipped[table] = 0;
        for (const raw of rows) {
          const exists = await t.get(`SELECT 1 FROM ${quoteIdent(table)} WHERE id = ?`, [raw.id]);
          if (exists) { report.skipped[table] += 1; continue; } // never overwrite
          const row = {};
          for (const c of cols[table]) if (c in raw) row[c] = raw[c];
          if (SYNCED_TABLES.includes(table)) row.sync_state = 'pending';
          const names = Object.keys(row);
          try {
            await t.run(`INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => row[n]));
          } catch (e) {
            if (/UNIQUE/.test(e.message) && (table === 'invoices' || table === 'quotations')) {
              row.number = `${row.number}-R${raw.id.slice(0, 4)}`;
              await t.run(`INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => row[n]));
              report.renamed.push(`${raw.number} → ${row.number}`);
            } else if (/UNIQUE/.test(e.message)) { report.skipped[table] += 1; continue; } else throw e;
          }
          if (SYNCED_TABLES.includes(table)) await enqueue(t, table, raw.id, 'upsert');
          report.inserted[table] += 1;
        }
      }
      if (mode === 'replace') {
        for (const s of doc.settings || []) {
          await t.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [s.key, s.value, clock.now()]);
        }
      }
      const fkBad = await t.all('PRAGMA foreign_key_check');
      if (fkBad.length) throw new Error(`Restore aborted: ${fkBad.length} broken relationship(s) detected`);
      await audit(t, 'backup', null, 'restore', `${mode}: ${Object.values(report.inserted).reduce((a, b) => a + b, 0)} records`);
    });
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }
  // Studio projects: restored as new projects when their database name is unknown.
  for (const p of doc.projects || []) {
    const exists = await db.get('SELECT 1 FROM database_projects WHERE id = ? OR db_name = ?', [p.project.id, p.project.db_name]);
    if (exists && mode !== 'replace') continue;
    if (exists) await studio.deleteProject(p.project.id).catch(() => {});
    const id = await studio.createProject({ name: p.project.name, description: p.project.description });
    await studio.loadProjectDump(id, p.dump);
    for (const l of p.layout || []) await studio.saveTablePosition(id, l.table_name, l.pos_x, l.pos_y);
    report.projects += 1;
  }
  return { ...report, safety };
}

// ---------------------------------------------------------------- exports

export async function exportTableCSV(table) {
  if (![...SYNCED_TABLES].includes(table)) throw new Error('Unknown table');
  const rows = await getDb().all(`SELECT * FROM ${quoteIdent(table)} WHERE deleted_at IS NULL`);
  return toCSV(rows.map(({ sync_state, ...r }) => r));
}

export async function exportStudioTableCSV(projectId, table) {
  const { db } = await studio.projectDb(projectId);
  const rows = await db.all(`SELECT * FROM ${quoteIdent(table)}`);
  const cols = (await db.all(`PRAGMA table_info(${quoteIdent(table)})`)).map((c) => c.name);
  return toCSV(rows, cols);
}

/** Portable SQL script (schema + data) for a Studio project. */
export async function exportProjectSQL(projectId) {
  const dump = await studio.dumpProject(projectId);
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object' && v.$blob) return `X'${[...atob(v.$blob)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const out = ['-- LEDGER X Database Studio export', `-- ${clock.now()}`, 'PRAGMA foreign_keys = OFF;', 'BEGIN;'];
  for (const o of dump.objects.filter((x) => x.type === 'table')) out.push(`${o.sql};`);
  for (const [table, rows] of Object.entries(dump.data)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      out.push(`INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`);
    }
  }
  for (const o of dump.objects.filter((x) => x.type !== 'table')) out.push(`${o.sql};`);
  out.push('COMMIT;', 'PRAGMA foreign_keys = ON;');
  return out.join('\n');
}

/**
 * Import a SQL script into a *new* Studio project. Statements still go
 * through the SQL guard (only supported statement types are executed).
 */
export async function importProjectSQL(name, script) {
  const cleaned = script
    .split('\n')
    .filter((l) => !/^\s*(PRAGMA\s+foreign_keys|BEGIN|COMMIT)\b/i.test(l))
    .join('\n');
  const id = await studio.createProject({ name, description: 'Imported from SQL script' });
  try {
    const r = await studio.executeSQL(id, cleaned, { confirmed: true });
    return { id, statements: r.results.length };
  } catch (e) {
    await studio.deleteProject(id);
    throw e;
  }
}

/** Import CSV text into an existing Studio table (header row = column names). */
export async function importCSVIntoTable(projectId, table, csvText) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const [header, ...data] = rows;
  let n = 0;
  for (const r of data) {
    if (r.length === 1 && r[0] === '') continue;
    const obj = {};
    header.forEach((h, i) => { obj[h.trim()] = r[i] ?? null; });
    await studio.insertRow(projectId, table, obj);
    n += 1;
  }
  return n;
}

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
