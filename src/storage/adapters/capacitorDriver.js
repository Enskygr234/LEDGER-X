/**
 * Native SQLite driver for Android via @capacitor-community/sqlite.
 *
 * The plugin is reached through Capacitor's runtime bridge, so the web bundle
 * has no compile-time dependency on the plugin's JS package; the native side
 * is installed by `npm install` + `npx cap sync`.
 */
import { getPlugin } from '../../app/platform.js';

export function createCapacitorDriverFactory() {
  const plugin = getPlugin('CapacitorSQLite');
  if (!plugin) throw new Error('CapacitorSQLite plugin is not available');

  const factory = async (name) => {
    const database = name;
    try {
      await plugin.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
    } catch (e) {
      // Connection may already exist after a WebView reload.
      if (!/already exists/i.test(String(e?.message || e))) throw e;
    }
    await plugin.open({ database, readonly: false });

    return {
      async run(statement, values) {
        const res = await plugin.run({ database, statement, values, transaction: false, readonly: false, returnMode: 'no' });
        const c = res?.changes || {};
        return { changes: Number(c.changes || 0), lastId: Number(c.lastId || 0) };
      },
      async all(statement, values) {
        const isQuery = /^\s*(select|with|pragma|explain)/i.test(statement);
        if (!isQuery) {
          await plugin.run({ database, statement, values, transaction: false, readonly: false, returnMode: 'no' });
          return [];
        }
        const res = await plugin.query({ database, statement, values, readonly: false });
        const rows = res?.values || [];
        // iOS returns a leading "ios_columns" row; Android returns objects directly.
        if (rows.length && rows[0] && rows[0].ios_columns) rows.shift();
        return rows;
      },
      async exec(statements) {
        await plugin.execute({ database, statements, transaction: false, readonly: false });
      },
      async close() {
        try { await plugin.close({ database, readonly: false }); } catch { /* ignore */ }
        try { await plugin.closeConnection({ database, readonly: false }); } catch { /* ignore */ }
      },
    };
  };
  factory.kind = 'capacitor-sqlite';
  factory.remove = async (name) => {
    try {
      await plugin.createConnection({ database: name, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
    } catch { /* exists */ }
    try { await plugin.open({ database: name, readonly: false }); } catch { /* ignore */ }
    await plugin.deleteDatabase({ database: name, readonly: false });
    try { await plugin.closeConnection({ database: name, readonly: false }); } catch { /* ignore */ }
  };
  return factory;
}
