/**
 * Database Studio: user-created SQLite databases ("projects").
 *
 * Each project is a separate SQLite file, so user experiments can never
 * corrupt LEDGER X business data. The business database itself is exposed
 * as a read-only pseudo-project for exploration and reporting.
 *
 * DDL is generated from validated specs with quoted identifiers; values are
 * always bound as parameters.
 */
import { getDb, MAIN_DB } from './database.js';
import { openDatabase, deleteDatabaseFile, quoteIdent } from '../storage/sqlite.js';
import { uuid, clock } from '../storage/syncQueue.js';
import { analyzeScript } from './sqlGuard.js';
import { ValidationError } from '../utils/validation.js';

export const BUSINESS_PROJECT_ID = '__business__';
export const COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'BLOB', 'JSON'];
const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
const MAX_RESULT_ROWS = 1000;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_ ]{0,62}$/;
export function validIdent(name, label = 'Name') {
  const n = String(name || '').trim();
  if (!IDENT_RE.test(n)) throw new ValidationError({ name: `${label} must start with a letter or _ and contain only letters, digits, _ or spaces (max 63)` });
  if (/^sqlite_/i.test(n)) throw new ValidationError({ name: `${label} cannot start with sqlite_` });
  return n;
}

// ---------------------------------------------------------------- projects

export async function listProjects() {
  const rows = await getDb().all('SELECT * FROM database_projects ORDER BY updated_at DESC');
  const out = [];
  for (const p of rows) {
    try {
      const db = await openDatabase(p.db_name);
      const stats = await dbStats(db);
      out.push({ ...p, ...stats, readOnly: false });
    } catch (e) {
      out.push({ ...p, tableCount: 0, records: 0, sizeBytes: 0, error: String(e.message || e) });
    }
  }
  return out;
}

export async function businessProject() {
  const db = getDb();
  const stats = await dbStats(db);
  return { id: BUSINESS_PROJECT_ID, name: 'LEDGER X business data', db_name: MAIN_DB, description: 'Invoices, customers, products and settings. Read-only in Studio.', readOnly: true, ...stats };
}

async function dbStats(db) {
  const tables = await userTables(db);
  let records = 0;
  for (const t of tables) records += Number((await db.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`)).n);
  return { tableCount: tables.length, records, sizeBytes: await db.sizeBytes() };
}

export async function getProject(id) {
  if (id === BUSINESS_PROJECT_ID) return businessProject();
  return getDb().get('SELECT * FROM database_projects WHERE id = ?', [id]);
}

export async function createProject({ name, description }) {
  const n = String(name || '').trim();
  if (!n || n.length > 80) throw new ValidationError({ name: 'Project name is required (max 80 characters)' });
  const id = uuid();
  const db_name = `ledgerx_proj_${id.replace(/-/g, '').slice(0, 16)}`;
  await openDatabase(db_name); // creates the file
  const now = clock.now();
  await getDb().run(
    'INSERT INTO database_projects (id, name, db_name, description, created_at, updated_at, last_modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, n, db_name, description?.trim() || null, now, now, now]);
  return id;
}

export async function renameProject(id, name, description) {
  const n = String(name || '').trim();
  if (!n) throw new ValidationError({ name: 'Project name is required' });
  await getDb().run('UPDATE database_projects SET name = ?, description = ?, updated_at = ? WHERE id = ?', [n, description ?? null, clock.now(), id]);
}

export async function deleteProject(id) {
  const p = await getProject(id);
  if (!p || id === BUSINESS_PROJECT_ID) throw new Error('Project not found');
  await deleteDatabaseFile(p.db_name);
  await getDb().run('DELETE FROM database_projects WHERE id = ?', [id]);
}

export async function projectDb(id) {
  if (id === BUSINESS_PROJECT_ID) return { db: getDb(), readOnly: true };
  const p = await getDb().get('SELECT * FROM database_projects WHERE id = ?', [id]);
  if (!p) throw new Error('Project not found');
  return { db: await openDatabase(p.db_name), readOnly: false, project: p };
}

async function touch(id) {
  if (id === BUSINESS_PROJECT_ID) return;
  const now = clock.now();
  await getDb().run('UPDATE database_projects SET last_modified_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
}

// ---------------------------------------------------------------- schema introspection

async function userTables(db) {
  return db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
}

export async function introspect(projectId) {
  const { db, readOnly } = await projectDb(projectId);
  const tables = [];
  for (const { name, sql } of await userTables(db)) {
    const q = quoteIdent(name);
    const cols = await db.all(`PRAGMA table_info(${q})`);
    const fks = await db.all(`PRAGMA foreign_key_list(${q})`);
    const idxList = await db.all(`PRAGMA index_list(${q})`);
    const indexes = [];
    for (const ix of idxList) {
      const info = await db.all(`PRAGMA index_info(${quoteIdent(ix.name)})`);
      indexes.push({ name: ix.name, unique: !!ix.unique, origin: ix.origin, partial: !!ix.partial, columns: info.map((i) => i.name) });
    }
    const uniqueCols = new Set(indexes.filter((i) => i.unique && i.columns.length === 1 && i.origin !== 'pk').map((i) => i.columns[0]));
    const count = Number((await db.get(`SELECT COUNT(*) AS n FROM ${q}`)).n);
    tables.push({
      name,
      sql,
      withoutRowid: /without\s+rowid/i.test(sql || ''),
      rowCount: count,
      columns: cols.map((c) => ({
        name: c.name, type: (c.type || '').toUpperCase(), notNull: !!c.notnull, default: c.dflt_value, pk: Number(c.pk),
        unique: uniqueCols.has(c.name),
        fk: fks.find((f) => f.from === c.name) ? (({ table, to, on_delete, on_update }) => ({ table, column: to, onDelete: on_delete, onUpdate: on_update }))(fks.find((f) => f.from === c.name)) : null,
      })),
      foreignKeys: fks.map((f) => ({ from: f.from, table: f.table, to: f.to, onDelete: f.on_delete })),
      indexes,
    });
  }
  let layout = [];
  if (projectId !== BUSINESS_PROJECT_ID) {
    layout = await getDb().all('SELECT table_name, pos_x, pos_y, note FROM database_tables WHERE project_id = ?', [projectId]);
  } else {
    const saved = await getDb().get("SELECT value FROM app_settings WHERE key = 'studio.business_layout'");
    layout = saved ? JSON.parse(saved.value) : [];
  }
  return { tables, layout, readOnly };
}

// ---------------------------------------------------------------- DDL builders

function literalDefault(v, type) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|TRUE|FALSE)$/i.test(s)) return s.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(s) && ['INTEGER', 'REAL', 'NUMERIC', 'BOOLEAN'].includes(type)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export function columnDef(col, { includeConstraints = true } = {}) {
  const name = validIdent(col.name, 'Column name');
  const type = String(col.type || 'TEXT').toUpperCase();
  if (!COLUMN_TYPES.includes(type)) throw new ValidationError({ type: `Unsupported type ${type}` });
  const parts = [quoteIdent(name), type];
  if (includeConstraints && col.pk && col.pkInline) parts.push(type === 'INTEGER' && col.autoincrement ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY');
  if (col.notNull) parts.push('NOT NULL');
  if (includeConstraints && col.unique && !col.pk) parts.push('UNIQUE');
  const d = literalDefault(col.default, type);
  if (d !== null) parts.push(`DEFAULT ${d}`);
  if (type === 'BOOLEAN') parts.push(`CHECK (${quoteIdent(name)} IN (0, 1) OR ${quoteIdent(name)} IS NULL)`);
  if (type === 'JSON') parts.push(`CHECK (${quoteIdent(name)} IS NULL OR json_valid(${quoteIdent(name)}))`);
  if (col.fk && col.fk.table) {
    const act = FK_ACTIONS.includes(col.fk.onDelete) ? col.fk.onDelete : 'NO ACTION';
    parts.push(`REFERENCES ${quoteIdent(col.fk.table)}(${quoteIdent(col.fk.column || 'id')}) ON DELETE ${act}`);
  }
  return parts.join(' ');
}

export function createTableSQL(name, columns) {
  const tname = validIdent(name, 'Table name');
  if (!Array.isArray(columns) || !columns.length) throw new ValidationError({ columns: 'Add at least one column' });
  const seen = new Set();
  for (const c of columns) {
    const k = String(c.name).trim().toLowerCase();
    if (seen.has(k)) throw new ValidationError({ columns: `Duplicate column ${c.name}` });
    seen.add(k);
  }
  const pks = columns.filter((c) => c.pk);
  const single = pks.length === 1;
  const defs = columns.map((c) => columnDef({ ...c, pkInline: single && c.pk }));
  if (pks.length > 1) defs.push(`PRIMARY KEY (${pks.map((c) => quoteIdent(c.name.trim())).join(', ')})`);
  return `CREATE TABLE ${quoteIdent(tname)} (\n  ${defs.join(',\n  ')}\n)`;
}

export async function createTable(projectId, { name, columns }) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  const sql = createTableSQL(name, columns);
  await db.tx(async (t) => {
    await t.exec(sql);
  });
  await touch(projectId);
  return sql;
}

export async function renameTable(projectId, from, to) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  const n = validIdent(to, 'Table name');
  await db.tx((t) => t.exec(`ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(n)}`));
  await getDb().run('UPDATE database_tables SET table_name = ? WHERE project_id = ? AND table_name = ?', [n, projectId, from]);
  await touch(projectId);
}

export async function dropTable(projectId, name) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  await db.tx((t) => t.exec(`DROP TABLE ${quoteIdent(name)}`));
  await getDb().run('DELETE FROM database_tables WHERE project_id = ? AND table_name = ?', [projectId, name]);
  await touch(projectId);
}

export async function addColumn(projectId, table, col) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  if (col.pk) throw new ValidationError({ pk: 'A primary key cannot be added to an existing table — use Edit column instead' });
  if (col.notNull && (col.default === undefined || col.default === null || col.default === '')) {
    const count = Number((await db.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`)).n);
    if (count > 0) throw new ValidationError({ default: 'NOT NULL columns need a default value when the table has rows' });
  }
  await db.tx(async (t) => {
    await t.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnDef({ ...col, unique: false })}`);
    if (col.unique) await t.exec(`CREATE UNIQUE INDEX ${quoteIdent(`ux_${table}_${col.name}`)} ON ${quoteIdent(table)}(${quoteIdent(col.name)})`);
  });
  await touch(projectId);
}

/** Drop a column when SQLite can do so safely; explains why otherwise. */
export async function dropColumn(projectId, table, column) {
  const { tables } = await introspect(projectId);
  const t = tables.find((x) => x.name === table);
  const col = t?.columns.find((c) => c.name === column);
  if (!col) throw new Error('Column not found');
  if (col.pk) throw new Error('Primary key columns cannot be dropped');
  if (t.columns.length === 1) throw new Error('A table must keep at least one column');
  const referencing = tables.filter((o) => o.foreignKeys.some((f) => f.table === table && f.to === column));
  if (referencing.length) throw new Error(`Referenced by foreign keys in: ${referencing.map((r) => r.name).join(', ')}`);
  // Indexes on the column must go first (SQLite refuses otherwise).
  return rebuildTable(projectId, table, t.columns.filter((c) => c.name !== column).map(toSpec), { dropIndexesOn: [column] });
}

const toSpec = (c) => ({ name: c.name, originalName: c.name, type: COLUMN_TYPES.includes(c.type) ? c.type : 'TEXT', notNull: c.notNull, unique: c.unique, default: c.default?.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'") ?? null, pk: !!c.pk, fk: c.fk ? { table: c.fk.table, column: c.fk.column, onDelete: c.fk.onDelete } : null });

/**
 * Rebuild a table with a new column specification (SQLite's documented
 * 12-step procedure). Used to edit column definitions, primary keys and
 * foreign keys. Data is copied for columns that keep an `originalName`.
 */
export async function rebuildTable(projectId, table, specs, { dropIndexesOn = [] } = {}) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  const tmp = `__lx_rebuild_${Date.now()}`;
  const createSql = createTableSQL(tmp, specs);
  const keepIdx = (await db.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", [table]));
  const copyCols = specs.filter((s) => s.originalName);
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    await db.tx(async (t) => {
      await t.exec(createSql);
      if (copyCols.length) {
        await t.exec(`INSERT INTO ${quoteIdent(tmp)} (${copyCols.map((c) => quoteIdent(c.name)).join(', ')})
          SELECT ${copyCols.map((c) => quoteIdent(c.originalName)).join(', ')} FROM ${quoteIdent(table)}`);
      }
      await t.exec(`DROP TABLE ${quoteIdent(table)}`);
      await t.exec(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`);
      const renamed = new Map(copyCols.map((c) => [c.originalName, c.name]));
      for (const ix of keepIdx) {
        const cols = (await t.all(`SELECT name FROM pragma_index_info(?)`, [ix.name])).map((r) => r.name);
        if (cols.some((c) => dropIndexesOn.includes(c) || !renamed.has(c))) continue;
        let sql = ix.sql;
        for (const [from, to] of renamed) if (from !== to) sql = sql.split(quoteIdent(from)).join(quoteIdent(to));
        try { await t.exec(sql); } catch { /* index no longer valid — skipped */ }
      }
      const bad = await t.all('PRAGMA foreign_key_check');
      if (bad.length) throw new Error(`Change would break ${bad.length} foreign key reference(s)`);
    });
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }
  await touch(projectId);
}

/** Edit a column: change name/type/constraints/foreign key via rebuild. */
export async function editColumn(projectId, table, columnName, next) {
  const { tables } = await introspect(projectId);
  const t = tables.find((x) => x.name === table);
  if (!t) throw new Error('Table not found');
  const specs = t.columns.map(toSpec).map((s) => (s.name === columnName ? { ...s, ...next, originalName: columnName } : s));
  return rebuildTable(projectId, table, specs);
}

export async function createIndex(projectId, table, { name, columns, unique }) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  if (!columns?.length) throw new ValidationError({ columns: 'Choose at least one column' });
  const n = validIdent(name || `ix_${table}_${columns.join('_')}`, 'Index name');
  await db.tx((t) => t.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(n)} ON ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')})`));
  await touch(projectId);
}

export async function dropIndex(projectId, name) {
  const { db, readOnly } = await projectDb(projectId);
  if (readOnly) throw new Error('This database is read-only');
  await db.tx((t) => t.exec(`DROP INDEX ${quoteIdent(name)}`));
  await touch(projectId);
}

// ---------------------------------------------------------------- data grid

export function coerceValue(raw, type, notNull) {
  if (raw === null || raw === undefined || raw === '') {
    if (notNull && raw !== '') return null; // let SQLite enforce
    return raw === '' && type === 'TEXT' ? '' : null;
  }
  const s = String(raw);
  switch (type) {
    case 'INTEGER': if (!/^-?\d+$/.test(s.trim())) throw new ValidationError({ value: `"${s}" is not an integer` }); return Number(s);
    case 'REAL': case 'NUMERIC': if (Number.isNaN(Number(s))) throw new ValidationError({ value: `"${s}" is not a number` }); return Number(s);
    case 'BOOLEAN': return ['1', 'true', 'yes', 'on'].includes(s.toLowerCase()) ? 1 : 0;
    case 'JSON': try { JSON.parse(s); return s; } catch { throw new ValidationError({ value: 'Invalid JSON' }); }
    case 'DATE': if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError({ value: 'Use YYYY-MM-DD' }); return s;
    case 'DATETIME': if (Number.isNaN(Date.parse(s))) throw new ValidationError({ value: 'Invalid date/time' }); return s;
    default: return s;
  }
}

export async function queryRows(projectId, table, { search = '', filters = [], sort = null, dir = 'asc', page = 1, pageSize = 50 } = {}) {
  const { db } = await projectDb(projectId);
  const cols = await db.all(`PRAGMA table_info(${quoteIdent(table)})`);
  if (!cols.length) throw new Error('Table not found');
  const where = [];
  const p = [];
  if (search) {
    where.push(`(${cols.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < cols.length; i++) p.push(`%${search}%`);
  }
  const OPS = { eq: '= ?', ne: '<> ?', gt: '> ?', lt: '< ?', gte: '>= ?', lte: '<= ?', like: 'LIKE ?', null: 'IS NULL', notnull: 'IS NOT NULL' };
  for (const f of filters) {
    if (!cols.some((c) => c.name === f.column) || !OPS[f.op]) continue;
    where.push(`${quoteIdent(f.column)} ${OPS[f.op]}`);
    if (!['null', 'notnull'].includes(f.op)) p.push(f.op === 'like' ? `%${f.value}%` : f.value);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} ${w}`, p)).n);
  const order = sort && cols.some((c) => c.name === sort) ? `ORDER BY ${quoteIdent(sort)} ${dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY rowid';
  const size = Math.min(Math.max(pageSize, 1), 500);
  const offset = (Math.max(page, 1) - 1) * size;
  const master = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", [table]);
  const withoutRowid = /without\s+rowid/i.test(master?.sql || '');
  const select = withoutRowid ? '*' : 'rowid AS __rowid, *';
  const rows = await db.all(`SELECT ${select} FROM ${quoteIdent(table)} ${w} ${withoutRowid ? '' : order} LIMIT ? OFFSET ?`, [...p, size, offset]);
  return { columns: cols.map((c) => ({ name: c.name, type: (c.type || '').toUpperCase(), notNull: !!c.notnull, pk: c.pk, default: c.dflt_value })), rows, total, page, pageSize: size, editable: !withoutRowid };
}

async function writable(projectId) {
  const r = await projectDb(projectId);
  if (r.readOnly) throw new Error('This database is read-only in Studio');
  return r.db;
}

export async function insertRow(projectId, table, values) {
  const db = await writable(projectId);
  const cols = await db.all(`PRAGMA table_info(${quoteIdent(table)})`);
  const names = [];
  const vals = [];
  for (const c of cols) {
    if (!(c.name in values)) continue;
    const v = values[c.name];
    if ((v === '' || v === null) && (c.pk || c.dflt_value !== null)) continue; // let defaults / rowid apply
    names.push(c.name);
    vals.push(coerceValue(v, (c.type || '').toUpperCase(), !!c.notnull));
  }
  const sql = names.length
    ? `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    : `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`;
  const r = await db.tx((t) => t.run(sql, vals));
  await touch(projectId);
  return r.lastId;
}

export async function updateRow(projectId, table, rowid, values) {
  const db = await writable(projectId);
  const cols = await db.all(`PRAGMA table_info(${quoteIdent(table)})`);
  const sets = [];
  const vals = [];
  for (const c of cols) {
    if (!(c.name in values)) continue;
    sets.push(`${quoteIdent(c.name)} = ?`);
    vals.push(coerceValue(values[c.name], (c.type || '').toUpperCase(), !!c.notnull));
  }
  if (!sets.length) return 0;
  const r = await db.tx((t) => t.run(`UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} WHERE rowid = ?`, [...vals, rowid]));
  await touch(projectId);
  return r.changes;
}

export async function deleteRows(projectId, table, rowids) {
  const db = await writable(projectId);
  const r = await db.tx(async (t) => {
    let n = 0;
    for (const id of rowids) n += (await t.run(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`, [id])).changes;
    return n;
  });
  await touch(projectId);
  return r;
}

export async function saveTablePosition(projectId, table, x, y) {
  if (projectId === BUSINESS_PROJECT_ID) {
    const row = await getDb().get("SELECT value FROM app_settings WHERE key = 'studio.business_layout'");
    const layout = row ? JSON.parse(row.value) : [];
    const i = layout.findIndex((l) => l.table_name === table);
    const entry = { table_name: table, pos_x: x, pos_y: y };
    if (i >= 0) layout[i] = entry; else layout.push(entry);
    await getDb().run("INSERT INTO app_settings (key, value, updated_at) VALUES ('studio.business_layout', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [JSON.stringify(layout), clock.now()]);
    return;
  }
  await getDb().run(
    `INSERT INTO database_tables (id, project_id, table_name, pos_x, pos_y, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, table_name) DO UPDATE SET pos_x = excluded.pos_x, pos_y = excluded.pos_y, updated_at = excluded.updated_at`,
    [uuid(), projectId, table, x, y, clock.now()]);
}

export async function clearLayout(projectId) {
  if (projectId === BUSINESS_PROJECT_ID) await getDb().run("DELETE FROM app_settings WHERE key = 'studio.business_layout'");
  else await getDb().run('DELETE FROM database_tables WHERE project_id = ?', [projectId]);
}

// ---------------------------------------------------------------- SQL editor

/**
 * Execute a script against the selected project database only.
 * Returns { needsConfirmation, analysis } when destructive statements are
 * present and `confirmed` is false.
 */
export async function executeSQL(projectId, sql, { confirmed = false } = {}) {
  const { db, readOnly } = await projectDb(projectId);
  const analysis = analyzeScript(sql, { readOnly });
  if (analysis.empty) throw new Error('Nothing to execute');
  if (analysis.blocked.length) {
    const err = new Error(analysis.blocked[0].blocked);
    err.analysis = analysis;
    await logHistory(projectId, sql, 0, 0, err.message);
    throw err;
  }
  if (analysis.destructive && !confirmed) return { needsConfirmation: true, analysis };

  const started = performance.now();
  const results = [];
  const runAll = async (t) => {
    for (const st of analysis.statements) {
      const returnsRows = ['SELECT', 'EXPLAIN', 'PRAGMA'].includes(st.type) || /\bRETURNING\b/i.test(st.sql);
      if (returnsRows) {
        const q = st.type === 'SELECT' && !/\bRETURNING\b/i.test(st.sql) ? `SELECT * FROM (${st.sql}) LIMIT ${MAX_RESULT_ROWS + 1}` : st.sql;
        let rows = await t.all(q);
        const truncated = rows.length > MAX_RESULT_ROWS;
        if (truncated) rows = rows.slice(0, MAX_RESULT_ROWS);
        results.push({ type: st.type, rows, columns: rows[0] ? Object.keys(rows[0]) : [], truncated });
      } else {
        const r = await t.run(st.sql);
        results.push({ type: st.type, changes: r.changes, lastId: r.lastId });
      }
    }
  };
  try {
    if (readOnly) {
      // Defence in depth: SQLite itself refuses writes while query_only is on.
      await db.exclusive(async (t) => {
        await t.exec('PRAGMA query_only = ON');
        try { await runAll(t); } finally { await t.exec('PRAGMA query_only = OFF'); }
      });
    } else {
      await db.tx(runAll);
    }
  } catch (e) {
    const ms = performance.now() - started;
    await logHistory(projectId, sql, ms, 0, String(e.message || e));
    throw e;
  }
  const ms = performance.now() - started;
  const rowCount = results.reduce((a, r) => a + (r.rows ? r.rows.length : r.changes || 0), 0);
  await logHistory(projectId, sql, ms, rowCount, null);
  if (analysis.statements.some((s) => !['SELECT', 'EXPLAIN', 'PRAGMA'].includes(s.type))) await touch(projectId);
  return { results, durationMs: ms, analysis };
}

async function logHistory(projectId, sql, ms, rows, error) {
  await getDb().run('INSERT INTO query_history (project_id, sql, duration_ms, row_count, error, executed_at) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, sql.slice(0, 20000), ms, rows, error, clock.now()]);
  await getDb().run('DELETE FROM query_history WHERE id IN (SELECT id FROM query_history WHERE project_id = ? ORDER BY id DESC LIMIT -1 OFFSET 200)', [projectId]);
}

export async function queryHistory(projectId, limit = 50) {
  return getDb().all('SELECT * FROM query_history WHERE project_id = ? ORDER BY id DESC LIMIT ?', [projectId, limit]);
}

export async function savedQueries(projectId) {
  return getDb().all('SELECT * FROM saved_queries WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC', [projectId]);
}

export async function saveQuery(projectId, title, sql, id = null) {
  const now = clock.now();
  if (!String(title || '').trim()) throw new ValidationError({ title: 'Give the query a name' });
  if (id) { await getDb().run('UPDATE saved_queries SET title = ?, sql = ?, updated_at = ? WHERE id = ?', [title.trim(), sql, now, id]); return id; }
  const nid = uuid();
  await getDb().run('INSERT INTO saved_queries (id, project_id, title, sql, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', [nid, projectId, title.trim(), sql, now, now]);
  return nid;
}

export async function deleteSavedQuery(id) { await getDb().run('DELETE FROM saved_queries WHERE id = ?', [id]); }

// ---------------------------------------------------------------- export helpers

export async function dumpProject(projectId) {
  const { db } = await projectDb(projectId);
  const objects = await db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name");
  const data = {};
  for (const o of objects.filter((x) => x.type === 'table')) {
    const rows = await db.all(`SELECT * FROM ${quoteIdent(o.name)}`);
    data[o.name] = rows.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[k] = v instanceof Uint8Array ? { $blob: btoaBytes(v) } : v;
      return out;
    });
  }
  return { objects, data };
}

function btoaBytes(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return (globalThis.btoa ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
}

/** Recreate a project from a dump (used by backup restore / import). */
export async function loadProjectDump(projectId, dump) {
  const { db } = await projectDb(projectId);
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    await db.tx(async (t) => {
      for (const o of dump.objects.filter((x) => x.type === 'table')) await t.exec(o.sql);
      for (const [table, rows] of Object.entries(dump.data)) {
        for (const r of rows) {
          const cols = Object.keys(r);
          if (!cols.length) continue;
          const vals = cols.map((c) => (r[c] && typeof r[c] === 'object' && r[c].$blob ? Uint8Array.from(atob(r[c].$blob), (ch) => ch.charCodeAt(0)) : r[c]));
          await t.run(`INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
        }
      }
      for (const o of dump.objects.filter((x) => x.type !== 'table')) await t.exec(o.sql);
    });
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }
}
