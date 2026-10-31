/**
 * Application shell: top app bar, offline banner, page outlet, bottom
 * navigation and the global quick-action button.
 */
import { h, icon, iconButton, brandMark, errorState, loadingList, replace } from '../components/ui.js';
import { openSheet, closeTop, hasOverlay, toast } from '../components/Modal.js';
import { startRouter, route, navigate, goTab, back, currentRoute } from './router.js';
import { getSyncStatus, onSyncStatus } from '../services/syncService.js';
import { isOnline, onNetworkChange, initAppShell } from './platform.js';
import { currentUser } from '../services/authService.js';
import { runSync } from './syncController.js';
import { relativeTime } from '../utils/formatting.js';

import { DashboardPage } from '../pages/Dashboard.js';
import { InvoicesPage, QuotationsPage } from '../pages/Invoices.js';
import { DocumentEditorPage } from '../pages/InvoiceEditor.js';
import { DocumentViewPage } from '../pages/InvoiceView.js';
import { CustomersPage, CustomerDetailPage, openCustomerForm } from '../pages/Customers.js';
import { ProductsPage, openProductForm } from '../pages/Products.js';
import { StudioPage, ProjectPage, openCreateTable } from '../pages/DatabaseStudio.js';
import { TablePage } from '../pages/TableEditor.js';
import { SQLEditorPage } from '../pages/SQLEditor.js';
import { ERDiagramPage } from '../pages/ERDiagram.js';
import { AnalyticsPage } from '../pages/Analytics.js';
import { SettingsPage, SettingsSectionPage } from '../pages/Settings.js';
import { BUSINESS_PROJECT_ID, listProjects } from '../services/studioService.js';

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['business', 'Invoices', 'invoice'],
  ['studio', 'Studio', 'database'],
  ['analytics', 'Analytics', 'chart'],
  ['settings', 'Settings', 'settings'],
];

function registerRoutes() {
  route('/dashboard', DashboardPage, { tab: 'dashboard' });
  route('/invoices', InvoicesPage, { tab: 'business' });
  route('/invoices/new', (p, c) => DocumentEditorPage({ ...p, kind: 'invoice' }, c), { tab: 'business' });
  route('/invoices/:id', (p, c) => DocumentViewPage({ ...p, kind: 'invoice' }, c), { tab: 'business' });
  route('/invoices/:id/edit', (p, c) => DocumentEditorPage({ ...p, kind: 'invoice' }, c), { tab: 'business' });
  route('/quotations', QuotationsPage, { tab: 'business' });
  route('/quotations/new', (p, c) => DocumentEditorPage({ ...p, kind: 'quotation' }, c), { tab: 'business' });
  route('/quotations/:id', (p, c) => DocumentViewPage({ ...p, kind: 'quotation' }, c), { tab: 'business' });
  route('/quotations/:id/edit', (p, c) => DocumentEditorPage({ ...p, kind: 'quotation' }, c), { tab: 'business' });
  route('/customers', CustomersPage, { tab: 'business' });
  route('/customers/:id', CustomerDetailPage, { tab: 'business' });
  route('/products', ProductsPage, { tab: 'business' });
  route('/studio', StudioPage, { tab: 'studio' });
  route('/studio/:pid', ProjectPage, { tab: 'studio' });
  route('/studio/:pid/sql', SQLEditorPage, { tab: 'studio' });
  route('/studio/:pid/er', ERDiagramPage, { tab: 'studio' });
  route('/studio/:pid/t/:table', TablePage, { tab: 'studio' });
  route('/analytics', AnalyticsPage, { tab: 'analytics' });
  route('/settings', SettingsPage, { tab: 'settings' });
  route('/settings/:section', SettingsSectionPage, { tab: 'settings' });
}

// ---------------------------------------------------------------- sync pill
function syncPill() {
  const el = h('button', { class: 'sync-pill', 'aria-live': 'polite', onclick: () => navigate('/settings/sync') });
  const paint = (st) => {
    let ic = 'cloudOff', label = 'Local', cls = 'local';
    if (!currentUser()) { ic = 'database'; label = 'Local'; cls = 'local'; }
    else if (st.running) { ic = 'refresh'; label = 'Syncing'; cls = 'syncing'; }
    else if (!isOnline()) { ic = 'cloudOff'; label = st.pending ? `${st.pending} queued` : 'Offline'; cls = 'offline'; }
    else if (st.conflicts) { ic = 'alert'; label = `${st.conflicts} conflict${st.conflicts > 1 ? 's' : ''}`; cls = 'conflict'; }
    else if (st.state === 'error') { ic = 'alert'; label = 'Retry'; cls = 'error'; }
    else if (st.pending) { ic = 'cloud'; label = `${st.pending} pending`; cls = 'offline'; }
    else { ic = 'check'; label = 'Synced'; cls = 'idle'; }
    el.className = `sync-pill ${cls}`;
    el.title = st.lastSyncAt ? `Last sync ${relativeTime(st.lastSyncAt)}` : 'Not synchronised yet';
    replace(el, icon(ic), h('span', label));
  };
  paint(getSyncStatus());
  onSyncStatus(paint);
  onNetworkChange(() => paint(getSyncStatus()));
  return el;
}

// ---------------------------------------------------------------- quick actions
async function quickActions() {
  const tile = (label, ic, variant, fn) => h('button', { class: 'action-tile', onclick: fn }, h('div', { class: ['avatar', variant] }, icon(ic)), label);
  await openSheet({
    title: 'Quick actions',
    body: (close) => {
      const go = (fn) => () => { close(); setTimeout(fn, 60); };
      const studioTarget = async () => {
        const ps = await listProjects();
        return ps[0]?.id;
      };
      return h('div', { class: 'action-grid' },
        tile('New invoice', 'invoice', '', go(() => navigate('/invoices/new'))),
        tile('New quotation', 'quote', '', go(() => navigate('/quotations/new'))),
        tile('Add customer', 'user', 'alt', go(() => openCustomerForm())),
        tile('Add product', 'box', 'alt', go(() => openProductForm())),
        tile('New table', 'table', 'neutral', go(async () => {
          const pid = await studioTarget();
          if (!pid) { toast('Create a database project first', { type: 'info' }); navigate('/studio?create=1'); return; }
          navigate(`/studio/${pid}`); setTimeout(() => openCreateTable(pid), 120);
        })),
        tile('SQL editor', 'code', 'neutral', go(async () => navigate(`/studio/${(await studioTarget()) || BUSINESS_PROJECT_ID}/sql`))));
    },
  });
}

// ---------------------------------------------------------------- shell
export function mountApp(root) {
  registerRoutes();
  const titleEl = h('div', { class: 'appbar-title' });
  const backBtn = iconButton('back', { title: 'Back', onClick: () => back() });
  backBtn.classList.add('back');
  const actionsEl = h('div', { class: 'row', style: { gap: '2px' } });
  const appbar = h('header', { class: 'appbar' }, h('div', { class: 'appbar-inner' }, backBtn, titleEl, actionsEl, syncPill()));
  const banner = h('div', { class: 'offline-banner hidden', role: 'status' }, icon('wifiOff'), 'You’re offline — everything keeps working and will sync later.');
  let outlet = h('div', { class: 'page' });
  const main = h('main', { class: 'main', id: 'main' }, outlet);
  const navBtns = {};
  const nav = h('nav', { class: 'bottomnav', 'aria-label': 'Main' }, h('div', { class: 'bottomnav-inner' }, NAV.map(([tab, label, ic]) => {
    const b = h('button', { class: 'navbtn', onclick: () => goTab(tab), 'aria-label': label }, icon(ic), h('span', label));
    navBtns[tab] = b;
    return b;
  })));
  const fab = h('button', { class: 'fab', 'aria-label': 'Quick actions', onclick: async () => { fab.classList.add('open'); await quickActions(); fab.classList.remove('open'); } }, icon('plus'));
  replace(root, appbar, banner, main, nav, fab);

  main.addEventListener('scroll', () => appbar.classList.toggle('scrolled', main.scrollTop > 4), { passive: true });
  const paintNet = () => banner.classList.toggle('hidden', isOnline());
  paintNet();
  onNetworkChange(paintNet);

  const scrollMem = new Map();
  let lastPath = null;
  startRouter(async (m, ctx, token) => {
    if (lastPath) scrollMem.set(lastPath, main.scrollTop);
    lastPath = m.path;
    for (const [tab, b] of Object.entries(navBtns)) b.classList.toggle('active', tab === m.tab);
    backBtn.classList.toggle('hidden', m.depth === 0);
    const brand = h('span', { class: 'brandmark' }, brandMark(), 'LEDGER X');
    replace(outlet, loadingList(4));
    try {
      const page = await m.page(m.params, ctx);
      if (!ctx.isCurrent()) return;
      replace(titleEl, m.tab === 'dashboard' && m.depth === 0 ? brand : (page.title || ''));
      document.title = `${page.title || 'Dashboard'} · LEDGER X`;
      replace(actionsEl, ...(page.actions || []));
      fab.classList.toggle('hidden', !!page.hideFab);
      const fresh = h('div', { class: 'page' }, page.el);
      outlet.replaceWith(fresh);
      outlet = fresh;
      main.scrollTop = scrollMem.get(m.path) || 0;
    } catch (e) {
      console.error(e);
      replace(outlet, errorState(e, () => ctx.refresh()));
    }
  });

  initAppShell({
    onBack: (canGoBack, exit) => {
      if (closeTop()) return;
      const r = currentRoute();
      if (r && r.depth > 0) back();
      else if (r && r.tab !== 'dashboard') goTab('dashboard');
      else {
        const now = Date.now();
        if (now - (window.__lxBack || 0) < 1800) exit();
        else { window.__lxBack = now; toast('Press back again to exit', { type: 'info', duration: 1600 }); }
      }
    },
    onResume: () => runSync().catch(() => {}),
  });
  // Browser fallback: Escape closes overlays (handled in Modal), history works natively.
  window.addEventListener('popstate', () => { if (hasOverlay()) closeTop(); });
}
