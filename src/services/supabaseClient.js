/**
 * Minimal Supabase client built on fetch — talks to the real Supabase Auth
 * (GoTrue) and REST (PostgREST) endpoints over HTTPS. Only the anon/public key
 * is ever used on the device; Row Level Security on the server limits every
 * request to the signed-in user's rows. Never put a service-role key here.
 */

export class SupabaseError extends Error {
  constructor(message, { status = 0, code = null, details = null } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork() { return this.status === 0; }
  get isUniqueViolation() { return this.code === '23505' || this.status === 409; }
}

export class SupabaseClient {
  constructor({ url, anonKey, fetchImpl = globalThis.fetch.bind(globalThis), getAccessToken = async () => null }) {
    if (!/^https:\/\//.test(url || '') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url || '')) {
      throw new Error('Supabase URL must use HTTPS');
    }
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.fetch = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  async _request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const token = auth ? await this.getAccessToken() : null;
    let res;
    try {
      res = await this.fetch(`${this.url}${path}`, {
        method,
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${token || this.anonKey}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new SupabaseError('Network unavailable', { status: 0 });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = data?.msg || data?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new SupabaseError(msg, { status: res.status, code: data?.code || null, details: data?.details || null });
    }
    return data;
  }

  // ---------------------------------------------------------------- Auth
  signUp(email, password, redirectTo) {
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    return this._request(`/auth/v1/signup${q}`, { method: 'POST', body: { email, password }, auth: false });
  }
  signInWithPassword(email, password) {
    return this._request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false });
  }
  refreshSession(refreshToken) {
    return this._request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken }, auth: false });
  }
  resetPasswordForEmail(email, redirectTo) {
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    return this._request(`/auth/v1/recover${q}`, { method: 'POST', body: { email }, auth: false });
  }
  getUser() { return this._request('/auth/v1/user'); }
  updateUser(attrs) { return this._request('/auth/v1/user', { method: 'PUT', body: attrs }); }
  signOut() { return this._request('/auth/v1/logout', { method: 'POST' }); }

  // ---------------------------------------------------------------- REST
  select(table, query) { return this._request(`/rest/v1/${encodeURIComponent(table)}?${query}`); }
  insert(table, row) {
    return this._request(`/rest/v1/${encodeURIComponent(table)}`, { method: 'POST', body: row, headers: { Prefer: 'return=representation' } });
  }
  update(table, filter, patch) {
    return this._request(`/rest/v1/${encodeURIComponent(table)}?${filter}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } });
  }
}

/**
 * Adapter used by the sync engine. Same interface is implemented by the
 * in-memory server in tests (tests/fakeSupabase.mjs).
 */
export class SupabaseRemote {
  constructor(client) { this.client = client; }

  async pull(table, cursor, limit = 500) {
    const filter = cursor ? `&server_updated_at=gte.${encodeURIComponent(cursor)}` : '';
    return this.client.select(table, `select=*${filter}&order=server_updated_at.asc,id.asc&limit=${limit}`);
  }
  async fetchOne(table, id) {
    const rows = await this.client.select(table, `select=*&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  async insert(table, row) {
    const rows = await this.client.insert(table, row);
    return rows[0];
  }
  /** Conditional update: only applies when the server still has `expectedVersion`. */
  async updateIfVersion(table, row, expectedVersion) {
    const { id, ...patch } = row;
    const rows = await this.client.update(table, `id=eq.${encodeURIComponent(id)}&version=eq.${expectedVersion}`, patch);
    return rows[0] || null;
  }
}
