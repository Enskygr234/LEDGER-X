/**
 * Platform bridge. Native Capacitor plugins are resolved at runtime through
 * the Capacitor bridge, so the same bundle runs on Android and in a browser.
 */
const cap = () => globalThis.Capacitor;

export const isNative = () => !!cap()?.isNativePlatform?.();
export const platformName = () => cap()?.getPlatform?.() || 'web';

const cache = new Map();
export function getPlugin(name) {
  if (!isNative()) return null;
  if (cache.has(name)) return cache.get(name);
  const c = cap();
  const p = c?.Plugins?.[name] || (c?.isPluginAvailable?.(name) && c?.registerPlugin ? c.registerPlugin(name) : null);
  cache.set(name, p || null);
  return p || null;
}

// ---------------------------------------------------------------- network
const netListeners = new Set();
let online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
export const isOnline = () => online;
export function onNetworkChange(fn) { netListeners.add(fn); return () => netListeners.delete(fn); }
function setOnline(v) { if (v !== online) { online = v; for (const fn of netListeners) fn(v); } }

export async function initNetwork() {
  const Network = getPlugin('Network');
  if (Network) {
    try {
      const s = await Network.getStatus();
      setOnline(!!s.connected);
      Network.addListener('networkStatusChange', (st) => setOnline(!!st.connected));
      return;
    } catch { /* fall through */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => setOnline(true));
    window.addEventListener('offline', () => setOnline(false));
  }
}

// ---------------------------------------------------------------- secure storage
/**
 * Auth tokens live in the Android Keystore-backed secure storage plugin.
 * In a desktop browser (development) we fall back to localStorage.
 */
export const secureStore = {
  async get(key) {
    const S = getPlugin('SecureStoragePlugin');
    if (S) { try { return (await S.get({ key })).value; } catch { return null; } }
    try { return localStorage.getItem(`lx.secure.${key}`); } catch { return null; }
  },
  async set(key, value) {
    const S = getPlugin('SecureStoragePlugin');
    if (S) { await S.set({ key, value }); return; }
    try { localStorage.setItem(`lx.secure.${key}`, value); } catch { /* ignore */ }
  },
  async remove(key) {
    const S = getPlugin('SecureStoragePlugin');
    if (S) { try { await S.remove({ key }); } catch { /* ignore */ } return; }
    try { localStorage.removeItem(`lx.secure.${key}`); } catch { /* ignore */ }
  },
};

// ---------------------------------------------------------------- files & sharing
function base64FromBytes(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

/**
 * Save a file. On Android it goes to Documents/LEDGERX (scoped storage, no
 * extra permission needed) and the share sheet is offered; in a browser it
 * downloads.
 */
export async function saveFile(fileName, data, mime, { share = false, title } = {}) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const Filesystem = getPlugin('Filesystem');
  if (Filesystem) {
    const path = `LEDGERX/${fileName}`;
    const b64 = base64FromBytes(bytes);
    let res, location;
    try {
      res = await Filesystem.writeFile({ path, data: b64, directory: 'DOCUMENTS', recursive: true });
      location = `Documents/${path}`;
    } catch {
      // Android 10 scoped storage: fall back to app-specific external storage (no permission needed).
      res = await Filesystem.writeFile({ path, data: b64, directory: 'EXTERNAL', recursive: true });
      location = `Android/data/…/files/${path}`;
    }
    if (share) await shareFile(res.uri, title || fileName);
    return { location, uri: res.uri };
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  if (share && navigator.canShare?.({ files: [new File([blob], fileName, { type: mime })] })) {
    try { await navigator.share({ files: [new File([blob], fileName, { type: mime })], title }); return { location: 'shared' }; } catch { /* fall back */ }
  }
  const a = document.createElement('a');
  a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { location: 'Downloads' };
}

export async function shareFile(uri, title) {
  const Share = getPlugin('Share');
  if (Share) await Share.share({ title, url: uri, dialogTitle: title });
}

export async function writeCacheFile(fileName, bytes) {
  const Filesystem = getPlugin('Filesystem');
  if (!Filesystem) return null;
  const res = await Filesystem.writeFile({ path: fileName, data: base64FromBytes(bytes), directory: 'CACHE', recursive: true });
  return res.uri;
}

/** Pick a file from the device. Uses the WebView's file input (works on Android). */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

// ---------------------------------------------------------------- app lifecycle
export async function initAppShell({ onBack, onResume }) {
  const App = getPlugin('App');
  if (App) {
    App.addListener('backButton', ({ canGoBack }) => onBack(canGoBack, () => App.exitApp()));
    App.addListener('resume', () => onResume?.());
  } else if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume?.(); });
  }
  const StatusBar = getPlugin('StatusBar');
  const Splash = getPlugin('SplashScreen');
  if (Splash) { try { await Splash.hide(); } catch { /* ignore */ } }
  return { StatusBar };
}

export async function setStatusBarTheme(dark) {
  const StatusBar = getPlugin('StatusBar');
  if (!StatusBar) return;
  try {
    await StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
    await StatusBar.setBackgroundColor({ color: dark ? '#0B0D12' : '#F5F7FA' });
  } catch { /* ignore */ }
}
