import { h, icon, card, sectionTitle, badge, iconButton, busy, replace, infoState, avatar } from '../components/ui.js';
import { openSheet, actionSheet, confirmDialog, toast, toastError } from '../components/Modal.js';
import { field, moneyInput, dateInput, textInput, selectInput, showErrors } from '../components/Input.js';
import { navigate, back } from '../app/router.js';
import * as D from '../services/invoiceService.js';
import { getBusinessProfile } from '../services/settingsService.js';
import { buildDocumentPdf, renderPdfPreview } from '../services/pdfService.js';
import { saveFile } from '../app/platform.js';
import { formatMoney, formatDate, formatQuantity, formatRate, STATUS_LABELS, todayISO } from '../utils/formatting.js';

async function makePdf(kind, id) {
  const [doc, profile] = await Promise.all([D.getDocument(kind, id), getBusinessProfile()]);
  const bytes = await buildDocumentPdf(kind, doc, profile);
  const safe = `${kind === 'invoice' ? 'Invoice' : 'Quotation'}-${doc.number}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  return { bytes, fileName: `${safe}.pdf`, doc };
}

export async function openPdfPreview(kind, id) {
  const host = h('div', { class: 'pdf-pages' }, h('div', { class: 'spinner', style: { margin: '40px auto' } }));
  let made = null;
  const shareBtn = h('button', { class: 'btn primary' }, icon('share'), 'Share PDF');
  const saveBtn = h('button', { class: 'btn' }, icon('download'), 'Save');
  shareBtn.addEventListener('click', busy(shareBtn, async () => {
    try { const r = await saveFile(made.fileName, made.bytes, 'application/pdf', { share: true, title: made.fileName }); toast(r.location === 'shared' ? 'Shared' : `Saved to ${r.location}`); } catch (e) { toastError(e); }
  }));
  saveBtn.addEventListener('click', busy(saveBtn, async () => {
    try { const r = await saveFile(made.fileName, made.bytes, 'application/pdf'); toast(`Saved to ${r.location}`); } catch (e) { toastError(e); }
  }));
  shareBtn.disabled = saveBtn.disabled = true;
  const p = openSheet({ title: 'PDF preview', full: true, body: host, footer: [saveBtn, shareBtn] });
  try {
    made = await makePdf(kind, id);
    await renderPdfPreview(made.bytes, host);
    shareBtn.disabled = saveBtn.disabled = false;
  } catch (e) {
    replace(host, h('div', { class: 'state-error' }, icon('alert'), `Could not render the preview: ${e.message}`));
    if (made) shareBtn.disabled = saveBtn.disabled = false;
  }
  return p;
}

export async function openPaymentForm(inv) {
  const balance = inv.total_minor - inv.paid_minor;
  const amount = moneyInput({ name: 'amount', valueMinor: balance, currency: inv.currency });
  const date = dateInput({ name: 'paid_at', value: todayISO() });
  const method = selectInput({ name: 'method', value: 'Bank transfer', options: ['Bank transfer', 'Card', 'Cash', 'Cheque', 'Online', 'Other'].map((m) => [m, m]) });
  const ref = textInput({ name: 'reference', placeholder: 'Transaction reference (optional)' });
  const body = h('div', { class: 'form-grid two' },
    field(`Amount (${inv.currency})`, amount, { name: 'amount', hint: `Outstanding ${formatMoney(balance, inv.currency)}` }), field('Date', date),
    field('Method', method), field('Reference', ref));
  return openSheet({
    title: `Record payment · ${inv.number}`, body,
    footer: (close) => {
      const b = h('button', { class: 'btn primary' }, icon('check'), 'Record payment');
      b.addEventListener('click', busy(b, async () => {
        try {
          const r = await D.recordPayment(inv.id, { amount_minor: amount.minor, paid_at: `${date.value}T12:00:00.000Z`, method: method.value, reference: ref.value.trim() });
          toast(r.status === 'paid' ? 'Invoice fully paid' : 'Payment recorded');
          close(true);
        } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'), b];
    },
  });
}

export async function DocumentViewPage({ id, kind }, ctx) {
  const isInvoice = kind === 'invoice';
  const base = isInvoice ? '/invoices' : '/quotations';
  const host = h('div', { class: 'stack-lg' });

  async function render() {
    const doc = await D.getDocument(kind, id);
    if (!doc || doc.deleted_at) {
      replace(host, card(h('div', { class: 'card-body' }, infoState('This document was deleted.'), h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => navigate(base) }, 'Back to list'))));
      return doc;
    }
    const cur = doc.currency;
    const f = (v) => formatMoney(v, cur);
    const c = doc.customer || doc.customer_snapshot || {};
    const paidPct = doc.total_minor ? Math.min(100, Math.round((doc.paid_minor / doc.total_minor) * 100)) : 0;
    const balance = doc.total_minor - (doc.paid_minor || 0);

    const primary = [];
    if (isInvoice && !['draft', 'paid', 'cancelled'].includes(doc.status) && balance > 0) primary.push(h('button', { class: 'btn success', onclick: async () => { if (await openPaymentForm(doc)) render(); } }, icon('wallet'), 'Record payment'));
    if (isInvoice && doc.status === 'draft') primary.push(h('button', { class: 'btn primary', onclick: async () => { await D.setStatus('invoice', id, 'pending'); toast('Invoice issued'); render(); } }, icon('check'), 'Issue invoice'));
    if (!isInvoice && !doc.converted_invoice_id && !['rejected', 'expired'].includes(doc.status)) primary.push(h('button', { class: 'btn primary', onclick: async () => {
      if (!(await confirmDialog({ title: 'Convert to invoice?', message: 'A new invoice is created from this quotation. The quotation is kept and marked as accepted, with a link to the invoice.', confirmLabel: 'Convert' }))) return;
      try { const invId = await D.convertQuotationToInvoice(id); toast('Invoice created'); navigate(`/invoices/${invId}`); } catch (e) { toastError(e); }
    } }, icon('invoice'), 'Convert to invoice'));
    primary.push(h('button', { class: 'btn', onclick: () => openPdfPreview(kind, id) }, icon('file'), 'PDF'));

    replace(host,
      card(h('div', { class: 'card-body stack' },
        h('div', { class: 'doc-head' },
          h('div', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'caps' }, isInvoice ? 'Invoice' : 'Quotation'), h('h2', { style: { fontSize: '20px' } }, doc.number)),
          badge(doc.status, STATUS_LABELS[doc.status])),
        h('div', { class: 'doc-amount' }, f(doc.total_minor)),
        isInvoice && doc.status !== 'draft' ? h('div', { class: 'stack', style: { gap: '6px' } },
          h('div', { class: 'progress' }, h('div', { style: { width: `${paidPct}%` } })),
          h('div', { class: 'row between muted', style: { fontSize: '12.5px' } }, h('span', `${f(doc.paid_minor)} paid`), h('span', balance > 0 ? `${f(balance)} due` : 'Settled'))) : null,
        h('dl', { class: 'kv' },
          h('dt', 'Issued'), h('dd', formatDate(doc.issue_date)),
          h('dt', isInvoice ? 'Due' : 'Valid until'), h('dd', formatDate(isInvoice ? doc.due_date : doc.expiry_date)),
          doc.quotation ? [h('dt', 'From quotation'), h('dd', h('a', { href: `#/quotations/${doc.quotation.id}` }, doc.quotation.number))] : null,
          doc.invoice ? [h('dt', 'Converted to'), h('dd', h('a', { href: `#/invoices/${doc.invoice.id}` }, doc.invoice.number))] : null),
        h('div', { class: 'row wrap' }, primary))),

      card(h('button', { class: 'list-item', onclick: () => doc.customer_id && navigate(`/customers/${doc.customer_id}`) }, avatar(c.name || '?'),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, c.name || 'Unknown customer'), h('div', { class: 'secondary' }, [c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details')),
        doc.customer?.archived_at ? badge('draft', 'Archived') : icon('chevronRight', 'chev'))),

      h('div', null, sectionTitle(`Items (${doc.items.length})`),
        card(h('div', { class: 'list' }, doc.items.map((it) => h('div', { class: 'list-item', style: { alignItems: 'flex-start' } },
          h('div', { class: 'grow' }, h('div', { class: 'primary', style: { whiteSpace: 'normal' } }, it.description),
            h('div', { class: 'secondary' }, `${formatQuantity(it.quantity_milli)}${it.unit ? ` ${it.unit}` : ''} × ${f(it.unit_price_minor)}${it.tax_rate_bp ? ` · tax ${formatRate(it.tax_rate_bp)}` : ''}${it.line_discount_minor ? ` · −${f(it.line_discount_minor)}` : ''}`)),
          h('b', { class: 'num' }, f(it.line_subtotal_minor - it.line_discount_minor))))),
        h('div', { class: 'card-body', style: { borderTop: '1px solid var(--border)' } }, h('div', { class: 'totals' },
          h('div', { class: 'r' }, h('span', 'Subtotal'), h('b', f(doc.subtotal_minor))),
          doc.discount_minor ? h('div', { class: 'r' }, h('span', 'Discounts'), h('b', `−${f(doc.discount_minor)}`)) : null,
          doc.tax_breakdown.filter((b) => b.rate_bp).map((b) => h('div', { class: 'r' }, h('span', `Tax ${formatRate(b.rate_bp)}`), h('b', f(b.tax_minor)))),
          h('div', { class: 'r grand' }, h('span', 'Total'), h('b', f(doc.total_minor))))))),

      isInvoice ? h('div', null, sectionTitle(`Payments (${doc.payments.length})`),
        doc.payments.length ? card(h('div', { class: 'list' }, doc.payments.map((p) => h('div', { class: 'list-item' },
          h('div', { class: 'avatar alt' }, icon('wallet')),
          h('div', { class: 'grow' }, h('div', { class: 'primary' }, f(p.amount_minor)), h('div', { class: 'secondary' }, `${formatDate(p.paid_at)} · ${p.method || 'Payment'}${p.reference ? ` · ${p.reference}` : ''}`)),
          iconButton('trash', { title: 'Reverse payment', onClick: async () => {
            if (!(await confirmDialog({ title: 'Reverse this payment?', message: `${f(p.amount_minor)} will be removed and the invoice balance recalculated. The reversal is kept in the audit log.`, confirmLabel: 'Reverse', danger: true }))) return;
            await D.deletePayment(p.id); toast('Payment reversed'); render();
          } })))))
          : card(h('div', { class: 'card-body muted' }, 'No payments recorded yet.'))) : null,

      doc.notes || doc.terms ? card(h('div', { class: 'card-body stack' },
        doc.notes ? h('div', null, h('div', { class: 'caps' }, 'Notes'), h('p', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, doc.notes)) : null,
        doc.terms ? h('div', null, h('div', { class: 'caps' }, 'Terms'), h('p', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, doc.terms)) : null)) : null);
    return doc;
  }

  const doc = await render();
  ctx.onData(render);

  const more = async () => {
    const d = await D.getDocument(kind, id);
    const statuses = (isInvoice ? ['draft', 'pending', 'cancelled'] : D.QUOTATION_STATUSES).filter((s) => s !== d.status);
    actionSheet(d.number, [
      { label: 'Edit', icon: 'edit', onSelect: () => navigate(`${base}/${id}/edit`) },
      { label: 'Preview & share PDF', icon: 'share', onSelect: () => openPdfPreview(kind, id) },
      { label: 'Duplicate', icon: 'copy', onSelect: async () => { const nid = await D.duplicateDocument(kind, id); toast('Duplicated as draft'); navigate(`${base}/${nid}`); } },
      { label: 'Change status', icon: 'refresh', hint: `Currently ${STATUS_LABELS[d.status]}`, onSelect: () => actionSheet('Set status', statuses.map((s) => ({ label: STATUS_LABELS[s], icon: 'chevronRight', onSelect: async () => {
        if (s === 'cancelled' && !(await confirmDialog({ title: 'Cancel invoice?', message: 'The invoice stays on record (with any payments) but no longer counts as outstanding.', confirmLabel: 'Cancel invoice', danger: true }))) return;
        try { await D.setStatus(kind, id, s); toast('Status updated'); render(); } catch (e) { toastError(e); }
      } }))) },
      { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
        if (isInvoice && d.paid_minor > 0) { toastError(new Error('This invoice has payments — cancel it instead to preserve financial history.')); return; }
        if (!(await confirmDialog({ title: `Delete ${d.number}?`, message: 'The document is removed from lists. Deletion is synchronised to your other devices.', confirmLabel: 'Delete', danger: true }))) return;
        try { await D.deleteDocument(kind, id); toast('Deleted'); navigate(base, { replace: true }); } catch (e) { toastError(e); }
      } },
    ]);
  };

  return {
    title: doc?.number || 'Document', el: host,
    actions: doc && !doc.deleted_at ? [iconButton('edit', { title: 'Edit', onClick: () => navigate(`${base}/${id}/edit`) }), iconButton('more', { title: 'More actions', onClick: more })] : [],
  };
}
