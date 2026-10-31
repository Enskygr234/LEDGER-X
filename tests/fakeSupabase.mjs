/**
 * In-process fake of the Supabase HTTP API surface LEDGER X uses:
 * GoTrue password auth + PostgREST select/insert/patch with the same
 * semantics as supabase/schema.sql (RLS by user_id, unique constraints,
 * version = old + 1 trigger, server_updated_at stamping).
 *
 * It is exposed as a `fetch` implementation so the real SupabaseClient and
 * SupabaseRemote code paths are exercised, including URL encoding.
 */
import { randomUUID } from 'node:crypto';

export function createFakeSupabase() {
  const users = new Map(); // email -> { id, email, password }
  const tokens = new Map(); // access token -> user id
  const refresh = new Map(); // refresh token -> user id
  const tables = new Map(); // table -> Map(id -> row)
  let tick = Date.parse('2026-01-01T00:00:00Z');
  let online = true;
  const rejected = new Set();
  const log = [];

  const nowStamp = () => new Date(++tick).toISOString().replace('Z', '+00:00');
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const issue = (u) => {
    const at = `at_${randomUUID()}`;
    const rt = `rt_${randomUUID()}`;
    tokens.set(at, u.id); refresh.set(rt, u.id);
    return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email: u.email, user_metadata: {} } };
  };
  const table = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };

  function parseFilters(params) {
    const filters = [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const i = v.indexOf('.');
      filters.push({ col: k, op: v.slice(0, i), val: v.slice(i + 1) });
    }
    return filters;
  }
  const match = (row, f) => {
    const a = row[f.col];
    switch (f.op) {
      case 'eq': return String(a) === f.val;
      case 'gte': return String(a) >= f.val;
      case 'gt': return String(a) > f.val;
      default: throw new Error(`unsupported op ${f.op}`);
    }
  };
  function uniqueNumberClash(name, row) {
    if (!['invoices', 'quotations'].includes(name) || row.deleted_at) return false;
    for (const r of table(name).values()) {
      if (r.id !== row.id && r.user_id === row.user_id && !r.deleted_at && r.number === row.number) return true;
    }
    return false;
  }

  async function fetchImpl(url, init = {}) {
    if (!online) throw new TypeError('fetch failed');
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = (init.headers?.Authorization || '').replace('Bearer ', '');
    const uid = tokens.get(auth) || null;
    log.push(`${method} ${u.pathname}${u.search}`);
    if (!init.headers?.apikey) return json(401, { message: 'No API key found in request' });

    if (u.pathname === '/auth/v1/signup') {
      if (users.has(body.email)) return json(422, { msg: 'User already registered' });
      const user = { id: randomUUID(), email: body.email, password: body.password };
      users.set(body.email, user);
      return json(200, issue(user));
    }
    if (u.pathname === '/auth/v1/token') {
      const gt = u.searchParams.get('grant_type');
      if (gt === 'password') {
        const user = users.get(body.email);
        if (!user || user.password !== body.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return json(200, issue(user));
      }
      if (gt === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id) return json(400, { error_description: 'Invalid Refresh Token' });
        refresh.delete(body.refresh_token);
        return json(200, issue([...users.values()].find((x) => x.id === id)));
      }
    }
    if (u.pathname === '/auth/v1/recover') return json(200, {});
    if (u.pathname === '/auth/v1/logout') { tokens.delete(auth); return json(204); }
    if (u.pathname === '/auth/v1/user') {
      if (!uid) return json(401, { msg: 'invalid token' });
      const user = [...users.values()].find((x) => x.id === uid);
      return json(200, { id: user.id, email: user.email, user_metadata: {} });
    }

    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return json(404, { message: 'not found' });
    const name = m[1];
    if (!uid) return json(401, { code: '42501', message: 'permission denied (anon)' });
    const t = table(name);
    const filters = parseFilters(u.searchParams);
    // RLS: users only ever see their own rows.
    const visible = () => [...t.values()].filter((r) => r.user_id === uid && filters.every((f) => match(r, f)));

    if (method === 'GET') {
      let rows = visible().sort((a, b) => (a.server_updated_at < b.server_updated_at ? -1 : a.server_updated_at > b.server_updated_at ? 1 : a.id < b.id ? -1 : 1));
      const limit = Number(u.searchParams.get('limit') || 1000);
      rows = rows.slice(0, limit);
      return json(200, rows.map((r) => ({ ...r })));
    }
    if ((method === 'POST' || method === 'PATCH') && rejected.has(name)) {
      return json(400, { code: '22P02', message: 'invalid input syntax (simulated)' });
    }
    if (method === 'POST') {
      if (body.user_id !== uid) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
      if (t.has(body.id)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "pk"' });
      if (uniqueNumberClash(name, body)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "number"' });
      if (body.version !== 1) return json(400, { code: 'P0001', message: 'version must start at 1' });
      const row = { ...body, server_updated_at: nowStamp() };
      t.set(row.id, row);
      return json(201, [{ ...row }]);
    }
    if (method === 'PATCH') {
      const rows = visible();
      const out = [];
      for (const r of rows) {
        if (body.user_id && body.user_id !== uid) return json(403, { code: '42501', message: 'row-level security' });
        if (Number(body.version) !== Number(r.version) + 1) return json(400, { code: 'P0001', message: 'version must increase by exactly 1' });
        const next = { ...r, ...body, id: r.id, created_at: r.created_at, server_updated_at: nowStamp() };
        if (uniqueNumberClash(name, next)) return json(409, { code: '23505', message: 'duplicate number' });
        t.set(r.id, next);
        out.push({ ...next });
      }
      return json(200, out);
    }
    return json(405, { message: 'method not allowed' });
  }

  return {
    fetch: fetchImpl,
    setOnline: (v) => { online = v; },
    reject: (name, on = true) => (on ? rejected.add(name) : rejected.delete(name)),
    rows: (name) => [...table(name).values()],
    log,
    // simulate an out-of-band edit by another client
    editDirect(name, id, patch) {
      const r = table(name).get(id);
      table(name).set(id, { ...r, ...patch, version: r.version + 1, server_updated_at: nowStamp() });
    },
  };
}
