import { h, icon, card, emptyState, errorState, loadingList, searchBar, chips, segmented, replace, iconButton } from '../components/ui.js';
import { openSheet } from '../components/Modal.js';
import { navigate } from '../app/router.js';
import { listDocuments, INVOICE_STATUSES, QUOTATION_STATUSES } from '../services/invoiceService.js';
import { invoiceRow } from './Dashboard.js';
import { STATUS_LABELS, formatMoney } from '../utils/formatting.js';

export function businessTabs(active) {
  return segmented([['invoices', 'Invoices'], ['quotations', 'Quotes'], ['customers', 'Customers'], ['products', 'Products']], active, (v) => navigate(`/${v}`, { replace: true }));
}

const SORT_LABELS = { date_desc: 'Newest first', date_asc: 'Oldest first', total_desc: 'Amount: high → low', total_asc: 'Amount: low → high', number_desc: 'Number', customer_asc: 'Customer A–Z' };
const listState = { invoice: { search: '', status: '', sort: 'date_desc' }, quotation: { search: '', status: '', sort: 'date_desc' } };

function sortSheet(st, onChange) {
  return openSheet({
    title: 'Sort by',
    body: (close) => h('div', { class: 'card' }, h('div', { class: 'list' }, Object.entries(SORT_LABELS).map(([k, l]) =>
      h('button', { class: 'list-item', style: { minHeight: '50px' }, onclick: () => { st.sort = k; close(); onChange(); } },
        h('div', { class: 'grow primary' }, l), st.sort === k ? icon('check') : null)))),
  });
}

function docListPage(kind) {
  return async function Page(_p, ctx) {
    const st = listState[kind];
    const statuses = kind === 'invoice' ? INVOICE_STATUSES : QUOTATION_STATUSES;
    const base = kind === 'invoice' ? '/invoices' : '/quotations';
    const listHost = h('div', loadingList(5));
    const summary = h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '0 2px' } });
    const statusChips = h('div');
    const paintChips = () => replace(statusChips, chips([['', 'All'], ...statuses.map((s) => [s, STATUS_LABELS[s]])], st.status, (v) => { st.status = v; paintChips(); load(); }));
    paintChips();

    async function load() {
      try {
        const rows = await listDocuments(kind, st);
        if (!ctx.isCurrent()) return;
        const byCur = {};
        for (const r of rows) if (!['draft', 'cancelled'].includes(r.status)) byCur[r.currency] = (byCur[r.currency] || 0) + r.total_minor;
        summary.textContent = rows.length ? `${rows.length} ${kind === 'invoice' ? 'invoice' : 'quotation'}${rows.length === 1 ? '' : 's'} · ${Object.entries(byCur).map(([c, v]) => formatMoney(v, c)).join(' · ') || 'no billable total'} · ${SORT_LABELS[st.sort]}` : '';
        if (!rows.length) {
          const filtered = st.search || st.status;
          replace(listHost, card(emptyState(filtered
            ? { art: 'search', title: 'No matches', text: 'Try a different search or clear the status filter.', action: h('button', { class: 'btn', onclick: () => { st.search = ''; st.status = ''; ctx.refresh(); } }, 'Clear filters') }
            : { art: 'invoices', title: kind === 'invoice' ? 'No invoices yet' : 'No quotations yet', text: kind === 'invoice' ? 'Create professional invoices that work offline and export to PDF.' : 'Send a quotation, then convert it to an invoice in one tap once accepted.',
              action: h('button', { class: 'btn primary', onclick: () => navigate(`${base}/new`) }, icon('plus'), kind === 'invoice' ? 'New invoice' : 'New quotation') })));
          return;
        }
        replace(listHost, card(h('div', { class: 'list' }, rows.map((r) => invoiceRow(r, () => navigate(`${base}/${r.id}`))))));
      } catch (e) { replace(listHost, errorState(e, load)); }
    }
    ctx.onData(load);
    load();
    const el = h('div', { class: 'stack' },
      businessTabs(kind === 'invoice' ? 'invoices' : 'quotations'),
      h('div', { class: 'toolbar', style: { marginBottom: 0 } },
        searchBar(kind === 'invoice' ? 'Search number, customer, notes' : 'Search quotations', st.search, (v) => { st.search = v; load(); }),
        h('button', { class: 'btn', onclick: () => sortSheet(st, load), 'aria-label': 'Sort' }, icon('sort'))),
      statusChips, summary, listHost);
    return {
      title: kind === 'invoice' ? 'Invoices' : 'Quotations', el,
      actions: [iconButton('plus', { title: kind === 'invoice' ? 'New invoice' : 'New quotation', onClick: () => navigate(`${base}/new`) })],
    };
  };
}

export const InvoicesPage = docListPage('invoice');
export const QuotationsPage = docListPage('quotation');
