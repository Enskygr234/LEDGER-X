import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp } from './helpers.mjs';
import { getDb } from '../src/services/database.js';
import { analyzeScript, analyzeStatement } from '../src/services/sqlGuard.js';
import * as studio from '../src/services/studioService.js';
import { splitStatements } from '../src/utils/sqlTokenizer.js';
import { formatSQL } from '../src/utils/sqlFormat.js';

before(async () => { await freshApp(); });

test('statement splitting respects strings, comments and parentheses', () => {
  const s = splitStatements("SELECT 'a;b'; -- c;\nINSERT INTO t VALUES (';'); /* ; */ ;  ");
  assert.equal(s.length, 2);
  assert.equal(s[1], "-- c;\nINSERT INTO t VALUES (';')");
});

test('guard: supported types and destructive detection', () => {
  assert.equal(analyzeStatement('select * from a').type, 'SELECT');
  assert.equal(analyzeStatement('WITH x AS (SELECT 1) SELECT * FROM x').type, 'SELECT');
  const cteDelete = analyzeStatement('WITH x AS (SELECT 1) DELETE FROM a WHERE id IN x');
  assert.equal(cteDelete.type, 'DELETE');
  assert.ok(cteDelete.destructive);
  assert.ok(analyzeStatement('DROP TABLE a').destructive);
  assert.ok(analyzeStatement('ALTER TABLE a DROP COLUMN b').destructive);
  assert.ok(!analyzeStatement('ALTER TABLE a ADD COLUMN b TEXT').destructive);
  assert.ok(analyzeStatement('UPDATE a SET b = 1').warnings[0].includes('no WHERE'));
  assert.ok(analyzeStatement('INSERT OR REPLACE INTO a VALUES (1)').destructive);
  assert.equal(analyzeStatement('CREATE UNIQUE INDEX i ON a(b)').type, 'CREATE INDEX');
});

test('guard: escape hatches are blocked', () => {
  for (const sql of [
    "ATTACH DATABASE '/data/x.db' AS x",
    'DETACH x',
    'PRAGMA foreign_keys = OFF',
    'PRAGMA writable_schema',
    "SELECT load_extension('/tmp/evil.so')",
    'BEGIN', 'COMMIT', 'VACUUM',
    "INSERT INTO sqlite_master VALUES ('table','x','x',0,'')",
    'SELECT * FROM other.customers',
    'CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM a; END',
  ]) {
    assert.ok(analyzeStatement(sql).blocked, `should block: ${sql}`);
  }
  assert.ok(!analyzeStatement('PRAGMA table_info(a)').blocked);
  // Aliases and qualified columns are not cross-database references.
  assert.ok(!analyzeStatement('SELECT s.name FROM suppliers s LEFT JOIN parts p ON p.supplier_id = s.id').blocked);
  assert.ok(!analyzeStatement('SELECT * FROM main.parts').blocked);
});

test('guard: business database is read-only', () => {
  const r = analyzeScript('SELECT * FROM invoices; DELETE FROM invoices', { readOnly: true });
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0].blocked, /read-only/);
});

let pid;
test('project databases are separate files with real tables, FKs, indexes', async () => {
  pid = await studio.createProject({ name: 'Inventory' });
  await studio.createTable(pid, { name: 'suppliers', columns: [
    { name: 'id', type: 'INTEGER', pk: true, autoincrement: true },
    { name: 'name', type: 'TEXT', notNull: true, unique: true },
    { name: 'active', type: 'BOOLEAN', default: '1' },
  ] });
  await studio.createTable(pid, { name: 'parts', columns: [
    { name: 'id', type: 'INTEGER', pk: true },
    { name: 'supplier_id', type: 'INTEGER', fk: { table: 'suppliers', column: 'id', onDelete: 'CASCADE' } },
    { name: 'label', type: 'TEXT' },
    { name: 'meta', type: 'JSON' },
    { name: 'added', type: 'DATE' },
  ] });
  const { tables } = await studio.introspect(pid);
  const parts = tables.find((t) => t.name === 'parts');
  assert.deepEqual(parts.foreignKeys, [{ from: 'supplier_id', table: 'suppliers', to: 'id', onDelete: 'CASCADE' }]);
  assert.ok(tables.find((t) => t.name === 'suppliers').columns.find((c) => c.name === 'name').unique);
  // Business DB untouched
  assert.equal(await getDb().get("SELECT 1 FROM sqlite_master WHERE name = 'parts'"), undefined);
  // Hostile identifiers are quoted, not executed
  await studio.createTable(pid, { name: 'weird name', columns: [{ name: 'x', type: 'TEXT' }] });
  await assert.rejects(studio.createTable(pid, { name: 'x"; DROP TABLE parts; --', columns: [{ name: 'a', type: 'TEXT' }] }), /must start with a letter/);
});

test('data grid: typed insert/update/delete, search, sort, paginate', async () => {
  const s1 = await studio.insertRow(pid, 'suppliers', { name: 'Bolt Bros' });
  await studio.insertRow(pid, 'suppliers', { name: 'Nuts Inc', active: 'false' });
  await assert.rejects(studio.insertRow(pid, 'suppliers', { name: 'Bolt Bros' }), /UNIQUE/);
  for (let i = 0; i < 60; i++) await studio.insertRow(pid, 'parts', { supplier_id: s1, label: `Part ${i}`, meta: '{"w":1}', added: '2026-01-02' });
  await assert.rejects(studio.insertRow(pid, 'parts', { label: 'bad', meta: '{nope' }), /Invalid JSON/);
  await assert.rejects(studio.insertRow(pid, 'parts', { supplier_id: 999, label: 'orphan' }), /FOREIGN KEY/);
  const page2 = await studio.queryRows(pid, 'parts', { page: 2, pageSize: 25, sort: 'id', dir: 'desc' });
  assert.equal(page2.total, 60);
  assert.equal(page2.rows.length, 25);
  const found = await studio.queryRows(pid, 'parts', { search: 'Part 4' });
  assert.equal(found.total, 11); // Part 4, 40..49
  const filtered = await studio.queryRows(pid, 'suppliers', { filters: [{ column: 'active', op: 'eq', value: 0 }] });
  assert.equal(filtered.rows[0].name, 'Nuts Inc');
  await studio.updateRow(pid, 'suppliers', filtered.rows[0].__rowid, { name: 'Nuts International' });
  await studio.deleteRows(pid, 'suppliers', [s1]); // cascades to parts
  assert.equal((await studio.queryRows(pid, 'parts')).total, 0);
});

test('schema editing: add/edit/drop columns, rename, indexes', async () => {
  await studio.addColumn(pid, 'suppliers', { name: 'email', type: 'TEXT', unique: true });
  await assert.rejects(studio.addColumn(pid, 'suppliers', { name: 'req', type: 'TEXT', notNull: true }), /default value/);
  await studio.editColumn(pid, 'suppliers', 'email', { name: 'contact_email', notNull: false });
  let t = (await studio.introspect(pid)).tables.find((x) => x.name === 'suppliers');
  assert.ok(t.columns.find((c) => c.name === 'contact_email'));
  assert.equal((await studio.queryRows(pid, 'suppliers')).rows[0].name, 'Nuts International', 'data survives rebuild');
  await studio.createIndex(pid, 'parts', { columns: ['label'] });
  await assert.rejects(studio.dropColumn(pid, 'suppliers', 'id'), /Primary key/);
  await assert.rejects(studio.dropColumn(pid, 'suppliers', 'id'), /Primary key/);
  await studio.dropColumn(pid, 'parts', 'label');
  t = (await studio.introspect(pid)).tables.find((x) => x.name === 'parts');
  assert.ok(!t.columns.find((c) => c.name === 'label'));
  assert.equal(t.foreignKeys.length, 1, 'foreign key preserved through rebuild');
  await studio.renameTable(pid, 'weird name', 'notes');
  assert.ok((await studio.introspect(pid)).tables.find((x) => x.name === 'notes'));
});

test('SQL editor: executes, confirms destructive, logs history, restricts scope', async () => {
  const r = await studio.executeSQL(pid, "INSERT INTO suppliers (name) VALUES ('Gears Co'); SELECT name FROM suppliers ORDER BY name");
  assert.equal(r.results[0].changes, 1);
  assert.deepEqual(r.results[1].rows.map((x) => x.name), ['Gears Co', 'Nuts International']);
  const pending = await studio.executeSQL(pid, 'DELETE FROM suppliers');
  assert.equal(pending.needsConfirmation, true);
  assert.equal((await studio.queryRows(pid, 'suppliers')).total, 2, 'nothing deleted before confirmation');
  await studio.executeSQL(pid, "DELETE FROM suppliers WHERE name = 'Gears Co'", { confirmed: true });
  assert.equal((await studio.queryRows(pid, 'suppliers')).total, 1);
  await assert.rejects(studio.executeSQL(pid, "ATTACH 'x' AS y"), /restricted to the selected database/);
  // Failed statements roll back the whole script
  await assert.rejects(studio.executeSQL(pid, "INSERT INTO suppliers (name) VALUES ('Tmp'); INSERT INTO nope VALUES (1)"));
  assert.equal((await studio.queryRows(pid, 'suppliers')).total, 1);
  const hist = await studio.queryHistory(pid);
  assert.ok(hist.length >= 4);
  assert.ok(hist.some((h) => h.error));
});

test('SQL editor on business data is read-only even if the guard were bypassed', async () => {
  const r = await studio.executeSQL(studio.BUSINESS_PROJECT_ID, 'SELECT COUNT(*) AS n FROM business_profiles');
  assert.equal(r.results[0].rows[0].n, 1);
  await assert.rejects(studio.executeSQL(studio.BUSINESS_PROJECT_ID, 'DELETE FROM customers'), /read-only/);
  // Defence-in-depth check: query_only blocks writes at the SQLite level.
  await assert.rejects(getDb().exclusive(async (t) => {
    await t.exec('PRAGMA query_only = ON');
    try { await t.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('x','y','z')"); } finally { await t.exec('PRAGMA query_only = OFF'); }
  }), /readonly|read-only|attempt to write/i);
  await getDb().run("INSERT INTO app_settings (key, value, updated_at) VALUES ('ok','1','z')"); // writes work again
});

test('formatter produces readable SQL', () => {
  const out = formatSQL("select a,b from t where x=1 and y='q' order by a limit 5");
  assert.equal(out, "SELECT a, b\nFROM t\nWHERE x = 1\n  AND y = 'q'\nORDER BY a\nLIMIT 5");
});

test('dump and reload a project', async () => {
  const dump = await studio.dumpProject(pid);
  const copy = await studio.createProject({ name: 'Copy' });
  await studio.loadProjectDump(copy, dump);
  const a = await studio.introspect(pid);
  const b = await studio.introspect(copy);
  assert.deepEqual(b.tables.map((t) => [t.name, t.rowCount]), a.tables.map((t) => [t.name, t.rowCount]));
  await studio.deleteProject(copy);
  assert.equal((await studio.listProjects()).length, 1);
});
