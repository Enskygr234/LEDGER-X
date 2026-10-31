/**
 * Small, dependency-free SQLite tokenizer used by the SQL guard, formatter
 * and syntax highlighter. Handles strings, quoted identifiers, comments,
 * numbers, parameters and operators.
 */

export const KEYWORDS = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY
CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME
CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE
EXCEPT EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP HAVING IF
IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE
LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OUTER OVER PARTITION PLAN
PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT
RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET STRICT TABLE TEMP TEMPORARY THEN TO TRANSACTION TRIGGER
UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/));

export const TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'BLOB', 'JSON', 'INT', 'VARCHAR', 'CHAR', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BIGINT', 'TIMESTAMP']);

/**
 * Token: { type, value, start, end, depth }
 * types: ws, comment, string, ident, qident, keyword, number, param, op, punct, semicolon
 */
export function tokenize(sql) {
  const out = [];
  let i = 0, depth = 0;
  const n = sql.length;
  const push = (type, start, end) => out.push({ type, value: sql.slice(start, end), start, end, depth });
  while (i < n) {
    const c = sql[i];
    const s = i;
    if (/\s/.test(c)) { while (i < n && /\s/.test(sql[i])) i++; push('ws', s, i); continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; push('comment', s, i); continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; push('comment', s, i); continue; }
    if (c === "'") {
      i++;
      while (i < n) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      push('string', s, i); continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) { if (sql[i] === close) { if (close !== ']' && sql[i + 1] === close) { i += 2; continue; } i++; break; } i++; }
      push('qident', s, i); continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      if (c === '0' && /[xX]/.test(sql[i + 1] || '')) { i += 2; while (i < n && /[0-9a-fA-F]/.test(sql[i])) i++; }
      else { while (i < n && /[0-9.]/.test(sql[i])) i++; if (/[eE]/.test(sql[i] || '')) { i++; if (/[+-]/.test(sql[i])) i++; while (i < n && /[0-9]/.test(sql[i])) i++; } }
      push('number', s, i); continue;
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') {
      if (c === '?' || /[A-Za-z_]/.test(sql[i + 1] || '')) {
        i++; while (i < n && /[A-Za-z0-9_]/.test(sql[i])) i++; push('param', s, i); continue;
      }
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i])) i++;
      const word = sql.slice(s, i).toUpperCase();
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', s, i); continue;
    }
    if (c === ';') { i++; push('semicolon', s, i); continue; }
    if (c === '(') { i++; push('punct', s, i); depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); i++; push('punct', s, i); continue; }
    if (c === ',' || c === '.') { i++; push('punct', s, i); continue; }
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '==', '||', '<<', '>>', '->'].includes(two)) { i += 2; if (sql[i] === '>' && two === '->') i++; push('op', s, i); continue; }
    i++; push('op', s, i);
  }
  return out;
}

/** Split a script into individual statements (top-level semicolons only). */
export function splitStatements(sql) {
  const tokens = tokenize(sql);
  const stmts = [];
  let start = 0;
  let inTrigger = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'keyword' && t.value.toUpperCase() === 'TRIGGER') inTrigger = true;
    if (inTrigger && t.type === 'keyword' && t.value.toUpperCase() === 'END') inTrigger = false;
    if (t.type === 'semicolon' && t.depth === 0 && !inTrigger) {
      const text = sql.slice(start, t.start).trim();
      if (meaningful(text)) stmts.push(text);
      start = t.end;
    }
  }
  const tail = sql.slice(start).trim();
  if (meaningful(tail)) stmts.push(tail);
  return stmts;
}

function meaningful(text) {
  return tokenize(text).some((t) => t.type !== 'ws' && t.type !== 'comment');
}

export const significant = (tokens) => tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');

export function unquoteIdent(v) {
  if (!v) return v;
  const f = v[0];
  if (f === '"' || f === '`') return v.slice(1, -1).replace(new RegExp(f + f, 'g'), f);
  if (f === '[') return v.slice(1, -1);
  return v;
}
