import { h, icon, card, sectionTitle, emptyState, errorState, loadingList, iconButton, busy, replace, badge, infoState } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet, promptDialog } from '../components/Modal.js';
import { field, textInput, textArea, selectInput, showErrors } from '../components/Input.js';
import { navigate } from '../app/router.js';
import * as S from '../services/studioService.js';
import { exportProjectSQL, importProjectSQL } from '../services/backupService.js';
import { saveFile, pickFile } from '../app/platform.js';
import { formatBytes, formatNumber, relativeTime, todayISO } from '../utils/formatting.js';
import { currentDriverKind } from '../storage/sqlite.js';

export function studioTabs(pid, active) {
  const tab = (key, label, ic, path) => h('button', { class: active === key ? 'active' : '', onclick: () => navigate(path, { replace: true }) }, label);
  return h('div', { class: 'segmented' },
    tab('tables', 'Tables', 'table', `/studio/${pid}`), tab('sql', 'SQL editor', 'code', `/studio/${pid}/sql`), tab('er', 'ER diagram', 'layout', `/studio/${pid}/er`));
}

async function createProjectSheet() {
  const name = textInput({ name: 'name', placeholder: 'e.g. Inventory, Fleet log, CRM experiments' });
  const desc = textArea({ name: 'description', rows: 2, placeholder: 'What is this database for?' });
  const body = h('div', { class: 'form-grid' }, field('Name', name, { name: 'name' }), field('Description', desc),
    infoState('Each project is a separate SQLite database on this device, fully isolated from your business data.', 'shield'));
  return openSheet({
    title: 'New database', body,
    footer: (close) => {
      const b = h('button', { class: 'btn primary' }, icon('plus'), 'Create database');
      b.addEventListener('click', busy(b, async () => {
        try { const id = await S.createProject({ name: name.value, description: desc.value }); toast('Database created'); close(id); } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'), b];
    },
  });
}

function projectCard(p) {
  return h('button', { class: 'card project-card', onclick: () => navigate(`/studio/${p.id}`) },
    h('div', { class: 'row' }, h('div', { class: ['avatar', p.readOnly ? 'alt' : ''] }, icon(p.readOnly ? 'shield' : 'database')),
      h('div', { class: 'grow' }, h('div', { class: 'primary', style: { fontWeight: 600 } }, p.name), h('div', { class: 'secondary muted', style: { fontSize: '12.5px' } }, p.description || p.db_name)),
      p.readOnly ? badge('info', 'Read-only') : icon('chevronRight', 'chev')),
    h('div', { class: 'meta' },
      h('div', h('b', formatNumber(p.tableCount)), 'tables'),
      h('div', h('b', formatNumber(p.records)), 'records'),
      h('div', h('b', formatBytes(p.sizeBytes)), p.last_modified_at ? `edited ${relativeTime(p.last_modified_at)}` : 'size')),
    p.error ? h('div', { class: 'state-error' }, icon('alert'), p.error) : null);
}

export async function StudioPage(params, ctx) {
  const host = h('div', { class: 'stack' }, loadingList(3));
  async function load() {
    try {
      const [biz, projects] = await Promise.all([S.businessProject(), S.listProjects()]);
      if (!ctx.isCurrent()) return;
      const totalSize = projects.reduce((a, p) => a + (p.sizeBytes || 0), 0) + biz.sizeBytes;
      replace(host,
        h('div', { class: 'stat-grid' },
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('database'), 'Databases'), h('div', { class: 'value' }, String(projects.length + 1))),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('table'), 'Tables'), h('div', { class: 'value' }, formatNumber(projects.reduce((a, p) => a + p.tableCount, 0) + biz.tableCount))),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('hash'), 'Records'), h('div', { class: 'value' }, formatNumber(projects.reduce((a, p) => a + p.records, 0) + biz.records))),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('archive'), 'Storage'), h('div', { class: 'value' }, formatBytes(totalSize)), h('div', { class: 'sub' }, `SQLite · ${currentDriverKind()}`))),
        sectionTitle('Your databases', h('button', { class: 'btn sm', onclick: newProject }, icon('plus'), 'New')),
        projects.length ? h('div', { class: 'stack' }, projects.map(projectCard))
          : card(emptyState({ art: 'database', title: 'Design your first database', text: 'Create tables, relationships and indexes visually, edit data, run SQL and see an ER diagram — all offline.', action: h('button', { class: 'btn primary', onclick: newProject }, icon('plus'), 'New database') })),
        sectionTitle('System'),
        projectCard(biz));
    } catch (e) { replace(host, errorState(e, load)); }
  }
  async function newProject() {
    const id = await createProjectSheet();
    if (id) navigate(`/studio/${id}`);
  }
  async function importSql() {
    const file = await pickFile('.sql,text/plain');
    if (!file) return;
    const name = await promptDialog({ title: 'Import SQL script', label: 'New database name', value: file.name.replace(/\.sql$/i, ''), confirmLabel: 'Import' });
    if (!name) return;
    try { const r = await importProjectSQL(name, await file.text()); toast(`Imported ${r.statements} statements`); navigate(`/studio/${r.id}`); } catch (e) { toastError(e); }
  }
  ctx.onData(load);
  await load();
  if (params.create) setTimeout(newProject, 100);
  return {
    title: 'Database Studio', el: host,
    actions: [iconButton('upload', { title: 'Import SQL script', onClick: importSql }), iconButton('plus', { title: 'New database', onClick: newProject })],
  };
}

// ---------------------------------------------------------------- project

export async function ProjectPage({ pid }, ctx) {
  const project = await S.getProject(pid);
  if (!project) throw new Error('Database not found');
  const host = h('div', { class: 'stack' }, loadingList(3));
  async function load() {
    try {
      const { tables, readOnly } = await S.introspect(pid);
      if (!ctx.isCurrent()) return;
      replace(host,
        studioTabs(pid, 'tables'),
        readOnly ? infoState('Business data is read-only here. Browse it, run SELECT queries and view the ER diagram; change records from the app screens.', 'shield') : null,
        tables.length ? card(h('div', { class: 'list' }, tables.map((t) => h('button', { class: 'list-item', onclick: () => navigate(`/studio/${pid}/t/${encodeURIComponent(t.name)}`) },
          h('div', { class: 'avatar neutral' }, icon('table')),
          h('div', { class: 'grow' }, h('div', { class: 'primary' }, t.name),
            h('div', { class: 'secondary' }, `${t.columns.length} columns · ${t.foreignKeys.length} relations · ${t.indexes.filter((i) => i.origin === 'c').length} indexes`)),
          h('div', { class: 'trail' }, h('b', { class: 'num' }, formatNumber(t.rowCount)), h('span', { class: 'faint', style: { fontSize: '11px' } }, 'rows'))))))
          : card(emptyState({ art: 'database', title: 'No tables yet', text: 'Create a table with columns, keys and constraints — or write CREATE TABLE in the SQL editor.',
            action: h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => openCreateTable(pid) }, icon('plus'), 'Create table'), h('button', { class: 'btn', onclick: () => navigate(`/studio/${pid}/sql`) }, icon('code'), 'SQL')) })));
    } catch (e) { replace(host, errorState(e, load)); }
  }
  ctx.onData(load);
  await load();
  const more = () => actionSheet(project.name, [
    !project.readOnly && { label: 'Rename', icon: 'edit', onSelect: async () => {
      const n = await promptDialog({ title: 'Rename database', label: 'Name', value: project.name, validate: (v) => (!v ? 'Name is required' : null) });
      if (n) { await S.renameProject(pid, n, project.description); toast('Renamed'); ctx.refresh(); }
    } },
    !project.readOnly && { label: 'Export as SQL script', icon: 'download', onSelect: async () => {
      try { const r = await saveFile(`${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${todayISO()}.sql`, await exportProjectSQL(pid), 'application/sql', { share: true }); toast(`Exported to ${r.location}`); } catch (e) { toastError(e); }
    } },
    !project.readOnly && { label: 'Delete database', icon: 'trash', danger: true, onSelect: async () => {
      const typed = await promptDialog({ title: 'Delete database?', label: `This permanently deletes "${project.name}" and all its tables. Type the name to confirm.`, confirmLabel: 'Delete', validate: (v) => (v !== project.name ? 'Name does not match' : null) });
      if (typed !== project.name) return;
      await S.deleteProject(pid); toast('Database deleted'); navigate('/studio', { replace: true });
    } },
  ]);
  return {
    title: project.name, el: host,
    actions: [!project.readOnly ? iconButton('plus', { title: 'Create table', onClick: () => openCreateTable(pid) }) : null, project.readOnly ? null : iconButton('more', { title: 'More', onClick: more })].filter(Boolean),
  };
}

// ---------------------------------------------------------------- column designer

/** Editable column spec row used by "create table" and "add/edit column". */
export function columnEditor(col, { tables = [], onRemove, allowPk = true } = {}) {
  const name = textInput({ name: 'col_name', value: col.name || '', placeholder: 'column_name' });
  const type = selectInput({ name: 'col_type', value: col.type || 'TEXT', options: S.COLUMN_TYPES.map((t) => [t, t]) });
  const def = textInput({ name: 'col_default', value: col.default ?? '', placeholder: 'Default (optional)' });
  const flag = (key, label, checked) => {
    const i = h('input', { type: 'checkbox', checked });
    return { i, el: h('label', i, label) };
  };
  const pk = flag('pk', 'Primary key', col.pk);
  const ai = flag('ai', 'Auto-increment', col.autoincrement);
  const nn = flag('nn', 'Not null', col.notNull);
  const uq = flag('uq', 'Unique', col.unique);
  const fkTargets = [['', 'No foreign key'], ...tables.flatMap((t) => t.columns.filter((c) => c.pk || c.unique).map((c) => [`${t.name}.${c.name}`, `→ ${t.name}.${c.name}`]))];
  const fk = selectInput({ name: 'col_fk', value: col.fk ? `${col.fk.table}.${col.fk.column}` : '', options: fkTargets });
  const onDel = selectInput({ name: 'col_ondelete', value: col.fk?.onDelete || 'NO ACTION', options: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'].map((x) => [x, `On delete: ${x}`]) });
  const syncAi = () => { ai.el.style.display = pk.i.checked && type.value === 'INTEGER' ? '' : 'none'; onDel.style.display = fk.value ? '' : 'none'; };
  pk.i.addEventListener('change', syncAi); type.addEventListener('change', syncAi); fk.addEventListener('change', syncAi);
  syncAi();
  const el = h('div', { class: 'line-card' },
    h('div', { class: 'col-row' }, name, type, onRemove ? iconButton('trash', { title: 'Remove column', onClick: () => { el.remove(); onRemove(); } }) : h('span')),
    h('div', { class: 'col-flags' }, allowPk ? pk.el : null, allowPk ? ai.el : null, nn.el, uq.el),
    h('div', { class: 'form-grid two' }, def, fkTargets.length > 1 ? fk : h('span', { class: 'faint', style: { fontSize: '12px', alignSelf: 'center' } }, 'Create a table with a primary key to add foreign keys'), fkTargets.length > 1 ? onDel : null));
  return {
    el,
    read() {
      const [ft, fc] = fk.value ? fk.value.split(/\.(?=[^.]+$)/) : [];
      return {
        name: name.value.trim(), originalName: col.originalName, type: type.value, default: def.value.trim() === '' ? null : def.value.trim(),
        pk: allowPk && pk.i.checked, autoincrement: allowPk && pk.i.checked && ai.i.checked && type.value === 'INTEGER', notNull: nn.i.checked, unique: uq.i.checked,
        fk: ft ? { table: ft, column: fc, onDelete: onDel.value } : null,
      };
    },
  };
}

export async function openCreateTable(pid) {
  const { tables } = await S.introspect(pid);
  const tname = textInput({ name: 'name', placeholder: 'e.g. suppliers' });
  const cols = [];
  const colsHost = h('div', { class: 'stack' });
  const add = (c) => { const ed = columnEditor(c, { tables, onRemove: () => cols.splice(cols.indexOf(ed), 1) }); cols.push(ed); colsHost.appendChild(ed.el); };
  add({ name: 'id', type: 'INTEGER', pk: true, autoincrement: true });
  add({ name: 'name', type: 'TEXT', notNull: true });
  const preview = h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', fontSize: '12px', color: 'var(--text-2)', margin: 0 } });
  const updatePreview = () => { try { preview.textContent = S.createTableSQL(tname.value.trim() || 'new_table', cols.map((c) => c.read()).filter((c) => c.name)); } catch (e) { preview.textContent = `-- ${e.message}`; } };
  const body = h('div', { class: 'stack', oninput: updatePreview, onchange: updatePreview },
    field('Table name', tname, { name: 'name' }),
    sectionTitle('Columns', h('button', { class: 'btn sm', onclick: () => { add({ type: 'TEXT' }); updatePreview(); } }, icon('plus'), 'Column')),
    colsHost,
    h('details', null, h('summary', { class: 'muted', style: { cursor: 'pointer', fontSize: '13px' } }, 'Generated SQL'), card(h('div', { class: 'card-body' }, preview))));
  updatePreview();
  return openSheet({
    title: 'Create table', body, full: true,
    footer: (close) => {
      const b = h('button', { class: 'btn primary' }, icon('check'), 'Create table');
      b.addEventListener('click', busy(b, async () => {
        try {
          await S.createTable(pid, { name: tname.value, columns: cols.map((c) => c.read()) });
          toast('Table created');
          close(true);
          navigate(`/studio/${pid}/t/${encodeURIComponent(tname.value.trim())}`);
        } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'), b];
    },
  });
}
