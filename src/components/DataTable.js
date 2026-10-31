import { h, icon } from './ui.js';

/**
 * Generic data grid used by Database Studio and the SQL result viewer.
 * columns: [{ key, label, type, numeric }]
 */
export function dataTable({ columns, rows, sort, dir, onSort, onRowClick, selectable = false, selected = new Set(), onToggle, rowKey = (r, i) => i, maxCell = 120 }) {
  const head = h('tr',
    selectable ? h('th', { class: 'rowcheck' }, h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: rows.length > 0 && rows.every((r, i) => selected.has(rowKey(r, i))),
      onchange: (e) => onToggle?.(e.target.checked ? rows.map(rowKey) : [], 'all') })) : null,
    columns.map((c) => h('th', { class: onSort ? 'sortable' : '', onclick: onSort ? () => onSort(c.key) : null, 'aria-sort': sort === c.key ? (dir === 'desc' ? 'descending' : 'ascending') : undefined },
      c.label ?? c.key, c.type ? h('span', { class: 'ty' }, c.type) : null,
      sort === c.key ? h('span', { class: 'ty' }, dir === 'desc' ? '▼' : '▲') : null)));
  const body = rows.map((r, i) => {
    const key = rowKey(r, i);
    return h('tr', { class: selected.has(key) ? 'sel' : '', onclick: onRowClick ? (e) => { if (e.target.type !== 'checkbox') onRowClick(r, i); } : null, style: onRowClick ? { cursor: 'pointer' } : {} },
      selectable ? h('td', { class: 'rowcheck' }, h('input', { type: 'checkbox', checked: selected.has(key), 'aria-label': 'Select row', onchange: (e) => onToggle?.(key, e.target.checked) })) : null,
      columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return h('td', { class: 'null' }, 'NULL');
        if (v instanceof Uint8Array) return h('td', { class: 'null' }, `BLOB ${v.length} B`);
        const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return h('td', { class: (typeof v === 'number' || c.numeric) ? 'n' : '', title: text.length > 40 ? text.slice(0, 500) : undefined }, text.length > maxCell ? `${text.slice(0, maxCell)}…` : text);
      }));
  });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', head), h('tbody', body)));
}

export function pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return h('div', { class: 'pager' },
    h('span', `${from}–${to} of ${total}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => onPage(page - 1), 'aria-label': 'Previous page' }, icon('chevronLeft')),
      h('span', { class: 'num' }, `${page} / ${pages}`),
      h('button', { class: 'btn sm', disabled: page >= pages, onclick: () => onPage(page + 1), 'aria-label': 'Next page' }, icon('chevronRight'))));
}
