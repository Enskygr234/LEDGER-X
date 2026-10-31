/**
 * LEDGER X entry point: choose the SQLite driver for this platform, run
 * migrations, restore the session and mount the UI.
 */
import { setDriverFactory } from './storage/sqlite.js';
import { createCapacitorDriverFactory } from './storage/adapters/capacitorDriver.js';
import { createSqlJsDriverFactory } from './storage/adapters/sqljsDriver.js';
import { createDevBridgeDriverFactory, devBridgeAvailable } from './storage/adapters/devBridgeDriver.js';
import { initDatabase } from './services/database.js';
import { ensureBusinessProfile, getSetting } from './services/settingsService.js';
import { refreshTimeBasedStatuses } from './services/invoiceService.js';
import { restoreSession } from './services/authService.js';
import { isNative, initNetwork } from './app/platform.js';
import { initTheme } from './app/theme.js';
import { setLocale } from './utils/formatting.js';
import { startSyncScheduler } from './app/syncController.js';
import { mountApp } from './app/App.js';

async function pickDriver() {
  if (isNative()) return createCapacitorDriverFactory();
  if (await devBridgeAvailable()) return createDevBridgeDriverFactory();
  return createSqlJsDriverFactory();
}

function fatal(err) {
  console.error(err);
  const el = document.getElementById('app');
  el.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:440px;margin:20vh auto;padding:24px;font:14px system-ui;color:#F5F7FA';
  const h = document.createElement('h2'); h.textContent = 'LEDGER X could not open its database';
  const p = document.createElement('p'); p.style.color = '#929BAA'; p.textContent = String(err?.message || err);
  const b = document.createElement('button'); b.textContent = 'Try again'; b.onclick = () => location.reload();
  b.style.cssText = 'margin-top:16px;height:40px;padding:0 16px;border-radius:12px;border:0;background:#6C8CFF;color:#0B0D12;font-weight:600';
  box.append(h, p, b); el.appendChild(box);
}

async function start() {
  initTheme();
  setDriverFactory(await pickDriver());
  await initDatabase();
  await ensureBusinessProfile();
  const [theme, locale] = await Promise.all([getSetting('theme', null), getSetting('locale', null)]);
  if (theme) initTheme(theme);
  if (locale) setLocale(locale); else setLocale(navigator.language || 'en-US');
  await refreshTimeBasedStatuses();
  await initNetwork();
  await restoreSession();
  mountApp(document.getElementById('app'));
  startSyncScheduler();
}

start().catch(fatal);
