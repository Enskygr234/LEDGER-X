import { h, icon, card, sectionTitle, replace, iconButton, busy, searchBar, emptyState } from '../components/ui.js';
import { openSheet, toast, toastError, confirmDialog } from '../components/Modal.js';
import { field, textInput, textArea, selectInput, dateInput, moneyInput, quantityInput, rateInput, showErrors, currencyOptions } from '../components/Input.js';
import { navigate, setGuard, back } from '../app/router.js';
import { getDocument, saveDocument } from '../services/invoiceService.js';
import { listCustomers } from '../services/customerService.js';
import { listProducts } from '../services/productService.js';
import { getBusinessProfile, listTaxRates } from '../services/settingsService.js';
import { computeDocument, currencyDigits, toDecimalString, parseRate, parseMoney } from '../utils/calculations.js';
import { formatMoney, formatRate, todayISO, addDaysISO } from '../utils/formatting.js';
import { openCustomerForm } from './Customers.js';

export async function DocumentEditorPage({ id, kind, customer, quotation }, ctx) {
  const isInvoice = kind === 'invoice';
  const base = isInvoice ? '/invoices' : '/quotations';
  const dateField = isInvoice ? 'due_date' : 'expiry_date';
  const profile = await getBusinessProfile();
  const existing = id ? await getDocument(kind, id) : null;
  if (id && (!existing || existing.deleted_at)) throw new Error(`${isInvoice ? 'Invoice' : 'Quotation'} not found`);
  const taxRates = await listTaxRates();
  const defaultTax = taxRates.find((t) => t.is_default)?.rate_bp ?? profile.default_tax_rate_bp ?? 0;
  let dirty = false;
  const markDirty = () => { dirty = true; };
  setGuard(async () => !dirty || confirmDialog({ title: 'Discard changes?', message: 'You have unsaved changes on this document.', confirmLabel: 'Discard', danger: true }));

  const doc = existing || {
    customer_id: customer || '', issue_date: todayISO(), [dateField]: addDaysISO(todayISO(), isInvoice ? 14 : 30),
    currency: profile.default_currency, status: 'draft', notes: '', terms: '', items: [],
  };
  let currency = doc.currency;

  // ---------------- header fields
  const customerSel = h('select', { class: 'select', 'data-name': 'customer_id', onchange: markDirty });
  async function loadCustomers(selectId) {
    const list = await listCustomers();
    const cur = existing?.customer && !list.some((c) => c.id === existing.customer.id) ? [existing.customer] : [];
    replace(customerSel, h('option', { value: '' }, 'Select a customer…'),
      [...cur, ...list].map((c) => h('option', { value: c.id, selected: c.id === (selectId || doc.customer_id) }, `${c.name}${c.archived_at ? ' (archived)' : ''}`)));
  }
  await loadCustomers();
  const newCustBtn = h('button', { class: 'btn', type: 'button', title: 'New customer', onclick: async () => {
    const c = await openCustomerForm();
    if (c) { await loadCustomers(c.id); markDirty(); }
  } }, icon('plus'));

  const number = textInput({ name: 'number', value: existing?.number || '', placeholder: 'Assigned automatically' });
  const issue = dateInput({ name: 'issue_date', value: doc.issue_date });
  const due = dateInput({ name: dateField, value: doc[dateField] });
  const curSel = selectInput({ name: 'currency', value: currency, options: currencyOptions() });
  const statuses = isInvoice ? [['draft', 'Draft'], ['pending', 'Issued (pending)'], ['cancelled', 'Cancelled']] : [['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['rejected', 'Rejected']];
  const curStatus = isInvoice && existing && !['draft', 'cancelled'].includes(existing.status) ? 'pending' : doc.status;
  const statusSel = selectInput({ name: 'status', value: curStatus, options: statuses });
  const notes = textArea({ name: 'notes', value: doc.notes, placeholder: 'Visible on the document, e.g. thank-you note' });
  const terms = textArea({ name: 'terms', value: doc.terms, placeholder: 'Payment terms, bank details override, legal notes', rows: 2 });

  // ---------------- lines
  const lines = [];
  const linesHost = h('div', { class: 'stack' });
  const totalsHost = h('div', { class: 'totals' });
  const taxOpts = () => [...new Map([[0, 'No tax'], ...taxRates.map((t) => [t.rate_bp, `${t.name} (${formatRate(t.rate_bp)})`]), [defaultTax, formatRate(defaultTax)]]).entries()];

  function addLine(item = {}) {
    const ln = { id: item.id || null, product_id: item.product_id || null };
    ln.desc = textInput({ name: 'description', value: item.description || '', placeholder: 'Description' });
    ln.unit = item.unit || '';
    ln.qty = quantityInput({ name: 'qty', valueMilli: item.quantity_milli ?? 1000 });
    ln.price = moneyInput({ name: 'price', valueMinor: item.unit_price_minor ?? null, currency });
    ln.dtype = selectInput({ name: 'dtype', value: item.discount_type || 'none', options: [['none', 'No discount'], ['percent', '% off'], ['amount', 'Amount off']] });
    const dv = item.discount_type === 'percent' ? toDecimalString(item.discount_value, 2) : item.discount_type === 'amount' ? toDecimalString(item.discount_value, currencyDigits(currency)) : '';
    ln.dval = h('input', { class: 'input num', inputmode: 'decimal', value: dv.replace(/\.?0+$/, ''), placeholder: '0' });
    ln.tax = rateInput({ name: 'tax', valueBp: item.tax_rate_bp ?? defaultTax });
    ln.taxPick = h('select', { class: 'select', 'aria-label': 'Tax preset', style: { width: '44px', padding: '0 0 0 6px', backgroundImage: 'none', textAlign: 'center' },
      onchange: (e) => { if (e.target.value !== '') { ln.tax.value = toDecimalString(Number(e.target.value), 2).replace(/\.?0+$/, ''); e.target.value = ''; recalc(); } } },
    h('option', { value: '' }, '▾'), taxOpts().map(([bp, label]) => h('option', { value: bp }, label)));
    ln.total = h('b');
    const sync = () => { ln.dval.disabled = ln.dtype.value === 'none'; };
    ln.dtype.addEventListener('change', () => { sync(); recalc(); });
    sync();
    ln.el = h('div', { class: 'line-card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, ln.desc), iconButton('trash', { title: 'Remove line', onClick: () => { lines.splice(lines.indexOf(ln), 1); ln.el.remove(); markDirty(); recalc(); } })),
      h('div', { class: 'line-grid four' },
        field('Quantity', ln.qty), field('Unit price', ln.price),
        field('Tax %', h('div', { class: 'input-group' }, ln.tax, ln.taxPick))),
      h('div', { class: 'line-grid', style: { gridTemplateColumns: '1fr 1fr' } }, field('Discount', ln.dtype), field('Value', ln.dval)),
      h('div', { class: 'line-total' }, h('span', ln.unit ? `per ${ln.unit}` : ''), h('span', 'Line total ', ln.total)));
    ln.el.addEventListener('input', () => { markDirty(); recalc(); });
    lines.push(ln);
    linesHost.appendChild(ln.el);
    return ln;
  }

  function readLine(ln) {
    const dtype = ln.dtype.value;
    let dval = 0;
    if (dtype === 'percent') dval = parseRate(ln.dval.value || '0') ?? NaN;
    if (dtype === 'amount') dval = parseMoney(ln.dval.value || '0', currency) ?? NaN;
    return {
      id: ln.id, product_id: ln.product_id, description: ln.desc.value.trim(), unit: ln.unit || null,
      quantity_milli: ln.qty.milli, unit_price_minor: ln.price.minor, discount_type: dtype, discount_value: Number.isFinite(dval) ? dval : NaN, tax_rate_bp: ln.tax.bp ?? 0,
    };
  }

  function recalc() {
    const items = [];
    for (const ln of lines) {
      const it = readLine(ln);
      const valid = it.quantity_milli > 0 && it.unit_price_minor !== null && it.unit_price_minor >= 0 && Number.isSafeInteger(it.discount_value) && it.discount_value >= 0;
      try { ln.total.textContent = valid ? formatMoney(computeDocument([it]).total_minor, currency) : '—'; } catch { ln.total.textContent = '—'; }
      if (valid) items.push(it);
    }
    let t;
    try { t = computeDocument(items); } catch { t = computeDocument([]); }
    const f = (v) => formatMoney(v, currency);
    replace(totalsHost,
      h('div', { class: 'r' }, h('span', 'Subtotal'), h('b', f(t.subtotal_minor))),
      t.discount_minor ? h('div', { class: 'r' }, h('span', 'Discounts'), h('b', `−${f(t.discount_minor)}`)) : null,
      t.tax_breakdown.filter((b) => b.rate_bp > 0).map((b) => h('div', { class: 'r' }, h('span', `Tax ${formatRate(b.rate_bp)} on ${f(b.base_minor)}`), h('b', f(b.tax_minor)))),
      h('div', { class: 'r grand' }, h('span', 'Total'), h('b', f(t.total_minor))),
      existing?.paid_minor ? h('div', { class: 'r' }, h('span', 'Already paid'), h('b', f(existing.paid_minor))) : null);
  }

  curSel.addEventListener('change', () => {
    // Typed amounts keep their meaning; they are re-read in the new currency's minor units.
    currency = curSel.value;
    for (const ln of lines) ln.price.setCurrency(currency);
    markDirty(); recalc();
  });

  async function pickProduct() {
    const all = await listProducts({ activeOnly: true });
    await openSheet({
      title: 'Add from catalog',
      body: (close) => {
        const listEl = h('div', { class: 'list' });
        const paint = (q) => {
          const rows = all.filter((p) => !q || `${p.name} ${p.sku || ''} ${p.category || ''}`.toLowerCase().includes(q.toLowerCase()));
          replace(listEl, rows.length ? rows.map((p) => h('button', { class: 'list-item', onclick: () => {
            const blank = lines.find((l) => !l.desc.value.trim());
            if (blank) { blank.el.remove(); lines.splice(lines.indexOf(blank), 1); }
            addLine({ product_id: p.id, description: p.name, unit: p.unit, quantity_milli: 1000, unit_price_minor: p.currency === currency ? p.unit_price_minor : null, tax_rate_bp: p.tax_rate_bp });
            if (p.currency !== currency) toast(`${p.name} is priced in ${p.currency}; enter a ${currency} price`, { type: 'info' });
            markDirty(); recalc(); close();
          } }, h('div', { class: ['avatar', p.kind === 'service' ? 'alt' : ''] }, icon(p.kind === 'service' ? 'zap' : 'box')),
          h('div', { class: 'grow' }, h('div', { class: 'primary' }, p.name), h('div', { class: 'secondary' }, [p.sku, p.category, `per ${p.unit}`].filter(Boolean).join(' · '))),
          h('b', { class: 'num' }, formatMoney(p.unit_price_minor, p.currency))))
            : emptyState({ art: 'box', title: all.length ? 'No matches' : 'Catalog is empty', text: all.length ? 'Try another search.' : 'Add products and services in the Products tab.' }));
        };
        paint('');
        return h('div', { class: 'stack' }, searchBar('Search catalog', '', paint), h('div', { class: 'card' }, listEl));
      },
    });
  }

  if (doc.items?.length) for (const it of doc.items) addLine(it); else addLine();
  recalc();

  const form = h('form', { class: 'stack-lg', novalidate: true, onsubmit: (e) => e.preventDefault(), oninput: markDirty, onchange: markDirty },
    card(h('div', { class: 'card-body form-grid two' },
      field('Customer', h('div', { class: 'row' }, h('div', { class: 'grow' }, customerSel), newCustBtn), { name: 'customer_id', span: true }),
      field(isInvoice ? 'Invoice number' : 'Quotation number', number, { name: 'number', hint: existing ? null : 'Leave empty to use the next number' }),
      field('Status', statusSel, { name: 'status', hint: isInvoice ? 'Paid / overdue are set automatically from payments and due date' : null }),
      field('Issue date', issue, { name: 'issue_date' }),
      field(isInvoice ? 'Due date' : 'Valid until', due, { name: dateField }),
      field('Currency', curSel, { name: 'currency', span: true }))),
    h('div', null, sectionTitle('Items', h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', onclick: pickProduct }, icon('box'), 'Catalog'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { addLine(); markDirty(); recalc(); } }, icon('plus'), 'Line'))),
    h('div', { class: 'error', 'data-error-for': 'items', style: { margin: '0 2px 8px', color: 'var(--danger)', fontSize: '12.5px' } }),
    linesHost),
    card(h('div', { class: 'card-body' }, totalsHost)),
    card(h('div', { class: 'card-body form-grid' }, field('Notes', notes, { name: 'notes' }), field('Terms', terms, { name: 'terms' }))));

  const saveBtn = h('button', { class: 'btn primary lg block', type: 'button' }, icon('check'), existing ? 'Save changes' : `Create ${isInvoice ? 'invoice' : 'quotation'}`);
  saveBtn.addEventListener('click', busy(saveBtn, async () => {
    const items = lines.map(readLine);
    const bad = items.findIndex((it) => it.unit_price_minor === null || it.quantity_milli === null || !Number.isSafeInteger(it.discount_value));
    if (bad >= 0) { showErrors(form, { items: `Line ${bad + 1}: check quantity, price and discount` }); lines[bad].el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    try {
      const savedId = await saveDocument(kind, {
        id: existing?.id, number: number.value.trim() || undefined, customer_id: customerSel.value, issue_date: issue.value,
        [dateField]: due.value || null, currency, status: statusSel.value, notes: notes.value, terms: terms.value, items, quotation_id: quotation || undefined,
      });
      dirty = false;
      setGuard(null);
      toast(existing ? 'Changes saved' : `${isInvoice ? 'Invoice' : 'Quotation'} created`);
      navigate(`${base}/${savedId}`, { replace: true });
    } catch (e) {
      if (!showErrors(form, e.errors || {})) toastError(e);
      else if (e.errors?.items) form.querySelector('[data-error-for="items"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }));
  form.appendChild(saveBtn);
  dirty = false;

  return {
    title: existing ? `Edit ${existing.number}` : (isInvoice ? 'New invoice' : 'New quotation'),
    el: form, hideFab: true,
    actions: [iconButton('x', { title: 'Cancel', onClick: () => back(base) })],
  };
}
