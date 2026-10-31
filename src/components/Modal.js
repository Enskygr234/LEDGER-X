/**
 * Overlays: bottom sheets, dialogs, confirmations and toasts.
 * All are dismissible with the Android back button (see router back handling).
 */
import { h, icon, iconButton } from './ui.js';

const stack = [];
export const hasOverlay = () => stack.length > 0;
/** Close the top-most overlay. Returns true if one was closed. */
export function closeTop() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.requestClose();
  return true;
}

function mountOverlay(content, { center = false, onClose, dismissable = true, guard } = {}) {
  const overlay = h('div', { class: ['overlay', center && 'center'] }, content);
  let closed = false;
  const entry = {
    async requestClose(result) {
      if (closed) return;
      if (guard && result === undefined && !(await guard())) return;
      close(result);
    },
  };
  function close(result) {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
    onClose?.(result);
  }
  const onKey = (e) => { if (e.key === 'Escape' && dismissable && stack[stack.length - 1] === entry) entry.requestClose(); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissable) entry.requestClose(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  stack.push(entry);
  return { close, entry, overlay };
}

/**
 * Bottom sheet. `body` may be a node or a function (close) => node.
 * Returns a promise resolving with the value passed to close().
 */
export function openSheet({ title, body, footer, full = false, guard, onOpen, headerActions = [] }) {
  return new Promise((resolve) => {
    let ctl;
    const close = (v) => ctl.close(v);
    const bodyNode = typeof body === 'function' ? body(close) : body;
    const footNode = typeof footer === 'function' ? footer(close) : footer;
    const sheet = h('div', { class: ['sheet', full && 'full'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      full ? null : h('div', { class: 'sheet-grip' }),
      h('div', { class: 'sheet-head' }, h('h2', title), ...headerActions, iconButton('x', { title: 'Close', onClick: () => ctl.entry.requestClose() })),
      h('div', { class: 'sheet-body' }, bodyNode),
      footNode ? h('div', { class: 'sheet-foot' }, footNode) : null);
    ctl = mountOverlay(sheet, { onClose: resolve, guard });
    onOpen?.(sheet);
    const first = sheet.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first && !full && window.matchMedia('(min-width: 700px)').matches) setTimeout(() => first.focus(), 60);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, icon: ic }) {
  return new Promise((resolve) => {
    let ctl;
    const ok = h('button', { class: ['btn', danger ? 'danger solid' : 'primary'], onclick: () => ctl.close(true) }, confirmLabel);
    const dlg = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      h('div', { class: ['dicon', danger && 'danger'] }, icon(ic || (danger ? 'alert' : 'info'))),
      h('h2', title),
      typeof message === 'string' ? h('p', { class: 'msg' }, message) : message,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => ctl.close(false) }, cancelLabel), ok));
    ctl = mountOverlay(dlg, { center: true, onClose: (v) => resolve(!!v) });
    setTimeout(() => ok.focus(), 50);
  });
}

/** Ask for a short text value. Resolves to the string or null. */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', validate }) {
  return new Promise((resolve) => {
    let ctl;
    const input = h('input', { class: 'input', value, placeholder, 'aria-label': label });
    const err = h('div', { class: 'error' });
    const submit = () => {
      const v = input.value.trim();
      const msg = validate?.(v);
      if (msg) { err.textContent = msg; input.classList.add('invalid'); return; }
      ctl.close(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('h2', title), h('div', { class: 'field', style: { marginTop: '12px' } }, label ? h('label', label) : null, input, err),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => ctl.close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, confirmLabel)));
    ctl = mountOverlay(dlg, { center: true, onClose: (v) => resolve(v ?? null) });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

/** Action list sheet: [{ label, icon, danger, onSelect }] */
export function actionSheet(title, actions) {
  return openSheet({
    title,
    body: (close) => h('div', { class: 'card' }, h('div', { class: 'list' }, actions.filter(Boolean).map((a) =>
      h('button', { class: 'list-item', style: { minHeight: '52px' }, onclick: () => { close(); setTimeout(() => a.onSelect(), 10); } },
        h('div', { class: ['avatar', a.danger ? 'neutral' : ''], style: a.danger ? { color: 'var(--danger)', background: 'var(--danger-soft)' } : {} }, icon(a.icon || 'chevronRight')),
        h('div', { class: 'grow' }, h('div', { class: 'primary', style: a.danger ? { color: 'var(--danger)' } : {} }, a.label), a.hint ? h('div', { class: 'secondary' }, a.hint) : null))))),
  });
}

// ---------------------------------------------------------------- toasts
let toastHost;
export function toast(message, { type = 'success', action, duration = 3200 } = {}) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
  const ic = { success: 'check', error: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: ['toast', type] }, icon(ic), h('span', message),
    action ? h('button', { class: 'btn sm ghost', onclick: () => { action.onClick(); dismiss(); } }, action.label) : null);
  toastHost.appendChild(el);
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(dismiss, duration);
  return dismiss;
}

export function toastError(err) {
  const msg = err?.errors ? Object.values(err.errors)[0] : (err?.message || String(err));
  toast(msg, { type: 'error', duration: 4800 });
}
