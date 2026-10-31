import { currencyDigits, toDecimalString } from './calculations.js';

let locale = 'en-US';
export function setLocale(l) { locale = l || 'en-US'; }
export function getLocale() { return locale; }

/** Format integer minor units as localized currency, without float math on the value. */
export function formatMoney(minor, currency = 'USD', opts = {}) {
  const digits = currencyDigits(currency);
  const dec = toDecimalString(Number(minor) || 0, digits);
  try {
    // Intl accepts decimal strings exactly (ES2023 "string as exact decimal").
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
      ...(opts.compact ? { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 } : {}),
    }).format(dec);
  } catch {
    return `${currency} ${dec}`;
  }
}

export function formatQuantity(milli) {
  const s = toDecimalString(milli, 3).replace(/\.?0+$/, '');
  return s || '0';
}

export function formatRate(bp) {
  return `${toDecimalString(bp, 2).replace(/\.?0+$/, '')}%`;
}

export function formatDate(iso, style = 'medium') {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(d);
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(diff) < 60) return rtf.format(-Math.round(diff), 'second');
  if (Math.abs(diff) < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatNumber(n) { return new Intl.NumberFormat(locale).format(n || 0); }

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addDaysISO = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const STATUS_LABELS = {
  draft: 'Draft', pending: 'Pending', partially_paid: 'Partially paid', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled',
  sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired',
};

/** CSV encode rows (array of objects) with proper quoting; guards against formula injection. */
export function toCSV(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
