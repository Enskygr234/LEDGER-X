import { tokenize, TYPES } from './sqlTokenizer.js';
import { escapeHtml } from './formatting.js';

const BREAK_BEFORE = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'VALUES', 'SET', 'RETURNING', 'WINDOW']);
const JOIN_PREFIX = new Set(['LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL', 'NATURAL', 'OUTER']);

/** Pretty-print SQL: uppercase keywords, one clause per line, AND/OR indented. */
export function formatSQL(sql) {
  const tokens = tokenize(sql).filter((t) => t.type !== 'ws');
  let out = '';
  let prev = null;
  let betweenPending = false;
  let lastWasJoinPrefix = false;
  const space = () => { if (out && !/[\s(.]$/.test(out)) out += ' '; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const upper = t.type === 'keyword' ? t.value.toUpperCase() : null;
    if (t.type === 'comment') { out += (out && !out.endsWith('\n') ? '\n' : '') + t.value.trim() + '\n'; prev = t; continue; }
    if (t.type === 'semicolon') { out = out.trimEnd() + ';\n\n'; prev = t; continue; }
    if (upper) {
      const atStart = out === '' || out.endsWith('\n');
      if (t.depth === 0 && !atStart && (BREAK_BEFORE.has(upper) || (JOIN_PREFIX.has(upper) && !lastWasJoinPrefix) || (upper === 'JOIN' && !lastWasJoinPrefix))) {
        if (!(upper === 'SELECT' && prev && prev.type === 'punct' && prev.value === '(')) out = out.trimEnd() + '\n';
      } else if ((upper === 'AND' || upper === 'OR') && t.depth === 0 && !betweenPending) {
        out = out.trimEnd() + '\n  ';
      } else if (upper === 'ON' && t.depth === 0) {
        out = out.trimEnd() + '\n  ';
      } else space();
      if (upper === 'AND' && betweenPending) betweenPending = false;
      if (upper === 'BETWEEN') betweenPending = true;
      lastWasJoinPrefix = JOIN_PREFIX.has(upper);
      out += upper;
      prev = t;
      continue;
    }
    lastWasJoinPrefix = false;
    if (t.type === 'punct') {
      if (t.value === ',') { out = out.trimEnd() + ', '; }
      else if (t.value === '.') { out = out.trimEnd() + '.'; }
      else if (t.value === ')') { out = out.trimEnd() + ')'; }
      else if (t.value === '(') {
        const fnCall = prev && (prev.type === 'ident' || (prev.type === 'keyword' && ['COUNT', 'EXISTS'].includes(prev.value.toUpperCase())));
        if (!fnCall) space(); else out = out.trimEnd();
        out += '(';
      }
      prev = t; continue;
    }
    if (t.type === 'op') { out = out.trimEnd() + ` ${t.value} `; prev = t; continue; }
    if (prev && prev.type === 'punct' && prev.value === '.') out += t.type === 'ident' && TYPES.has(t.value.toUpperCase()) ? t.value : t.value;
    else { space(); out += t.type === 'ident' && TYPES.has(t.value.toUpperCase()) ? t.value.toUpperCase() : t.value; }
    prev = t;
  }
  return out.replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Syntax-highlight SQL into HTML spans (escaped). */
export function highlightSQL(sql) {
  return tokenize(sql).map((t) => {
    const v = escapeHtml(t.value);
    switch (t.type) {
      case 'keyword': return `<span class="sql-kw">${v}</span>`;
      case 'string': return `<span class="sql-str">${v}</span>`;
      case 'number': return `<span class="sql-num">${v}</span>`;
      case 'comment': return `<span class="sql-cm">${v}</span>`;
      case 'qident': return `<span class="sql-id">${v}</span>`;
      case 'param': return `<span class="sql-param">${v}</span>`;
      case 'ident': return TYPES.has(t.value.toUpperCase()) ? `<span class="sql-type">${v}</span>` : v;
      case 'op': return `<span class="sql-op">${v}</span>`;
      default: return v;
    }
  }).join('');
}
