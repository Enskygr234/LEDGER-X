import { h, icon, card, sectionTitle, emptyState, errorState, iconButton, busy, replace, segmented, searchBar, infoState, loadingBlock } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet, promptDialog } from '../components/Modal.js';
import { field, textInput, textArea, selectInput, showErrors } from '../components/Input.js';
import { dataTable, pager } from '../components/DataTable.js';
import { navigate } from '../app/router.js';
import * as S from '../services/studioService.js';
import { exportStudioTableCSV, importCSVIntoTable } from '../services/backupService.js';
import { saveFile, pickFile } from '../app/platform.js';
import { columnEditor } from './DatabaseStudio.js';
import { todayISO } from '../utils/formatting.js';

const OPS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['like', 'contains'], ['null', 'is null'], ['notnull', 'is not null']];

function valueControl(col, value) {
  const t = col.type;
  if (t === 'BOOLEAN') return selectInput({ name: col.name, value: value === null || value === undefined ? '' : String(value ? 1 : 0), options: [['', 'NULL'], ['1', 'true'], ['0', 'false']] });
  if (t === 'DATE') return h('input', { class: 'input', type: 'date', 'data-name': col.name, value: value || '' });
  if (t === 'JSON' || (typeof value === 'string' && value.length > 80)) return textArea({ name: col.name, value: value ?? '', rows: 3 });
  return textInput({ name: col.name, value: value ?? '', inputmode: ['INTEGER', 'REAL', 'NUMERIC'].includes(t) ? 'decimal' : undefined, placeholder: col.pk ? 'Auto' : col.default ? `Default ${col.default}` : (col.notNull ? 'Required' : 'NULL') });
}

async function rowSheet(pid, table, columns, row = null) {
  const controls = columns.map((c) => [c, valueControl(c, row ? row[c.name] : null)]);
  const body = h('div', { class: 'form-grid' }, controls.map(([c, ctl]) => field(h('span', c.name, ' ', h('span', { class: 'faint', style: { fontSize: '11px' } }, `${c.type || 'ANY'}${c.pk ? ' · PK' : ''}${c.notNull ? ' · NOT NULL' : ''}`)), ctl, { name: c.name })));
  return openSheet({
    title: row ? 'Edit record' : 'New record', body,
    footer: (close) => {
      const save = h('button', { class: 'btn primary' }, icon('check'), 'Save');
      save.addEventListener('click', busy(save, async () => {
        const values = {};
        for (const [c, ctl] of controls) {
          if (row || ctl.value !== '') values[c.name] = ctl.value === '' && c.type !== 'TEXT' ? null : ctl.value;
        }
        try {
          if (row) await S.updateRow(pid, table, row.__rowid, values); else await S.insertRow(pid, table, values);
          toast(row ? 'Record updated' : 'Record added');
          close(true);
        } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'), save];
    },
  });
}

export async function TablePage({ pid, table }, ctx) {
  const project = await S.getProject(pid);
  if (!project) throw new Error('Database not found');
  const readOnly = !!project.readOnly;
  const st = { view: 'data', search: '', filters: [], sort: null, dir: 'asc', page: 1, pageSize: 25, selected: new Set() };
  const host = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' });

  async function paintData() {
    replace(body, loadingBlock(240));
    try {
      const r = await S.queryRows(pid, table, st);
      if (!ctx.isCurrent()) return;
      const cols = r.columns.map((c) => ({ key: c.name, label: c.name, type: c.type || 'ANY' }));
      const toolbar = h('div', { class: 'toolbar', style: { marginBottom: 0 } },
        searchBar('Search all columns', st.search, (v) => { st.search = v; st.page = 1; paintData(); }),
        h('button', { class: ['btn', st.filters.length && 'primary'], onclick: filterSheet, 'aria-label': 'Filter' }, icon('filter'), st.filters.length ? String(st.filters.length) : null));
      const selBar = st.selected.size && !readOnly ? h('div', { class: 'row between card', style: { padding: '8px 12px' } }, h('span', `${st.selected.size} selected`),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog({ title: `Delete ${st.selected.size} record(s)?`, message: 'This permanently removes the selected rows. Rows referencing them may be deleted too (ON DELETE CASCADE).', confirmLabel: 'Delete', danger: true }))) return;
          try { const n = await S.deleteRows(pid, table, [...st.selected]); st.selected.clear(); toast(`${n} record(s) deleted`); paintData(); } catch (e) { toastError(e); }
        } }, icon('trash'), 'Delete')) : null;
      replace(body, toolbar,
        st.filters.length ? h('div', { class: 'chips' }, st.filters.map((f, i) => h('button', { class: 'chip active', onclick: () => { st.filters.splice(i, 1); paintData(); } }, `${f.column} ${OPS.find((o) => o[0] === f.op)[1]} ${['null', 'notnull'].includes(f.op) ? '' : f.value}`, icon('x')))) : null,
        selBar,
        r.rows.length ? dataTable({
          columns: cols, rows: r.rows, sort: st.sort, dir: st.dir,
          onSort: (k) => { if (st.sort === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = k; st.dir = 'asc'; } paintData(); },
          selectable: !readOnly && r.editable, selected: st.selected, rowKey: (row) => row.__rowid,
          onToggle: (key, on) => { if (on === 'all') { st.selected = new Set(key); } else if (on) st.selected.add(key); else st.selected.delete(key); paintData(); },
          onRowClick: !readOnly && r.editable ? async (row) => { if (await rowSheet(pid, table, r.columns, row)) paintData(); } : null,
        }) : card(emptyState(st.search || st.filters.length ? { art: 'search', title: 'No matching records', text: 'Change the search or filters.' } : { art: 'database', title: 'No records', text: readOnly ? 'This table is empty.' : 'Add a record or import a CSV file.', action: readOnly ? null : h('button', { class: 'btn primary', onclick: async () => { if (await rowSheet(pid, table, r.columns)) paintData(); } }, icon('plus'), 'Add record') })),
        r.total > 0 ? pager({ page: r.page, pageSize: r.pageSize, total: r.total, onPage: (p) => { st.page = p; paintData(); } }) : null,
        !r.editable ? infoState('WITHOUT ROWID tables are read-only in the grid. Use the SQL editor to change them.') : null);
      st.columns = r.columns;
    } catch (e) { replace(body, errorState(e, paintData)); }
  }

  async function filterSheet() {
    const cols = st.columns || [];
    const col = selectInput({ name: 'column', value: cols[0]?.name, options: cols.map((c) => [c.name, c.name]) });
    const op = selectInput({ name: 'op', value: 'eq', options: OPS });
    const val = textInput({ name: 'value', placeholder: 'Value' });
    await openSheet({
      title: 'Add filter', body: h('div', { class: 'form-grid' }, field('Column', col), field('Condition', op), field('Value', val)),
      footer: (close) => [
        st.filters.length ? h('button', { class: 'btn ghost', onclick: () => { st.filters = []; close(); paintData(); } }, 'Clear all') : h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { st.filters.push({ column: col.value, op: op.value, value: val.value }); st.page = 1; close(); paintData(); } }, 'Apply')],
    });
  }

  async function paintStructure() {
    replace(body, loadingBlock(200));
    try {
      const { tables } = await S.introspect(pid);
      const t = tables.find((x) => x.name === table);
      if (!t) { replace(body, card(emptyState({ art: 'database', title: 'Table not found', text: 'It may have been renamed or dropped.' }))); return; }
      replace(body,
        card(h('div', { class: 'list' }, t.columns.map((c) => h('button', { class: 'list-item', onclick: readOnly ? null : () => columnActions(t, c, tables) },
          h('div', { class: 'grow' }, h('div', { class: 'primary mono' }, c.name),
            h('div', { class: 'secondary' }, [c.type || 'ANY', c.notNull ? 'NOT NULL' : null, c.default !== null ? `DEFAULT ${c.default}` : null, c.fk ? `→ ${c.fk.table}.${c.fk.column} (${c.fk.onDelete})` : null].filter(Boolean).join(' · '))),
          h('div', { class: 'pill-row' }, c.pk ? h('span', { class: 'tag pk' }, 'PK') : null, c.fk ? h('span', { class: 'tag fk' }, 'FK') : null, c.unique ? h('span', { class: 'tag uq' }, 'UQ') : null))))),
        readOnly ? null : h('button', { class: 'btn', onclick: () => addColumnSheet(tables) }, icon('plus'), 'Add column'),
        sectionTitle('Indexes', readOnly ? null : h('button', { class: 'btn sm', onclick: () => indexSheet(t) }, icon('plus'), 'Index')),
        t.indexes.length ? card(h('div', { class: 'list' }, t.indexes.map((ix) => h('div', { class: 'list-item' },
          h('div', { class: 'grow' }, h('div', { class: 'primary mono' }, ix.name), h('div', { class: 'secondary' }, `${ix.unique ? 'UNIQUE · ' : ''}${ix.columns.join(', ')} · ${ix.origin === 'pk' ? 'primary key' : ix.origin === 'u' ? 'unique constraint' : 'index'}`)),
          !readOnly && ix.origin === 'c' ? iconButton('trash', { title: 'Drop index', onClick: async () => {
            if (!(await confirmDialog({ title: `Drop index ${ix.name}?`, message: 'Data is not affected; lookups on these columns may get slower.', confirmLabel: 'Drop', danger: true }))) return;
            try { await S.dropIndex(pid, ix.name); toast('Index dropped'); paintStructure(); } catch (e) { toastError(e); }
          } }) : null)))) : card(h('div', { class: 'card-body muted' }, 'No indexes.')),
        sectionTitle('Definition'),
        card(h('div', { class: 'card-body' }, h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', margin: 0, fontSize: '12px', color: 'var(--text-2)' } }, t.sql))));
    } catch (e) { replace(body, errorState(e, paintStructure)); }
  }

  async function addColumnSheet(tables) {
    const ed = columnEditor({ type: 'TEXT' }, { tables: tables.filter((x) => x.name !== table || true), allowPk: false });
    await openSheet({
      title: 'Add column', body: ed.el,
      footer: (close) => {
        const b = h('button', { class: 'btn primary' }, 'Add column');
        b.addEventListener('click', busy(b, async () => { try { await S.addColumn(pid, table, ed.read()); toast('Column added'); close(); paintStructure(); } catch (e) { toastError(e); } }));
        return [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), b];
      },
    });
  }

  function columnActions(t, c, tables) {
    actionSheet(c.name, [
      { label: 'Edit definition', icon: 'edit', hint: 'Type, constraints, primary or foreign key', onSelect: async () => {
        const ed = columnEditor({ ...c, originalName: c.name, default: c.default?.replace(/^'(.*)'$/s, '$1') ?? null }, { tables });
        await openSheet({
          title: `Edit ${c.name}`, body: h('div', { class: 'stack' }, ed.el, infoState('SQLite rebuilds the table to apply this change. Data is copied and foreign keys are verified; nothing is changed if the check fails.')),
          footer: (close) => {
            const b = h('button', { class: 'btn primary' }, 'Apply');
            b.addEventListener('click', busy(b, async () => { try { await S.editColumn(pid, table, c.name, ed.read()); toast('Column updated'); close(); paintStructure(); } catch (e) { toastError(e); } }));
            return [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), b];
          },
        });
      } },
      { label: 'Drop column', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: `Drop ${c.name}?`, message: 'All values in this column are permanently deleted.', confirmLabel: 'Drop column', danger: true }))) return;
        try { await S.dropColumn(pid, table, c.name); toast('Column dropped'); paintStructure(); } catch (e) { toastError(e); }
      } },
    ]);
  }

  async function indexSheet(t) {
    const name = textInput({ name: 'name', placeholder: `ix_${table}_…` });
    const checks = t.columns.map((c) => { const i = h('input', { type: 'checkbox', value: c.name }); return [i, h('label', { class: 'check' }, i, h('span', { class: 'mono' }, c.name))]; });
    const uniq = h('input', { type: 'checkbox' });
    await openSheet({
      title: 'Create index', body: h('div', { class: 'stack' }, field('Name (optional)', name), h('div', { class: 'card', style: { padding: '4px 12px' } }, checks.map((c) => c[1])), h('label', { class: 'check' }, uniq, 'Unique')),
      footer: (close) => {
        const b = h('button', { class: 'btn primary' }, 'Create');
        b.addEventListener('click', busy(b, async () => {
          try { await S.createIndex(pid, table, { name: name.value.trim() || undefined, columns: checks.filter((c) => c[0].checked).map((c) => c[0].value), unique: uniq.checked }); toast('Index created'); close(); paintStructure(); } catch (e) { toastError(e); }
        }));
        return [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), b];
      },
    });
  }

  function paint() {
    replace(host, segmented([['data', 'Data'], ['structure', 'Structure']], st.view, (v) => { st.view = v; paint(); }), body);
    if (st.view === 'data') paintData(); else paintStructure();
  }
  paint();

  const more = () => actionSheet(table, [
    { label: 'Export CSV', icon: 'download', onSelect: async () => { try { const r = await saveFile(`${table}-${todayISO()}.csv`, await exportStudioTableCSV(pid, table), 'text/csv', { share: true }); toast(`Exported to ${r.location}`); } catch (e) { toastError(e); } } },
    !readOnly && { label: 'Import CSV', icon: 'upload', hint: 'First row must contain column names', onSelect: async () => {
      const f = await pickFile('.csv,text/csv'); if (!f) return;
      try { const n = await importCSVIntoTable(pid, table, await f.text()); toast(`${n} records imported`); paint(); } catch (e) { toastError(e); }
    } },
    { label: 'Query in SQL editor', icon: 'code', onSelect: () => navigate(`/studio/${pid}/sql?q=${encodeURIComponent(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 100`)}`) },
    !readOnly && { label: 'Rename table', icon: 'edit', onSelect: async () => {
      const n = await promptDialog({ title: 'Rename table', label: 'New name', value: table });
      if (!n || n === table) return;
      try { await S.renameTable(pid, table, n); toast('Renamed'); navigate(`/studio/${pid}/t/${encodeURIComponent(n)}`, { replace: true }); } catch (e) { toastError(e); }
    } },
    !readOnly && { label: 'Drop table', icon: 'trash', danger: true, onSelect: async () => {
      if (!(await confirmDialog({ title: `Drop table ${table}?`, message: 'The table and all of its records are permanently deleted. This cannot be undone.', confirmLabel: 'Drop table', danger: true }))) return;
      try { await S.dropTable(pid, table); toast('Table dropped'); navigate(`/studio/${pid}`, { replace: true }); } catch (e) { toastError(e); }
    } },
  ]);

  return {
    title: table, el: host,
    actions: [readOnly ? null : iconButton('plus', { title: 'Add record', onClick: async () => { const r = await S.queryRows(pid, table, { pageSize: 1 }); if (await rowSheet(pid, table, r.columns)) paint(); } }), iconButton('more', { title: 'Table actions', onClick: more })].filter(Boolean),
  };
}
