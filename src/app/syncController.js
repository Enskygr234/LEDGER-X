/**
 * Schedules synchronisation: on start, when connectivity returns, shortly
 * after local changes, when the app resumes, and every few minutes.
 */
import { syncNow, refreshCounts, getSyncStatus, pruneQueue } from '../services/syncService.js';
import { getRemote, currentUser, onAuthChange } from '../services/authService.js';
import { onDataChange } from '../services/database.js';
import { isOnline, onNetworkChange } from './platform.js';

let timer = null;
let interval = null;

export async function runSync({ manual = false } = {}) {
  const user = currentUser();
  if (!user) { await refreshCounts(); return { skipped: 'not-signed-in' }; }
  if (!isOnline()) {
    await refreshCounts();
    return { skipped: 'offline' };
  }
  const remote = await getRemote();
  if (!remote) return { skipped: 'not-configured' };
  const r = await syncNow({ remote, userId: user.id });
  if (manual) await pruneQueue();
  return r;
}

function schedule(ms = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => runSync().catch(() => {}), ms);
}

export function startSyncScheduler() {
  refreshCounts().catch(() => {});
  onDataChange(() => { refreshCounts().catch(() => {}); if (currentUser() && !getSyncStatus().running) schedule(4000); });
  onNetworkChange((online) => { if (online) schedule(800); else refreshCounts(); });
  onAuthChange((s) => { if (s) schedule(300); else refreshCounts(); });
  clearInterval(interval);
  interval = setInterval(() => { if (currentUser()) runSync().catch(() => {}); }, 3 * 60 * 1000);
  schedule(1500);
}

export const syncSoon = () => schedule(300);
