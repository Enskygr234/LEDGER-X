import { h, icon, card, sectionTitle, badge, avatar, emptyState, errorState, loadingList, searchBar, iconButton, busy, replace, chips } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet } from '../components/Modal.js';
import { field, textInput, textArea, showErrors } from '../components/Input.js';
import { navigate } from '../app/router.js';
import * as C from '../services/customerService.js';
import { businessTabs } from './Invoices.js';
import { invoiceRow } from './Dashboard.js';
import { formatMoney, formatDate } from '../utils/formatting.js';

/** Create/edit customer sheet. Resolves with the saved customer or null. */
export async function openCustomerForm(existing = null) {
  const f = {
    name: textInput({ name: 'name', value: existing?.name, placeholder: 'Person or company name', autocomplete: 'organization' }),
    code: textInput({ name: 'code', value: existing?.code, placeholder: 'Auto' }),
    email: textInput({ name: 'email', value: existing?.email, type: 'email', inputmode: 'email', autocomplete: 'email' }),
    phone: textInput({ name: 'phone', value: existing?.phone, type: 'tel', inputmode: 'tel', autocomplete: 'tel' }),
    tax_id: textInput({ name: 'tax_id', value: existing?.tax_id, placeholder: 'VAT / tax number' }),
    address: textArea({ name: 'address', value: existing?.address, rows: 2 }),
    notes: textArea({ name: 'notes', value: existing?.notes, rows: 2 }),
  };
  let dirty = false;
  const body = h('div', { class: 'form-grid two', oninput: () => { dirty = true; } },
    field('Name', f.name, { name: 'name', span: true }), field('Customer ID', f.code, { name: 'code' }), field('Tax ID', f.tax_id, { name: 'tax_id' }),
    field('Email', f.email, { name: 'email' }), field('Phone', f.phone, { name: 'phone' }),
    field('Address', f.address, { name: 'address', span: true }), field('Notes', f.notes, { name: 'notes', span: true }));
  return openSheet({
    title: existing ? 'Edit customer' : 'New customer', body,
    guard: async () => !dirty || confirmDialog({ title: 'Discard changes?', message: 'This customer has unsaved changes.', confirmLabel: 'Discard', danger: true }),
    footer: (close) => {
      const save = h('button', { class: 'btn primary' }, icon('check'), 'Save');
      save.addEventListener('click', busy(save, async () => {
        const data = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        try {
          const r = existing ? await C.updateCustomer(existing.id, data) : await C.createCustomer(data);
          toast(existing ? 'Customer updated' : 'Customer added');
          dirty = false;
          close(r);
        } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => { dirty = false; close(null); } }, 'Cancel'), save];
    },
  });
}

const st = { search: '', archived: false };

export async function CustomersPage(_p, ctx) {
  const listHost = h('div', loadingList(5));
  const filterHost = h('div');
  const paintFilter = () => replace(filterHost, chips([[false, 'Active'], [true, 'Include archived']], st.archived, (v) => { st.archived = v; paintFilter(); load(); }));
  paintFilter();
  async function load() {
    try {
      const rows = await C.listCustomers({ search: st.search, includeArchived: st.archived });
      if (!ctx.isCurrent()) return;
      if (!rows.length) {
        replace(listHost, card(emptyState(st.search ? { art: 'search', title: 'No matches', text: 'No customer matches that search.' }
          : { art: 'people', title: 'No customers yet', text: 'Customers you add are available offline and in every invoice.', action: h('button', { class: 'btn primary', onclick: async () => { const c = await openCustomerForm(); if (c) navigate(`/customers/${c.id}`); } }, icon('plus'), 'Add customer') })));
        return;
      }
      replace(listHost, card(h('div', { class: 'list' }, rows.map((c) => h('button', { class: 'list-item', onclick: () => navigate(`/customers/${c.id}`) },
        avatar(c.name, c.archived_at ? 'neutral' : ''),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, c.name), h('div', { class: 'secondary' }, [c.code, c.email || c.phone].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, c.archived_at ? badge('draft', 'Archived') : h('span', { class: 'muted', style: { fontSize: '12px' } }, `${c.invoice_count} invoice${c.invoice_count === 1 ? '' : 's'}`),
          c.balance_minor > 0 ? badge('partially_paid', 'Balance due') : null))))));
    } catch (e) { replace(listHost, errorState(e, load)); }
  }
  ctx.onData(load);
  load();
  return {
    title: 'Customers',
    el: h('div', { class: 'stack' }, businessTabs('customers'), searchBar('Search name, email, phone, ID', st.search, (v) => { st.search = v; load(); }), filterHost, listHost),
    actions: [iconButton('plus', { title: 'Add customer', onClick: async () => { const c = await openCustomerForm(); if (c) navigate(`/customers/${c.id}`); } })],
  };
}

export async function CustomerDetailPage({ id }, ctx) {
  const host = h('div', { class: 'stack-lg' });
  async function render() {
    const p = await C.customerProfile(id);
    if (!p || p.customer.deleted_at) { replace(host, card(emptyState({ art: 'people', title: 'Customer not found', text: 'It may have been deleted.' }))); return null; }
    const { customer: c, invoices, quotations, balances, transactions } = p;
    replace(host,
      card(h('div', { class: 'card-body stack' },
        h('div', { class: 'row' }, h('div', { class: 'avatar', style: { width: '52px', height: '52px', fontSize: '17px', borderRadius: '16px' } }, c.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase()),
          h('div', { class: 'grow' }, h('h2', { style: { fontSize: '19px' } }, c.name), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `${c.code || ''} · customer since ${formatDate(c.created_at)}`)),
          c.archived_at ? badge('draft', 'Archived') : null),
        h('dl', { class: 'kv' },
          c.email ? [h('dt', 'Email'), h('dd', h('a', { href: `mailto:${c.email}` }, c.email))] : null,
          c.phone ? [h('dt', 'Phone'), h('dd', h('a', { href: `tel:${c.phone}` }, c.phone))] : null,
          c.tax_id ? [h('dt', 'Tax ID'), h('dd', c.tax_id)] : null,
          c.address ? [h('dt', 'Address'), h('dd', { style: { whiteSpace: 'pre-wrap' } }, c.address)] : null),
        c.notes ? h('p', { class: 'muted', style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, c.notes) : null,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onclick: () => navigate(`/invoices/new?customer=${c.id}`) }, icon('invoice'), 'New invoice'),
          h('button', { class: 'btn', onclick: () => navigate(`/quotations/new?customer=${c.id}`) }, icon('quote'), 'New quote')))),
      h('div', { class: 'stat-grid' },
        ...(balances.length ? balances : [{ currency: null, billed_minor: 0, paid_minor: 0, balance_minor: 0 }]).flatMap((b) => [
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('wallet'), `Balance${b.currency ? ` · ${b.currency}` : ''}`), h('div', { class: 'value' }, b.currency ? formatMoney(b.balance_minor, b.currency) : '—'), h('div', { class: 'sub' }, b.currency ? `${formatMoney(b.paid_minor, b.currency)} of ${formatMoney(b.billed_minor, b.currency)} paid` : 'Nothing billed yet')),
        ]),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('invoice'), 'Documents'), h('div', { class: 'value' }, `${invoices.length} · ${quotations.length}`), h('div', { class: 'sub' }, 'invoices · quotations'))),
      h('div', null, sectionTitle('Invoices'), invoices.length ? card(h('div', { class: 'list' }, invoices.map((i) => invoiceRow({ ...i, customer_name: i.number }, () => navigate(`/invoices/${i.id}`), { docIcon: true })))) : card(h('div', { class: 'card-body muted' }, 'No invoices.'))),
      h('div', null, sectionTitle('Quotations'), quotations.length ? card(h('div', { class: 'list' }, quotations.map((q) => invoiceRow({ ...q, customer_name: q.number }, () => navigate(`/quotations/${q.id}`), { docIcon: true })))) : card(h('div', { class: 'card-body muted' }, 'No quotations.'))),
      h('div', null, sectionTitle('Transaction history'), transactions.length ? card(h('div', { class: 'list' }, transactions.map((t) => h('button', { class: 'list-item', onclick: () => navigate(`/invoices/${t.id}`) },
        h('div', { class: ['avatar', t.kind === 'payment' ? 'alt' : 'neutral'] }, icon(t.kind === 'payment' ? 'wallet' : 'invoice')),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, t.kind === 'payment' ? 'Payment received' : 'Invoice issued'), h('div', { class: 'secondary' }, `${t.ref} · ${formatDate(t.date)}`)),
        h('b', { class: 'num', style: { color: t.amount_minor < 0 ? 'var(--success)' : 'var(--text)' } }, `${t.amount_minor < 0 ? '−' : '+'}${formatMoney(Math.abs(t.amount_minor), t.currency)}`)))))
        : card(h('div', { class: 'card-body muted' }, 'No transactions yet.'))));
    return c;
  }
  const c = await render();
  ctx.onData(render);
  const more = async () => {
    const cur = await C.getCustomer(id);
    const links = await C.customerLinks(id);
    actionSheet(cur.name, [
      { label: 'Edit', icon: 'edit', onSelect: () => openCustomerForm(cur) },
      cur.archived_at ? { label: 'Restore from archive', icon: 'archive', onSelect: async () => { await C.restoreCustomer(id); toast('Customer restored'); } } : null,
      { label: links.invoices + links.quotations ? 'Archive customer' : 'Delete customer', icon: links.invoices + links.quotations ? 'archive' : 'trash', danger: true,
        hint: links.invoices + links.quotations ? `${links.invoices} invoices and ${links.quotations} quotations stay intact` : 'No documents reference this customer',
        onSelect: async () => {
          const archiving = links.invoices + links.quotations > 0;
          if (!(await confirmDialog({ title: archiving ? 'Archive customer?' : 'Delete customer?', message: archiving ? 'Financial history is preserved: existing documents keep their customer. The customer is hidden from lists and pickers.' : 'This customer has no documents and will be removed.', confirmLabel: archiving ? 'Archive' : 'Delete', danger: true }))) return;
          try { const r = await C.removeCustomer(id); toast(r === 'archived' ? 'Customer archived' : 'Customer deleted'); if (r === 'deleted') navigate('/customers', { replace: true }); } catch (e) { toastError(e); }
        } },
    ]);
  };
  return { title: c?.name || 'Customer', el: host, actions: c ? [iconButton('edit', { title: 'Edit', onClick: async () => openCustomerForm(await C.getCustomer(id)) }), iconButton('more', { title: 'More', onClick: more })] : [] };
}
