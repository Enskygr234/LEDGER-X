/**
 * Hash router with per-tab history, unsaved-change guards and page lifecycle.
 * A page is `async (params, ctx) => ({ title, el, actions?, back? })`.
 */
import { onDataChange } from '../services/database.js';

const routes = [];
export function route(pattern, page, { tab }) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
  routes.push({ pattern, re, keys, page, tab });
}

export const TAB_ROOTS = { dashboard: '/dashboard', business: '/invoices', studio: '/studio', analytics: '/analytics', settings: '/settings' };
const lastByTab = { ...TAB_ROOTS };

let renderFn = null;
let current = null;
let guard = null;
let ignoreNext = false;
let token = 0;

export const currentPath = () => decodeURIComponent(location.hash.replace(/^#/, '')) || '/dashboard';
export function navigate(path, { replace = false } = {}) {
  if (replace) location.replace(`#${path}`); else location.hash = path;
}
export function back(fallback) {
  if (history.length > 1 && current?.depth > 0) history.back();
  else navigate(fallback || TAB_ROOTS[current?.tab || 'dashboard']);
}
export const setGuard = (fn) => { guard = fn; };
export const currentRoute = () => current;

function match(path) {
  const [p, qs] = path.split('?');
  for (const r of routes) {
    const m = p.match(r.re);
    if (m) {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      for (const [k, v] of new URLSearchParams(qs || '')) params[k] = v;
      return { ...r, params, path, depth: p.split('/').filter(Boolean).length - 1 };
    }
  }
  return null;
}

export function goTab(tab) {
  if (current?.tab === tab) navigate(TAB_ROOTS[tab]); // re-tap pops to root
  else navigate(lastByTab[tab] || TAB_ROOTS[tab]);
}

async function handle() {
  if (ignoreNext) { ignoreNext = false; return; }
  const path = currentPath();
  if (guard && current && current.path !== path) {
    const ok = await guard();
    if (!ok) { ignoreNext = true; location.hash = current.path; return; }
  }
  guard = null;
  const m = match(path) || match('/dashboard');
  if (!m) return;
  lastByTab[m.tab] = path;
  current?.cleanup?.forEach((fn) => fn());
  const my = ++token;
  const cleanup = [];
  current = { ...m, cleanup };
  const ctx = {
    params: m.params,
    isCurrent: () => my === token,
    onData(fn) {
      let t;
      const off = onDataChange(() => { clearTimeout(t); t = setTimeout(() => { if (my === token) fn(); }, 120); });
      cleanup.push(off, () => clearTimeout(t));
    },
    onCleanup(fn) { cleanup.push(fn); },
    refresh: () => handle.call(null, true),
  };
  await renderFn(m, ctx, my);
}

export function startRouter(render) {
  renderFn = render;
  window.addEventListener('hashchange', () => handle());
  if (!location.hash) location.replace('#/dashboard');
  handle();
}

export function rerender() { ignoreNext = false; return handle(); }
