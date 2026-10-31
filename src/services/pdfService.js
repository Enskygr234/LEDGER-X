/**
 * Invoice / quotation PDF generation with pdf-lib (runs fully offline).
 * Preview is rendered with PDF.js onto canvases (Android WebView cannot show
 * PDFs inline).
 *
 * Note: the built-in Helvetica font covers Latin-1 (WinAnsi). Characters
 * outside it are transliterated (e.g. ş→s, ₺→TRY). For full Unicode output,
 * add @pdf-lib/fontkit and embed a TTF — see docs/ARCHITECTURE.md.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatQuantity, formatRate, formatDate, STATUS_LABELS } from '../utils/formatting.js';
import { currencyDigits, toDecimalString, computeDocument } from '../utils/calculations.js';

const INK = rgb(0.09, 0.125, 0.2);
const MUTED = rgb(0.4, 0.44, 0.52);
const LINE = rgb(0.89, 0.9, 0.93);
const ACCENT = rgb(0.32, 0.435, 1);
const ACCENT_2 = rgb(0.06, 0.66, 0.52);
const SOFT = rgb(0.965, 0.972, 0.985);

const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const MAP = { 'ı': 'i', 'İ': 'I', 'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', '₺': 'TRY ', '₹': 'INR ', '₽': 'RUB ', '₩': 'KRW ', '₦': 'NGN ', '₱': 'PHP ', '₫': 'VND ', '₴': 'UAH ', '₪': 'ILS ', ' ': ' ', ' ': ' ', '−': '-', '→': '->', '≈': '~' };
export function pdfSafe(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) { out += ch; continue; }
    if (ch === '\n' || ch === '\t') { out += ch; continue; }
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += [...base].every((b) => b.codePointAt(0) < 0x100) ? base : '?';
  }
  return out;
}

function money(minor, currency) {
  const digits = currencyDigits(currency);
  const dec = toDecimalString(minor, digits);
  try {
    return pdfSafe(new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dec));
  } catch { return `${currency} ${dec}`; }
}

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) line = test;
      else {
        if (line) out.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--;
          out.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
    }
    out.push(line);
  }
  return out;
}

async function embedLogo(pdf, dataUrl) {
  if (!dataUrl) return null;
  try {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    return dataUrl.startsWith('data:image/png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch { return null; }
}

/**
 * Build the PDF. `doc` comes from invoiceService.getDocument().
 * Returns Uint8Array.
 */
export async function buildDocumentPdf(kind, doc, profile) {
  const pdf = await PDFDocument.create();
  const isInvoice = kind === 'invoice';
  pdf.setTitle(pdfSafe(`${isInvoice ? 'Invoice' : 'Quotation'} ${doc.number}`));
  pdf.setAuthor(pdfSafe(profile?.name || 'LEDGER X'));
  pdf.setCreator('LEDGER X');
  pdf.setProducer('LEDGER X (pdf-lib)');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 48;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const cur = doc.currency;
  const text = (t, x, yy, { size = 9.5, font = regular, color = INK, align = 'left', width } = {}) => {
    const s = pdfSafe(t);
    let xx = x;
    if (align === 'right') xx = x - font.widthOfTextAtSize(s, size);
    if (align === 'center') xx = x + ((width || 0) - font.widthOfTextAtSize(s, size)) / 2;
    page.drawText(s, { x: xx, y: yy, size, font, color });
  };
  const footer = () => {
    page.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.6, color: LINE });
    text(`${profile?.name || ''}${profile?.email ? ` · ${profile.email}` : ''}${profile?.website ? ` · ${profile.website}` : ''}`, M, 27, { size: 7.5, color: MUTED });
    text('Generated with LEDGER X', W - M, 27, { size: 7.5, color: MUTED, align: 'right' });
  };
  const ensure = (needed) => {
    if (y - needed < 64) { footer(); page = pdf.addPage([W, H]); y = H - M; return true; }
    return false;
  };

  // ---- Header band
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: ACCENT });
  const logo = await embedLogo(pdf, profile?.logo_data_url);
  let bx = M;
  if (logo) {
    const s = Math.min(46 / logo.height, 120 / logo.width);
    page.drawImage(logo, { x: M, y: y - logo.height * s + 6, width: logo.width * s, height: logo.height * s });
    bx = M + logo.width * s + 12;
  }
  text(profile?.name || 'Your business', bx, y - 8, { size: 15, font: bold });
  let hy = y - 24;
  for (const l of [profile?.legal_name, ...(profile?.address ? wrap(profile.address, regular, 8.5, 220) : []), [profile?.email, profile?.phone].filter(Boolean).join(' · '), profile?.tax_id ? `Tax ID: ${profile.tax_id}` : null].filter(Boolean)) {
    text(l, bx, hy, { size: 8.5, color: MUTED }); hy -= 11.5;
  }
  text(isInvoice ? 'INVOICE' : 'QUOTATION', W - M, y - 10, { size: 20, font: bold, color: INK, align: 'right' });
  text(doc.number, W - M, y - 26, { size: 10, color: MUTED, align: 'right' });
  const statusLabel = STATUS_LABELS[doc.status] || doc.status;
  const sw = bold.widthOfTextAtSize(statusLabel.toUpperCase(), 7.5) + 14;
  const statusColor = ['paid', 'accepted'].includes(doc.status) ? ACCENT_2 : ['overdue', 'rejected'].includes(doc.status) ? rgb(0.9, 0.28, 0.3) : ACCENT;
  page.drawRectangle({ x: W - M - sw, y: y - 45, width: sw, height: 14, color: statusColor, opacity: 0.12, borderColor: statusColor, borderWidth: 0.6, borderOpacity: 0.4 });
  page.drawText(pdfSafe(statusLabel.toUpperCase()), { x: W - M - sw + 7, y: y - 41, size: 7.5, font: bold, color: statusColor });
  y = Math.min(hy, y - 56) - 18;

  // ---- Parties & dates
  page.drawRectangle({ x: M, y: y - 78, width: W - 2 * M, height: 82, color: SOFT });
  const c = doc.customer_snapshot || doc.customer || {};
  text(isInvoice ? 'BILL TO' : 'PREPARED FOR', M + 14, y - 12, { size: 7.5, font: bold, color: MUTED });
  text(c.name || '—', M + 14, y - 27, { size: 11, font: bold });
  let cy = y - 40;
  for (const l of [...(c.address ? wrap(c.address, regular, 8.5, 240).slice(0, 2) : []), [c.email, c.phone].filter(Boolean).join(' · '), c.tax_id ? `Tax ID: ${c.tax_id}` : null].filter(Boolean)) {
    text(l, M + 14, cy, { size: 8.5, color: MUTED }); cy -= 11;
  }
  const dates = [
    ['Issue date', formatDate(doc.issue_date)],
    [isInvoice ? 'Due date' : 'Valid until', formatDate(isInvoice ? doc.due_date : doc.expiry_date)],
    ['Currency', cur],
  ];
  if (doc.quotation?.number) dates.push(['Quotation', doc.quotation.number]);
  dates.forEach(([k, v], i) => {
    text(k, W - M - 150, y - 14 - i * 15, { size: 8.5, color: MUTED });
    text(v, W - M - 14, y - 14 - i * 15, { size: 8.5, font: bold, align: 'right' });
  });
  y -= 104;

  // ---- Items table
  const cols = { desc: M, qty: M + 262, price: M + 345, tax: M + 405, total: W - M };
  const header = () => {
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.8, color: INK });
    text('DESCRIPTION', cols.desc, y - 8, { size: 7.5, font: bold, color: MUTED });
    text('QTY', cols.qty + 40, y - 8, { size: 7.5, font: bold, color: MUTED, align: 'right' });
    text('UNIT PRICE', cols.price + 46, y - 8, { size: 7.5, font: bold, color: MUTED, align: 'right' });
    text('TAX', cols.tax + 40, y - 8, { size: 7.5, font: bold, color: MUTED, align: 'right' });
    text('AMOUNT', cols.total, y - 8, { size: 7.5, font: bold, color: MUTED, align: 'right' });
    y -= 16;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
    y -= 4;
  };
  header();
  for (const it of doc.items) {
    const descLines = wrap(it.description, regular, 9.5, 250);
    const extra = it.line_discount_minor > 0 ? 1 : 0;
    const rowH = 10 + (descLines.length + extra) * 12;
    if (ensure(rowH + 10)) header();
    let ry = y - 12;
    descLines.forEach((l, i) => text(l, cols.desc, ry - i * 12, { size: 9.5 }));
    if (extra) text(`Discount ${it.discount_type === 'percent' ? formatRate(it.discount_value) : ''} −${money(it.line_discount_minor, cur)}`.replace('  ', ' '), cols.desc, ry - descLines.length * 12, { size: 8, color: MUTED });
    text(`${formatQuantity(it.quantity_milli)}${it.unit ? ` ${it.unit}` : ''}`, cols.qty + 40, ry, { size: 9.5, align: 'right' });
    text(money(it.unit_price_minor, cur), cols.price + 46, ry, { size: 9.5, align: 'right' });
    text(it.tax_rate_bp ? formatRate(it.tax_rate_bp) : '—', cols.tax + 40, ry, { size: 9.5, align: 'right', color: MUTED });
    text(money(it.line_subtotal_minor - it.line_discount_minor, cur), cols.total, ry, { size: 9.5, align: 'right' });
    y -= rowH;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
  }

  // ---- Totals & tax breakdown
  const breakdown = doc.tax_breakdown || computeDocument(doc.items).tax_breakdown;
  const rows = [['Subtotal', money(doc.subtotal_minor, cur)]];
  if (doc.discount_minor) rows.push(['Discounts', `-${money(doc.discount_minor, cur)}`]);
  for (const b of breakdown.filter((x) => x.rate_bp > 0)) rows.push([`Tax ${formatRate(b.rate_bp)} on ${money(b.base_minor, cur)}`, money(b.tax_minor, cur)]);
  ensure(rows.length * 16 + 80);
  y -= 14;
  const tx = W - M - 230;
  for (const [k, v] of rows) { text(k, tx, y, { size: 9, color: MUTED }); text(v, W - M, y, { size: 9, align: 'right' }); y -= 15; }
  y -= 4;
  page.drawRectangle({ x: tx - 10, y: y - 14, width: W - M - tx + 10, height: 28, color: ACCENT, opacity: 0.08 });
  text(isInvoice ? 'Total due' : 'Total', tx, y - 4, { size: 11, font: bold });
  text(money(doc.total_minor, cur), W - M - 8, y - 4, { size: 13, font: bold, align: 'right' });
  y -= 30;
  if (isInvoice && doc.paid_minor) {
    text('Paid', tx, y, { size: 9, color: MUTED }); text(`-${money(doc.paid_minor, cur)}`, W - M, y, { size: 9, align: 'right', color: ACCENT_2 }); y -= 15;
    text('Balance due', tx, y, { size: 10, font: bold }); text(money(doc.total_minor - doc.paid_minor, cur), W - M, y, { size: 10, font: bold, align: 'right' }); y -= 20;
  }

  // ---- Payment info, notes, terms
  const blocks = [];
  if (isInvoice && profile?.payment_details) blocks.push(['PAYMENT INFORMATION', profile.payment_details]);
  if (doc.notes) blocks.push(['NOTES', doc.notes]);
  if (doc.terms) blocks.push(['TERMS', doc.terms]);
  for (const [title, body] of blocks) {
    const lines = wrap(body, regular, 9, W - 2 * M);
    ensure(24 + lines.length * 12);
    y -= 8;
    text(title, M, y, { size: 7.5, font: bold, color: MUTED });
    y -= 13;
    for (const l of lines) { ensure(14); text(l, M, y, { size: 9 }); y -= 12; }
  }
  footer();
  const pages = pdf.getPages();
  if (pages.length > 1) pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W / 2 - 24, y: 27, size: 7.5, font: regular, color: MUTED }));
  return pdf.save();
}

// ---------------------------------------------------------------- preview (PDF.js)
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ new URL('vendor/pdf.min.mjs', document.baseURI).href).then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', document.baseURI).href;
      return m;
    });
  }
  return pdfjsPromise;
}

/** Render every page of the PDF bytes into canvases inside `host`. */
export async function renderPdfPreview(bytes, host) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  host.replaceChildren();
  const ratio = Math.min(2.5, (window.devicePixelRatio || 1) * 1.25);
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: ratio * Math.min(1.4, (host.clientWidth || 600) / 595) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.setAttribute('aria-label', `Page ${i}`);
    host.appendChild(canvas);
    await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
  return doc.numPages;
}
