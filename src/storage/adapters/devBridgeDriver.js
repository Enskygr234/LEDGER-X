/**
 * Development driver: forwards statements to the local dev server
 * (scripts/dev-server.mjs), which executes them on a real on-disk SQLite
 * file via node:sqlite. Lets the full UI run against genuine SQLite in a
 * desktop browser and in the Playwright end-to-end suite.
 */
async function call(body) {
  const res = await fetch('/__sqlite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'SQLite bridge error');
  return data.result;
}

export async function devBridgeAvailable() {
  try {
    const r = await fetch('/__sqlite/ping');
    return r.ok;
  } catch { return false; }
}

export function createDevBridgeDriverFactory() {
  const factory = async (name) => {
    await call({ db: name, op: 'open' });
    return {
      run: (sql, params) => call({ db: name, op: 'run', sql, params }),
      all: (sql, params) => call({ db: name, op: 'all', sql, params }),
      exec: (sql) => call({ db: name, op: 'exec', sql }),
      close: () => call({ db: name, op: 'close' }),
    };
  };
  factory.kind = 'dev-bridge';
  factory.remove = (name) => call({ db: name, op: 'remove' });
  return factory;
}
