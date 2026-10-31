import { h, icon, card, sectionTitle, iconButton, busy, replace, badge, infoState, errorState, emptyState } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet, promptDialog } from '../components/Modal.js';
import { dataTable } from '../components/DataTable.js';
import { navigate } from '../app/router.js';
import * as S from '../services/studioService.js';
import { analyzeScript } from '../services/sqlGuard.js';
import { formatSQL, highlightSQL } from '../utils/sqlFormat.js';
import { copyText, saveFile } from '../app/platform.js';
import { relativeTime, formatNumber, toCSV, todayISO } from '../utils/formatting.js';
import { studioTabs } from './DatabaseStudio.js';

const drafts = new Map();

/** Code editor: transparent textarea over a highlighted <pre>, with a line-number gutter. */
export function sqlEditor(initial, { onRun, onChange } = {}) {
  const gutter = h('div', { class: 'sql-gutter', 'aria-hidden': 'true' });
  const pre = h('pre', { 'aria-hidden': 'true' });
  const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': 'SQL', wrap: 'off' });
  ta.value = initial;
  const area = h('div', { class: 'sql-area' }, pre, ta);
  const el = h('div', { class: 'sql-editor' }, gutter, area);
  const paint = () => {
    const v = ta.value;
    pre.innerHTML = `${highlightSQL(v)}${v.endsWith('\n') || v === '' ? ' ' : ''}`;
    gutter.textContent = Array.from({ length: v.split('\n').length }, (_, i) => i + 1).join('\n');
    ta.style.width = `${Math.max(area.clientWidth, pre.scrollWidth)}px`;
    ta.style.height = `${Math.max(160, pre.scrollHeight)}px`;
    onChange?.(v);
  };
  ta.addEventListener('input', paint);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); paint(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun?.(); }
  });
  requestAnimationFrame(paint);
  return { el, get value() { return ta.value; }, set value(v) { ta.value = v; area.scrollLeft = 0; area.scrollTop = 0; paint(); }, focus: () => ta.focus(), selection: () => ta.value.slice(ta.selectionStart, ta.selectionEnd) };
}

function explainPanel(sql, readOnly) {
  const a = analyzeScript(sql, { readOnly });
  if (a.empty) return infoState('Write a query to see what it does. Tip: Ctrl/⌘ + Enter runs it.');
  return card(h('div', { class: 'card-body stack', style: { gap: '10px' } }, a.statements.map((s, i) => h('div', { class: 'explain' },
    h('div', { class: 'row', style: { marginBottom: '4px' } }, h('span', { class: 'kbd' }, `#${i + 1}`), badge(s.blocked ? 'danger' : s.destructive ? 'warning' : 'info', s.type),
      s.blocked ? h('span', { style: { color: 'var(--danger)', fontSize: '12px' } }, 'Blocked') : s.destructive ? h('span', { style: { color: 'var(--warning)', fontSize: '12px' } }, 'Destructive') : null),
    h('div', s.blocked || s.explanation), ...s.warnings.map((w) => h('div', { style: { color: 'var(--warning)' } }, `⚠ ${w}`))))));
}

export async function SQLEditorPage({ pid, q }, ctx) {
  const project = await S.getProject(pid);
  if (!project) throw new Error('Database not found');
  const readOnly = !!project.readOnly;
  const sample = readOnly
    ? "-- Business data is read-only here\nSELECT number, status, total_minor / 100.0 AS total\nFROM invoices\nWHERE deleted_at IS NULL\nORDER BY issue_date DESC\nLIMIT 20;"
    : '-- Ctrl/⌘ + Enter to run\nSELECT name FROM sqlite_master WHERE type = \'table\';';
  const editor = sqlEditor(q || drafts.get(pid) || sample, { onRun: () => run(), onChange: (v) => { drafts.set(pid, v); explainHost.dataset.stale = '1'; if (showExplain) paintExplain(); } });
  const resultHost = h('div', { class: 'stack' });
  const explainHost = h('div');
  let showExplain = false;
  let lastResult = null;
  const paintExplain = () => replace(explainHost, showExplain ? explainPanel(editor.value, readOnly) : null);

  async function run({ confirmed = false } = {}) {
    const sql = editor.selection() || editor.value;
    replace(resultHost, h('div', { class: 'row muted' }, h('div', { class: 'spinner' }), 'Running…'));
    try {
      const r = await S.executeSQL(pid, sql, { confirmed });
      if (r.needsConfirmation) {
        const destructive = r.analysis.statements.filter((s) => s.destructive);
        const ok = await confirmDialog({
          title: 'Run destructive statements?', danger: true, confirmLabel: 'Run anyway',
          message: h('div', { class: 'stack', style: { gap: '8px' } }, h('p', { class: 'msg' }, `${destructive.length} statement(s) can permanently change or delete data in “${project.name}”:`),
            ...destructive.map((s) => h('div', { class: 'card', style: { padding: '8px 10px' } }, h('div', { class: 'mono', style: { fontSize: '12px', whiteSpace: 'pre-wrap', maxHeight: '90px', overflow: 'auto' } }, s.sql),
              ...s.warnings.map((w) => h('div', { style: { color: 'var(--warning)', fontSize: '12px', marginTop: '4px' } }, w))))),
        });
        if (!ok) { replace(resultHost, infoState('Cancelled — nothing was changed.')); return; }
        return run({ confirmed: true });
      }
      lastResult = r;
      paintResults(r);
    } catch (e) {
      replace(resultHost, errorState(e));
    }
  }

  function paintResults(r) {
    const blocks = r.results.map((res, i) => {
      if (res.rows) {
        return h('div', null,
          h('div', { class: 'result-meta' }, badge('info', res.type), h('span', `${formatNumber(res.rows.length)} row${res.rows.length === 1 ? '' : 's'}${res.truncated ? ' (first 1,000 shown)' : ''}`), r.results.length > 1 ? h('span', { class: 'faint' }, `statement ${i + 1}`) : null,
            res.rows.length ? h('button', { class: 'btn sm ghost', onclick: async () => { try { const x = await saveFile(`query-${todayISO()}.csv`, toCSV(res.rows), 'text/csv', { share: true }); toast(`Exported to ${x.location}`); } catch (e) { toastError(e); } } }, icon('download'), 'CSV') : null),
          res.rows.length ? dataTable({ columns: res.columns.map((c) => ({ key: c, label: c })), rows: res.rows }) : card(h('div', { class: 'card-body muted' }, 'The query returned no rows.')));
      }
      return h('div', { class: 'result-meta' }, badge('success', res.type), h('span', `${formatNumber(res.changes)} row${res.changes === 1 ? '' : 's'} affected`));
    });
    replace(resultHost, h('div', { class: 'result-meta' }, icon('clock'), h('span', `Executed in ${r.durationMs < 1 ? '<1' : r.durationMs.toFixed(1)} ms`), h('span', { class: 'faint' }, `on ${project.name}`)), ...blocks);
  }

  async function historySheet() {
    const rows = await S.queryHistory(pid);
    openSheet({
      title: 'Query history',
      body: (close) => rows.length ? card(h('div', { class: 'list' }, rows.map((r) => h('button', { class: 'list-item', style: { alignItems: 'flex-start' }, onclick: () => { editor.value = r.sql; close(); } },
        h('div', { class: ['avatar', r.error ? 'neutral' : 'alt'], style: r.error ? { color: 'var(--danger)', background: 'var(--danger-soft)' } : {} }, icon(r.error ? 'alert' : 'check')),
        h('div', { class: 'grow' }, h('div', { class: 'primary mono', style: { fontSize: '12.5px' } }, r.sql.replace(/\s+/g, ' ').slice(0, 90)),
          h('div', { class: 'secondary' }, r.error ? r.error : `${r.row_count} rows · ${Number(r.duration_ms).toFixed(1)} ms · ${relativeTime(r.executed_at)}`))))))
        : emptyState({ art: 'search', title: 'No history yet', text: 'Executed queries appear here.' }),
    });
  }

  async function savedSheet() {
    const rows = await S.savedQueries(pid);
    openSheet({
      title: 'Saved queries',
      body: (close) => rows.length ? card(h('div', { class: 'list' }, rows.map((r) => h('div', { class: 'list-item' },
        h('div', { class: 'avatar' }, icon('star')),
        h('button', { class: 'grow', style: { background: 'none', border: 0, textAlign: 'left', padding: 0 }, onclick: () => { editor.value = r.sql; close(); } }, h('div', { class: 'primary' }, r.title), h('div', { class: 'secondary mono' }, r.sql.replace(/\s+/g, ' ').slice(0, 70))),
        iconButton('trash', { title: 'Delete', onClick: async () => { await S.deleteSavedQuery(r.id); close(); toast('Deleted'); savedSheet(); } })))))
        : emptyState({ art: 'search', title: 'No saved queries', text: 'Tap the star to keep a query for later.' }),
    });
  }

  const runBtn = h('button', { class: 'btn primary' }, icon('play'), 'Run');
  runBtn.addEventListener('click', busy(runBtn, () => run()));
  const toolbar = h('div', { class: 'row wrap' }, runBtn,
    h('button', { class: 'btn', onclick: () => { editor.value = formatSQL(editor.value); } }, icon('sparkle'), 'Format'),
    h('button', { class: ['btn'], onclick: (e) => { showExplain = !showExplain; e.currentTarget.classList.toggle('primary', showExplain); paintExplain(); } }, icon('info'), 'Explain'),
    h('div', { class: 'grow' }),
    iconButton('copy', { title: 'Copy query', onClick: async () => { await copyText(editor.value); toast('Query copied'); } }),
    iconButton('star', { title: 'Save as favorite', onClick: async () => {
      const t = await promptDialog({ title: 'Save query', label: 'Name', placeholder: 'e.g. Unpaid invoices', validate: (v) => (!v ? 'Give it a name' : null) });
      if (t) { await S.saveQuery(pid, t, editor.value); toast('Saved to favorites'); }
    } }),
    iconButton('history', { title: 'History', onClick: historySheet }),
    iconButton('archive', { title: 'Saved queries', onClick: savedSheet }));

  const switchDb = async () => {
    const [biz, ps] = await Promise.all([S.businessProject(), S.listProjects()]);
    actionSheet('Run queries against', [...ps, biz].map((p) => ({ label: p.name, icon: p.readOnly ? 'shield' : 'database', hint: p.id === pid ? 'Current' : p.readOnly ? 'Read-only' : `${p.tableCount} tables`, onSelect: () => navigate(`/studio/${p.id}/sql`, { replace: true }) })));
  };

  const el = h('div', { class: 'stack' },
    studioTabs(pid, 'sql'),
    h('button', { class: 'card row', style: { padding: '10px 14px', textAlign: 'left', width: '100%', color: 'inherit' }, onclick: switchDb },
      icon(readOnly ? 'shield' : 'database'), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600, fontSize: '13.5px' } }, project.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, readOnly ? 'Read-only · SELECT and EXPLAIN only' : 'Queries run only against this database')), icon('chevronDown', 'chev')),
    editor.el, toolbar, explainHost, resultHost);
  return { title: 'SQL editor', el, hideFab: true };
}
