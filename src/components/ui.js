/**
 * Tiny DOM toolkit: `h()` hyperscript, icons, and small presentational parts.
 * Text is always set via textContent — never innerHTML with user data.
 */

export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || attrs?.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
    else if (k === 'html') el.innerHTML = v; // only for trusted, escaped markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function replace(el, ...children) { clear(el); append(el, children); return el; }

// ---------------------------------------------------------------- icons
const P = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  invoice: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  filter: 'M3 5h18M6 12h12M10 19h4',
  sort: 'M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  share: 'M12 3v13M7 8l5-5 5 5M5 14v6h14v-6',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5M16 3.5a4 4 0 0 1 0 7.5M18 15.5c2.4.6 4 2.4 4 5.5',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 7 18z',
  cloudOff: 'M3 3l18 18M9 5.3A6 6 0 0 1 17.5 10a4 4 0 0 1 2.4 6.9M17 18H7a3.5 3.5 0 0 1-1.1-6.8',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-3v3M17 13.5h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  play: 'M7 4l13 8-13 8z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  key: 'M14.5 9.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM13.5 12.5L21 20M17 16l2-2M19 18l2-2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  layout: 'M3 3h7v7H3zM14 3h7v7h-7zM8.5 14h7v7h-7zM6.5 10v2.5h11V10M12 12.5V14',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  file: 'M6 3h9l4 4v14H6zM15 3v4h4',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  quote: 'M6 3h9l4 4v14H6zM15 3v4h4M9 13h6M9 17h4M12 9.5v.01',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  pin: 'M12 21s7-6.3 7-12a7 7 0 0 0-14 0c0 5.7 7 12 7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  hash: 'M5 9h14M5 15h14M10 3L8 21M16 3l-2 18',
  columns: 'M4 4h16v16H4zM12 4v16',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3',
  wifiOff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2-1.5M2 8.8a15 15 0 0 1 4.2-2.5M22 8.8A15 15 0 0 0 10.7 5M12 20h.01',
  receiptCheck: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 11l2 2 4-4',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.info);
  svg.appendChild(p);
  return svg;
}

export function brandMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.innerHTML = '<rect width="32" height="32" rx="9" fill="var(--accent)"/><path d="M10 9v14h6" stroke="var(--accent-ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M17.5 13.5l5 6M22.5 13.5l-5 6" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round"/>';
  return svg;
}

// ---------------------------------------------------------------- parts
export function button(label, { variant = '', icon: ic, onClick, size = '', type = 'button', disabled, title, block } = {}) {
  return h('button', { class: ['btn', variant, size, block && 'block'], type, onclick: onClick, disabled, title, 'aria-label': title || undefined },
    ic ? icon(ic) : null, label ? h('span', label) : null);
}

export function iconButton(name, { onClick, title, dot } = {}) {
  return h('button', { class: 'iconbtn', type: 'button', onclick: onClick, title, 'aria-label': title },
    icon(name), dot ? h('span', { class: 'dot', style: { background: dot } }) : null);
}

/** Wrap an async click handler with a loading state. */
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    try { return await fn(...args); } finally { btn.classList.remove('loading'); }
  };
}

export function badge(status, label) { return h('span', { class: ['badge', status] }, label); }

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatar(name, variant = '') { return h('div', { class: ['avatar', variant] }, initials(name)); }

export function card(...children) { return h('div', { class: 'card' }, ...children); }

export function sectionTitle(title, action) {
  return h('div', { class: 'section-title' }, h('h2', title), action || null);
}

const ART = {
  invoices: '<svg viewBox="0 0 120 96" fill="none"><rect x="30" y="10" width="60" height="76" rx="8" fill="var(--card)" stroke="var(--border-strong)"/><rect x="40" y="24" width="26" height="5" rx="2.5" fill="var(--accent)" opacity=".7"/><rect x="40" y="38" width="40" height="4" rx="2" fill="var(--border-strong)"/><rect x="40" y="48" width="34" height="4" rx="2" fill="var(--border-strong)"/><rect x="40" y="58" width="38" height="4" rx="2" fill="var(--border-strong)"/><rect x="58" y="70" width="22" height="6" rx="3" fill="var(--accent-2)" opacity=".8"/><circle cx="94" cy="20" r="10" fill="var(--accent-soft)" stroke="var(--accent)"/><path d="M94 15v10M89 20h10" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>',
  people: '<svg viewBox="0 0 120 96" fill="none"><rect x="18" y="22" width="84" height="56" rx="10" fill="var(--card)" stroke="var(--border-strong)"/><circle cx="44" cy="44" r="9" fill="var(--accent-soft)" stroke="var(--accent)"/><path d="M30 66c2-8 8-11 14-11s12 3 14 11" stroke="var(--accent)" stroke-width="2"/><rect x="64" y="38" width="26" height="4" rx="2" fill="var(--border-strong)"/><rect x="64" y="48" width="18" height="4" rx="2" fill="var(--border-strong)"/></svg>',
  box: '<svg viewBox="0 0 120 96" fill="none"><path d="M60 14l34 18v34L60 84 26 66V32z" fill="var(--card)" stroke="var(--border-strong)"/><path d="M26 32l34 18 34-18M60 50v34" stroke="var(--border-strong)"/><path d="M43 23l34 18" stroke="var(--accent)" stroke-width="2"/></svg>',
  database: '<svg viewBox="0 0 120 96" fill="none"><ellipse cx="60" cy="22" rx="30" ry="10" fill="var(--card)" stroke="var(--border-strong)"/><path d="M30 22v48c0 5.5 13.4 10 30 10s30-4.5 30-10V22" fill="var(--card)" stroke="var(--border-strong)"/><path d="M30 46c0 5.5 13.4 10 30 10s30-4.5 30-10" stroke="var(--border-strong)"/><circle cx="92" cy="72" r="11" fill="var(--accent-2-soft)" stroke="var(--accent-2)"/><path d="M92 67v10M87 72h10" stroke="var(--accent-2)" stroke-width="2" stroke-linecap="round"/></svg>',
  chart: '<svg viewBox="0 0 120 96" fill="none"><rect x="16" y="14" width="88" height="68" rx="10" fill="var(--card)" stroke="var(--border-strong)"/><path d="M28 66l16-14 14 8 18-22 16 10" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="76" cy="38" r="3.5" fill="var(--accent-2)"/></svg>',
  search: '<svg viewBox="0 0 120 96" fill="none"><circle cx="54" cy="44" r="22" fill="var(--card)" stroke="var(--border-strong)" stroke-width="2"/><path d="M70 60l18 18" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/><path d="M46 44h16" stroke="var(--border-strong)" stroke-width="3" stroke-linecap="round"/></svg>',
};

export function emptyState({ art = 'invoices', title, text, action }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'art', html: ART[art] || ART.invoices }),
    h('h3', title), text ? h('p', text) : null, action || null);
}

export function errorState(err, retry) {
  return h('div', { class: 'state-error', role: 'alert' }, icon('alert'),
    h('div', { class: 'grow' }, h('div', String(err?.message || err || 'Something went wrong')),
      retry ? h('button', { class: 'btn sm ghost', style: { marginTop: '6px', paddingLeft: 0 }, onclick: retry }, 'Try again') : null));
}

export function infoState(text, ic = 'info') { return h('div', { class: 'state-info' }, icon(ic), h('div', text)); }

export function loadingList(n = 4) {
  return h('div', { class: 'card' }, ...Array.from({ length: n }, () =>
    h('div', { class: 'list-item' }, h('div', { class: 'skeleton', style: { width: '38px', height: '38px', borderRadius: '12px' } }),
      h('div', { class: 'grow stack', style: { gap: '6px' } }, h('div', { class: 'skeleton', style: { height: '12px', width: '55%' } }), h('div', { class: 'skeleton', style: { height: '10px', width: '35%' } })))));
}

export function loadingBlock(height = 120) { return h('div', { class: 'skeleton', style: { height: `${height}px` } }); }

export function segmented(options, value, onChange) {
  const el = h('div', { class: 'segmented', role: 'tablist' });
  for (const [v, label] of options) {
    el.appendChild(h('button', { class: v === value ? 'active' : '', role: 'tab', 'aria-selected': String(v === value), onclick: () => onChange(v) }, label));
  }
  return el;
}

export function chips(options, value, onChange) {
  return h('div', { class: 'chips' }, options.map(([v, label]) =>
    h('button', { class: ['chip', v === value && 'active'], onclick: () => onChange(v) }, label)));
}

export function searchBar(placeholder, value, onInput) {
  let t;
  const input = h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': placeholder, enterkeyhint: 'search',
    oninput: (e) => { clearTimeout(t); t = setTimeout(() => onInput(e.target.value), 180); } });
  return h('div', { class: 'searchbar' }, icon('search'), input);
}

export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
