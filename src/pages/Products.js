import { h, icon, card, emptyState, errorState, loadingList, searchBar, chips, iconButton, busy, replace, badge } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet, promptDialog } from '../components/Modal.js';
import { field, textInput, textArea, selectInput, moneyInput, rateInput, toggle, showErrors, currencyOptions } from '../components/Input.js';
import * as P from '../services/productService.js';
import { getBusinessProfile } from '../services/settingsService.js';
import { businessTabs } from './Invoices.js';
import { saveFile } from '../app/platform.js';
import { formatMoney, formatRate, todayISO } from '../utils/formatting.js';
import { parseRate } from '../utils/calculations.js';

export async function openProductForm(existing = null) {
  const profile = await getBusinessProfile();
  const categories = await P.listCategories();
  let currency = existing?.currency || profile.default_currency;
  const f = {
    name: textInput({ name: 'name', value: existing?.name, placeholder: 'e.g. Website design, Coffee beans 1kg' }),
    kind: selectInput({ name: 'kind', value: existing?.kind || 'product', options: [['product', 'Physical product'], ['service', 'Service']] }),
    sku: textInput({ name: 'sku', value: existing?.sku, placeholder: 'Optional' }),
    category: textInput({ name: 'category', value: existing?.category, placeholder: 'e.g. Hardware' }),
    unit: textInput({ name: 'unit', value: existing?.unit || 'pcs', placeholder: 'pcs, h, kg…' }),
    currency: selectInput({ name: 'currency', value: currency, options: currencyOptions() }),
    unit_price_minor: moneyInput({ name: 'unit_price_minor', valueMinor: existing?.unit_price_minor ?? null, currency }),
    tax_rate_bp: rateInput({ name: 'tax_rate_bp', valueBp: existing?.tax_rate_bp ?? profile.default_tax_rate_bp }),
    description: textArea({ name: 'description', value: existing?.description, rows: 2 }),
  };
  const dl = h('datalist', { id: 'lx-cats' }, categories.map((c) => h('option', { value: c })));
  f.category.setAttribute('list', 'lx-cats');
  f.currency.addEventListener('change', () => { currency = f.currency.value; f.unit_price_minor.setCurrency(currency); });
  f.kind.addEventListener('change', () => { if (f.kind.value === 'service' && f.unit.value === 'pcs') f.unit.value = 'h'; });
  let active = existing ? !!existing.is_active : true;
  const body = h('div', { class: 'form-grid two' }, dl,
    field('Name', f.name, { name: 'name', span: true }), field('Type', f.kind, { name: 'kind' }), field('SKU', f.sku, { name: 'sku' }),
    field('Category', f.category, { name: 'category' }), field('Unit', f.unit, { name: 'unit' }),
    field('Unit price', f.unit_price_minor, { name: 'unit_price_minor' }), field('Currency', f.currency, { name: 'currency' }),
    field('Tax rate %', f.tax_rate_bp, { name: 'tax_rate_bp' }), h('div', { class: 'field' }, h('label', ' '), toggle({ checked: active, label: 'Active', hint: 'Inactive items are hidden from the invoice catalog', onChange: (v) => { active = v; } })),
    field('Description', f.description, { name: 'description', span: true }));
  return openSheet({
    title: existing ? 'Edit product' : 'New product or service', body,
    footer: (close) => {
      const save = h('button', { class: 'btn primary' }, icon('check'), 'Save');
      save.addEventListener('click', busy(save, async () => {
        const data = {
          name: f.name.value, kind: f.kind.value, sku: f.sku.value, category: f.category.value, unit: f.unit.value, currency: f.currency.value,
          unit_price_minor: f.unit_price_minor.minor, tax_rate_bp: f.tax_rate_bp.bp ?? 0, description: f.description.value, is_active: active,
        };
        if (data.unit_price_minor === null) { showErrors(body, { unit_price_minor: 'Enter a valid price' }); return; }
        try {
          const r = existing ? await P.updateProduct(existing.id, data) : await P.createProduct(data);
          toast(existing ? 'Product updated' : 'Product added');
          close(r);
        } catch (e) {
          const errs = e.errors || (/UNIQUE.*sku/i.test(e.message) ? { sku: 'This SKU is already used' } : {});
          if (!showErrors(body, errs)) toastError(e);
        }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'), save];
    },
  });
}

const st = { search: '', category: '', kind: '' };

export async function ProductsPage(_p, ctx) {
  const listHost = h('div', loadingList(5));
  const filterHost = h('div', { class: 'stack', style: { gap: '8px' } });
  async function load() {
    try {
      const [rows, cats] = await Promise.all([P.listProducts(st), P.listCategories()]);
      if (!ctx.isCurrent()) return;
      replace(filterHost,
        chips([['', 'All types'], ['product', 'Products'], ['service', 'Services']], st.kind, (v) => { st.kind = v; load(); }),
        cats.length ? chips([['', 'All categories'], ...cats.map((c) => [c, c])], st.category, (v) => { st.category = v; load(); }) : null);
      if (!rows.length) {
        replace(listHost, card(emptyState(st.search || st.category || st.kind ? { art: 'search', title: 'No matches', text: 'Adjust the search or filters.' }
          : { art: 'box', title: 'Your catalog is empty', text: 'Add products and services once, then drop them into invoices with the right price and tax.', action: h('button', { class: 'btn primary', onclick: () => openProductForm() }, icon('plus'), 'Add product') })));
        return;
      }
      replace(listHost, card(h('div', { class: 'list' }, rows.map((p) => h('button', { class: 'list-item', onclick: () => productActions(p) },
        h('div', { class: ['avatar', p.kind === 'service' ? 'alt' : ''] }, icon(p.kind === 'service' ? 'zap' : 'box')),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, p.name), h('div', { class: 'secondary' }, [p.sku, p.category, `per ${p.unit}`, p.tax_rate_bp ? `tax ${formatRate(p.tax_rate_bp)}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, h('b', { class: 'num' }, formatMoney(p.unit_price_minor, p.currency)), p.is_active ? null : badge('draft', 'Inactive')))))));
    } catch (e) { replace(listHost, errorState(e, load)); }
  }
  function productActions(p) {
    actionSheet(p.name, [
      { label: 'Edit', icon: 'edit', onSelect: () => openProductForm(p) },
      { label: p.is_active ? 'Mark inactive' : 'Mark active', icon: 'refresh', onSelect: async () => { await P.updateProduct(p.id, { is_active: !p.is_active }); toast('Updated'); } },
      { label: 'Delete', icon: 'trash', danger: true, hint: 'Existing invoices keep their line descriptions and prices', onSelect: async () => {
        if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: 'Invoices that used it are unaffected.', confirmLabel: 'Delete', danger: true }))) return;
        await P.deleteProduct(p.id); toast('Product deleted');
      } },
    ]);
  }
  async function bulkPrice() {
    const rows = await P.listProducts(st);
    if (!rows.length) return;
    const v = await promptDialog({ title: `Adjust ${rows.length} price${rows.length > 1 ? 's' : ''}`, label: 'Percentage change (e.g. 5 or -10)', placeholder: '5', confirmLabel: 'Apply',
      validate: (x) => { const n = parseRate(x.replace(/^\+/, '')); return n === null || Math.abs(n) > 100000 ? 'Enter a percentage' : null; } });
    if (v === null) return;
    const neg = v.trim().startsWith('-');
    const bp = parseRate(v.replace(/^[+-]/, ''));
    if (!(await confirmDialog({ title: 'Apply price change?', message: `${rows.length} visible product(s) will change by ${neg ? '−' : '+'}${formatRate(bp)}. Existing invoices are not affected.`, confirmLabel: 'Apply' }))) return;
    await P.adjustPrices(rows.map((r) => r.id), neg ? -bp : bp);
    toast('Prices updated');
  }
  ctx.onData(load);
  load();
  return {
    title: 'Products & services',
    el: h('div', { class: 'stack' }, businessTabs('products'), searchBar('Search name, SKU, description', st.search, (v) => { st.search = v; load(); }), filterHost, listHost),
    actions: [
      iconButton('more', { title: 'Catalog actions', onClick: () => actionSheet('Catalog', [
        { label: 'Export as CSV', icon: 'download', onSelect: async () => { try { const r = await saveFile(`ledgerx-products-${todayISO()}.csv`, await P.exportProductsCSV(), 'text/csv', { share: true }); toast(`Exported to ${r.location}`); } catch (e) { toastError(e); } } },
        { label: 'Adjust prices of visible items', icon: 'sort', onSelect: bulkPrice },
      ]) }),
      iconButton('plus', { title: 'Add product', onClick: () => openProductForm() }),
    ],
  };
}
