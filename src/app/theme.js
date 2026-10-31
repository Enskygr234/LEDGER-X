import { setStatusBarTheme } from './platform.js';

const KEY = 'lx.theme';
let mode = 'dark';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export const getThemeMode = () => mode;
export function resolved(m = mode) { return m === 'system' ? (media?.matches ? 'dark' : 'light') : m; }

/** Apply theme with a short cross-fade; persisted in localStorage (read before first paint) and app settings. */
export function applyTheme(m, { animate = true } = {}) {
  mode = m || 'dark';
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  const root = document.documentElement;
  if (animate) { root.classList.add('theme-anim'); setTimeout(() => root.classList.remove('theme-anim'), 380); }
  const r = resolved();
  root.dataset.theme = r;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', r === 'dark' ? '#0B0D12' : '#F5F7FA');
  setStatusBarTheme(r === 'dark');
}

export function initTheme(saved) {
  let m = saved;
  try { m = m || localStorage.getItem(KEY); } catch { /* ignore */ }
  applyTheme(m || 'dark', { animate: false });
  media?.addEventListener?.('change', () => { if (mode === 'system') applyTheme('system'); });
}
