/**
 * SQL guard for the Database Studio SQL editor.
 *
 * Every statement the user types is parsed and classified before execution:
 *  - only the supported statement types may run;
 *  - statements that can destroy data are flagged and need confirmation;
 *  - escape hatches (ATTACH, PRAGMA writes, load_extension, VACUUM INTO,
 *    writes to sqlite_* tables, transaction control) are always blocked;
 *  - in read-only mode (the LEDGER X business database) only SELECT/EXPLAIN
 *    is allowed — and execution additionally runs with PRAGMA query_only=ON.
 */
import { tokenize, splitStatements, significant, unquoteIdent } from '../utils/sqlTokenizer.js';

export const SUPPORTED = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE', 'ALTER TABLE', 'CREATE INDEX', 'DROP TABLE', 'DROP INDEX', 'CREATE VIEW', 'DROP VIEW', 'EXPLAIN'];
const READONLY_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'page_count', 'page_size']);
const BANNED_FUNCTIONS = new Set(['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer']);

function kw(t) { return t && (t.type === 'keyword' || t.type === 'ident') ? t.value.toUpperCase() : null; }

/** Find the main verb of a statement (skipping a leading WITH … AS (…) list). */
function mainVerb(tokens) {
  const sig = significant(tokens);
  if (!sig.length) return { verb: null, index: -1 };
  if (kw(sig[0]) !== 'WITH') return { verb: kw(sig[0]), index: 0 };
  for (let i = 1; i < sig.length; i++) {
    const w = kw(sig[i]);
    if (sig[i].depth === 0 && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES'].includes(w)) return { verb: w, index: i };
  }
  return { verb: 'WITH', index: 0 };
}

function referencedTables(sig) {
  const names = new Set();
  for (let i = 0; i < sig.length - 1; i++) {
    const w = kw(sig[i]);
    if (['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'REFERENCES'].includes(w) && sig[i + 1]) {
      const nx = sig[i + 1];
      if (nx.type === 'ident' || nx.type === 'qident') {
        // schema-qualified: name . name
        if (sig[i + 2]?.value === '.' && sig[i + 3]) names.add(`${unquoteIdent(nx.value)}.${unquoteIdent(sig[i + 3].value)}`);
        else names.add(unquoteIdent(nx.value));
      }
    }
  }
  return [...names];
}

/** Classify a single statement. */
export function analyzeStatement(sql, { readOnly = false, protectedTables = [] } = {}) {
  const tokens = tokenize(sql);
  const sig = significant(tokens);
  const { verb, index } = mainVerb(tokens);
  const w1 = kw(sig[0]);
  const w2 = kw(sig[1]);
  const result = { sql, type: verb || 'UNKNOWN', destructive: false, blocked: null, tables: referencedTables(sig), warnings: [] };

  // Determine statement type label
  if (w1 === 'CREATE') {
    const obj = ['TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL'].includes(w2) ? kw(sig[2]) : w2;
    result.type = obj === 'INDEX' ? 'CREATE INDEX' : obj === 'VIEW' ? 'CREATE VIEW' : obj === 'TABLE' ? 'CREATE TABLE' : `CREATE ${obj || ''}`.trim();
    if (w2 === 'VIRTUAL') result.blocked = 'Virtual tables are not supported';
    if (['TEMP', 'TEMPORARY'].includes(w2)) result.blocked = 'Temporary objects are not supported in Studio';
    if (obj === 'TRIGGER') result.blocked = 'Triggers are not supported in the SQL editor';
  } else if (w1 === 'DROP') {
    result.type = `DROP ${w2 || ''}`.trim();
  } else if (w1 === 'ALTER') {
    result.type = 'ALTER TABLE';
  } else if (w1 === 'EXPLAIN') {
    result.type = 'EXPLAIN';
  } else if (w1 === 'PRAGMA') {
    result.type = 'PRAGMA';
  } else if (verb === 'REPLACE') {
    result.type = 'INSERT';
  } else if (verb === 'VALUES') {
    result.type = 'SELECT';
  }

  // Hard blocks
  const upperAll = sig.map(kw);
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if ((t.type === 'ident' || t.type === 'keyword') && BANNED_FUNCTIONS.has(t.value.toLowerCase()) && sig[i + 1]?.value === '(') {
      result.blocked = `Function ${t.value}() is not allowed`;
    }
  }
  if (['ATTACH', 'DETACH'].includes(w1)) result.blocked = 'Attaching other databases is not allowed — queries are restricted to the selected database';
  if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(w1)) result.blocked = 'Transaction control is handled by LEDGER X automatically';
  if (['VACUUM', 'REINDEX', 'ANALYZE'].includes(w1)) result.blocked = `${w1} is not available in the SQL editor`;
  if (w1 === 'PRAGMA') {
    const name = (sig[1]?.value || '').toLowerCase();
    const hasAssign = sig.some((t) => t.value === '=');
    if (!READONLY_PRAGMAS.has(name) || hasAssign) result.blocked = `PRAGMA ${name} is not allowed`;
  }
  if (!result.blocked && !SUPPORTED.includes(result.type) && result.type !== 'PRAGMA') {
    result.blocked = `${result.type} statements are not supported`;
  }
  // System tables
  for (const tbl of result.tables) {
    const low = tbl.toLowerCase();
    if (low.includes('.') && !low.startsWith('main.')) result.blocked = 'Cross-database references are not allowed';
    const bare = low.replace(/^main\./, '');
    const isWrite = !['SELECT', 'EXPLAIN', 'PRAGMA'].includes(result.type);
    if (bare.startsWith('sqlite_') && isWrite) result.blocked = 'System tables cannot be modified';
    if (protectedTables.map((x) => x.toLowerCase()).includes(bare) && isWrite) result.blocked = `${tbl} is an internal LEDGER X table and cannot be modified here`;
  }

  // Destructive detection
  if (result.type === 'DELETE' || result.type.startsWith('DROP')) result.destructive = true;
  if (result.type === 'UPDATE') result.destructive = true;
  if (result.type === 'ALTER TABLE' && upperAll.includes('DROP')) result.destructive = true;
  if (result.type === 'INSERT' && (upperAll.includes('REPLACE'))) { result.destructive = true; result.warnings.push('REPLACE overwrites existing rows'); }
  if ((result.type === 'DELETE' || result.type === 'UPDATE') && !upperAll.slice(index).includes('WHERE')) {
    result.warnings.push(`This ${result.type} has no WHERE clause and will affect every row`);
  }

  if (readOnly && !result.blocked && !['SELECT', 'EXPLAIN', 'PRAGMA'].includes(result.type)) {
    result.blocked = 'The LEDGER X business database is read-only in Studio. Use the app screens to change business data.';
  }
  result.explanation = explain(result, sig);
  return result;
}

export function analyzeScript(sql, opts = {}) {
  const statements = splitStatements(sql).map((s) => analyzeStatement(s, opts));
  return {
    statements,
    blocked: statements.filter((s) => s.blocked),
    destructive: statements.some((s) => s.destructive),
    empty: statements.length === 0,
  };
}

/** Beginner-friendly plain-language explanation. */
function explain(r, sig) {
  const words = sig.map(kw);
  const has = (w) => words.includes(w);
  const t = r.tables.length ? r.tables.join(', ') : 'the database';
  const parts = [];
  switch (r.type) {
    case 'SELECT': {
      parts.push(`Reads data from ${t} without changing anything.`);
      if (has('JOIN')) parts.push('JOIN combines rows from several tables using matching columns.');
      if (has('WHERE')) parts.push('WHERE keeps only rows that match the condition.');
      if (has('GROUP')) parts.push('GROUP BY collapses rows into groups, typically with COUNT/SUM/AVG.');
      if (has('HAVING')) parts.push('HAVING filters the groups after aggregation.');
      if (has('ORDER')) parts.push('ORDER BY sorts the result.');
      if (has('LIMIT')) parts.push('LIMIT caps the number of rows returned.');
      break;
    }
    case 'INSERT': parts.push(`Adds new rows to ${t}.`); break;
    case 'UPDATE': parts.push(`Changes existing rows in ${t}.`, has('WHERE') ? 'Only rows matching WHERE are changed.' : 'Without WHERE, every row is changed.'); break;
    case 'DELETE': parts.push(`Permanently removes rows from ${t}.`, has('WHERE') ? 'Only rows matching WHERE are removed.' : 'Without WHERE, all rows are removed.'); break;
    case 'CREATE TABLE': parts.push('Creates a new table. Each column has a name, a type and optional constraints such as PRIMARY KEY, NOT NULL, UNIQUE or REFERENCES (foreign key).'); break;
    case 'ALTER TABLE': parts.push(`Changes the structure of ${t} — rename it, or add, rename or drop a column.`); break;
    case 'CREATE INDEX': parts.push('Creates an index, which makes lookups and sorting on the indexed columns faster.'); break;
    case 'DROP TABLE': parts.push(`Deletes the table ${t} and all of its data. This cannot be undone.`); break;
    case 'DROP INDEX': parts.push('Removes an index. Data is not affected.'); break;
    case 'CREATE VIEW': parts.push('Creates a saved query (view) you can SELECT from like a table.'); break;
    case 'EXPLAIN': parts.push('Shows how SQLite plans to execute the query, without running it.'); break;
    case 'PRAGMA': parts.push('Reads database metadata.'); break;
    default: parts.push('This statement type is not supported.');
  }
  return parts.join(' ');
}
