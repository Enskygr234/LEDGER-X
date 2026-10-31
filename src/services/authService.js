/**
 * Supabase authentication. The app is fully usable without an account;
 * connecting one is an explicit action in Settings → Account.
 *
 * Tokens are kept in native secure storage (Android Keystore), never in
 * SQLite, never logged.
 */
import { SupabaseClient, SupabaseRemote } from './supabaseClient.js';
import { getSetting, setSetting } from './settingsService.js';
import { secureStore } from '../app/platform.js';
import { getDb } from './database.js';
import { clock } from '../storage/syncQueue.js';
import { isEmail } from '../utils/validation.js';

const SESSION_KEY = 'supabase.session';
let session = null;
let client = null;
const listeners = new Set();

export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) { try { fn(session); } catch { /* ignore */ } } };

/** Supabase project settings: from Settings, or build-time env (never hardcoded). */
export async function getCloudConfig() {
  const saved = await getSetting('cloud.config', null);
  const env = globalThis.__LEDGERX_ENV__ || {};
  return {
    url: saved?.url || env.SUPABASE_URL || '',
    anonKey: saved?.anonKey || env.SUPABASE_ANON_KEY || '',
  };
}

export async function setCloudConfig({ url, anonKey }) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new Error('Enter your Supabase project URL, e.g. https://abcd.supabase.co');
  const k = String(anonKey || '').trim();
  if (k.length < 20) throw new Error('Enter the project’s anon (public) API key');
  if (/service_role/.test(atobSafe(k.split('.')[1] || ''))) throw new Error('That is a service-role key. Never use it in the app — use the anon key.');
  await setSetting('cloud.config', { url: u, anonKey: k });
  client = null;
}

function atobSafe(s) { try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } }

export async function getClient() {
  if (client) return client;
  const cfg = await getCloudConfig();
  if (!cfg.url || !cfg.anonKey) return null;
  client = new SupabaseClient({ url: cfg.url, anonKey: cfg.anonKey, getAccessToken: () => accessToken() });
  return client;
}

export async function getRemote() {
  const c = await getClient();
  return c ? new SupabaseRemote(c) : null;
}

async function persist(s) {
  session = s;
  if (s) await secureStore.set(SESSION_KEY, JSON.stringify(s));
  else await secureStore.remove(SESSION_KEY);
  emit();
}

function fromTokenResponse(r) {
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at || Math.floor(Date.now() / 1000) + Number(r.expires_in || 3600),
    user: { id: r.user?.id, email: r.user?.email, user_metadata: r.user?.user_metadata || {} },
  };
}

export async function restoreSession() {
  const raw = await secureStore.get(SESSION_KEY);
  session = raw ? JSON.parse(raw) : null;
  emit();
  return session;
}

export const currentSession = () => session;
export const currentUser = () => session?.user || null;

async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  const c = await getClient();
  try {
    const r = await c.refreshSession(session.refresh_token);
    await persist(fromTokenResponse(r));
    return session.access_token;
  } catch (e) {
    if (e.status === 400 || e.status === 401) await persist(null); // refresh token revoked
    throw e;
  }
}

function checkCreds(email, password) {
  if (!isEmail(email)) throw new Error('Enter a valid email address');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
}

export async function signUp(email, password) {
  checkCreds(email, password);
  const c = await getClient();
  if (!c) throw new Error('Configure your Supabase project first');
  const r = await c.signUp(email.trim(), password);
  if (r?.access_token) { await persist(fromTokenResponse(r)); await linkLocalUser(); return { confirmed: true }; }
  return { confirmed: false }; // email confirmation required
}

export async function signIn(email, password) {
  checkCreds(email, password);
  const c = await getClient();
  if (!c) throw new Error('Configure your Supabase project first');
  const r = await c.signInWithPassword(email.trim(), password);
  await persist(fromTokenResponse(r));
  await linkLocalUser();
  return session;
}

export async function resetPassword(email) {
  if (!isEmail(email)) throw new Error('Enter a valid email address');
  const c = await getClient();
  if (!c) throw new Error('Configure your Supabase project first');
  await c.resetPasswordForEmail(email.trim());
}

export async function updateProfile({ display_name }) {
  const c = await getClient();
  if (c && session) {
    const u = await c.updateUser({ data: { display_name } });
    session.user.user_metadata = u.user_metadata || { display_name };
    await persist(session);
  }
  await linkLocalUser(display_name);
}

export async function signOut({ keepLocalData = true } = {}) {
  const c = await getClient();
  try { if (c && session) await c.signOut(); } catch { /* offline logout is still a logout */ }
  await persist(null);
  if (!keepLocalData) { /* local data is intentionally never wiped implicitly */ }
}

async function linkLocalUser(displayName) {
  if (!session?.user?.id) return;
  const now = clock.now();
  await getDb().run(
    `INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = COALESCE(excluded.display_name, users.display_name), updated_at = excluded.updated_at`,
    [session.user.id, session.user.email, displayName ?? session.user.user_metadata?.display_name ?? null, now, now]);
  await setSetting('cloud.user_id', session.user.id);
}

/** For tests. */
export function _setSession(s) { session = s; }
