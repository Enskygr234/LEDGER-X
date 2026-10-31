import { h, icon, card, sectionTitle, badge, iconButton, busy, replace, infoState, errorState, emptyState, segmented, brandMark } from '../components/ui.js';
import { openSheet, confirmDialog, toast, toastError, actionSheet, promptDialog } from '../components/Modal.js';
import { field, textInput, textArea, selectInput, rateInput, showErrors, currencyOptions, toggle } from '../components/Input.js';
import { navigate } from '../app/router.js';
import { applyTheme, getThemeMode } from '../app/theme.js';
import * as Settings from '../services/settingsService.js';
import * as Auth from '../services/authService.js';
import * as Sync from '../services/syncService.js';
import * as Backup from '../services/backupService.js';
import { databaseInfo, notifyChange } from '../services/database.js';
import { runSync } from '../app/syncController.js';
import { saveFile, pickFile, isOnline, platformName } from '../app/platform.js';
import { formatBytes, formatNumber, formatDateTime, relativeTime, setLocale, getLocale, formatRate, todayISO } from '../utils/formatting.js';
import { SYNCED_TABLES } from '../storage/syncQueue.js';

const row = ({ ic, title, sub, value, onClick, danger }) => h('button', { class: 'setting', onclick: onClick },
  h('div', { class: 'ic', style: danger ? { color: 'var(--danger)', background: 'var(--danger-soft)' } : {} }, icon(ic)),
  h('div', { class: 't' }, h('div', { style: danger ? { color: 'var(--danger)' } : {} }, title), sub ? h('div', { class: 's' }, sub) : null),
  value !== undefined ? h('div', { class: 'v' }, value) : null, onClick ? icon('chevronRight', 'chev') : null);
const group = (title, ...rows) => h('div', { class: 'settings-group' }, h('div', { class: 'caps' }, title), card(...rows));

export async function SettingsPage(_p, ctx) {
  const host = h('div');
  async function render() {
    const [profile, info] = await Promise.all([Settings.getBusinessProfile(), databaseInfo()]);
    const st = Sync.getSyncStatus();
    const user = Auth.currentUser();
    const theme = getThemeMode();
    replace(host,
      group('Account',
        row({ ic: 'user', title: user ? user.email : 'Not connected', sub: user ? 'Cloud account · synchronisation on' : 'Using LEDGER X locally on this device', value: user ? badge('success', 'Signed in') : badge('draft', 'Local'), onClick: () => navigate('/settings/account') })),
      group('Appearance',
        h('div', { class: 'setting' }, h('div', { class: 'ic' }, icon(theme === 'light' ? 'sun' : 'moon')), h('div', { class: 't' }, 'Theme'),
          segmented([['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], theme, async (v) => { applyTheme(v); await Settings.setSetting('theme', v); render(); }))),
      group('Business',
        row({ ic: 'invoice', title: profile?.name || 'Business profile', sub: 'Name, logo, address, contact, payment details', onClick: () => navigate('/settings/business') }),
        row({ ic: 'globe', title: 'Default currency', value: profile?.default_currency, onClick: () => navigate('/settings/business') }),
        row({ ic: 'hash', title: 'Tax rates', sub: `Default ${formatRate(profile?.default_tax_rate_bp || 0)} · configurable, no country rules hardcoded`, onClick: () => navigate('/settings/taxes') })),
      group('Data',
        row({ ic: 'archive', title: 'Backup & restore', sub: 'Full backup, restore, JSON & CSV export', onClick: () => navigate('/settings/data') }),
        row({ ic: 'database', title: 'Database information', value: `${formatNumber(info.records)} records · ${formatBytes(info.sizeBytes)}`, onClick: () => navigate('/settings/data') })),
      group('Synchronisation',
        row({ ic: 'cloud', title: 'Cloud status', sub: !user ? 'Connect an account to enable' : st.running ? 'Synchronising…' : `Last sync ${relativeTime(st.lastSyncAt)}`, value: `${st.pending} pending${st.conflicts ? ` · ${st.conflicts} conflicts` : ''}`, onClick: () => navigate('/settings/sync') })),
      group('Application',
        row({ ic: 'globe', title: 'Language & region', sub: 'Number, date and currency formatting', value: getLocale(), onClick: languageSheet }),
        row({ ic: 'info', title: 'About LEDGER X', value: `v${Backup.APP_VERSION}`, onClick: () => navigate('/settings/about') }),
        row({ ic: 'shield', title: 'Privacy', sub: 'Your data stays on this device unless you connect a cloud account', onClick: () => navigate('/settings/about') })));
  }
  async function languageSheet() {
    const locales = [['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['tr-TR', 'Türkçe (Türkiye) — formatting'], ['de-DE', 'Deutsch — formatting'], ['fr-FR', 'Français — formatting'], ['es-ES', 'Español — formatting'], ['ar-AE', 'العربية — formatting'], ['ja-JP', '日本語 — formatting']];
    actionSheet('Language & region', locales.map(([v, l]) => ({ label: l, icon: getLocale() === v ? 'check' : 'globe', hint: new Intl.NumberFormat(v, { style: 'currency', currency: 'EUR' }).format(1234.5), onSelect: async () => { setLocale(v); await Settings.setSetting('locale', v); notifyChange(); render(); toast('Formatting updated (interface text is English)'); } })));
  }
  ctx.onData(render);
  ctx.onCleanup(Sync.onSyncStatus(() => render()));
  await render();
  return { title: 'Settings', el: host };
}

// ---------------------------------------------------------------- sections

export async function SettingsSectionPage({ section }, ctx) {
  const pages = { account: accountPage, business: businessPage, taxes: taxesPage, data: dataPage, sync: syncPage, about: aboutPage };
  const fn = pages[section];
  if (!fn) throw new Error('Unknown settings section');
  return fn(ctx);
}

async function accountPage(ctx) {
  const host = h('div', { class: 'stack-lg' });
  async function render() {
    const cfg = await Auth.getCloudConfig();
    const user = Auth.currentUser();
    const url = textInput({ name: 'url', value: cfg.url, placeholder: 'https://your-project.supabase.co', inputmode: 'url' });
    const key = textInput({ name: 'anonKey', value: cfg.anonKey, placeholder: 'anon public key' });
    const cfgCard = card(h('div', { class: 'card-body stack' },
      h('div', { style: { fontWeight: 600 } }, 'Supabase project'),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, 'LEDGER X syncs with your own Supabase project. Use the anon (public) key — never the service-role key. Row Level Security keeps each account’s data private.'),
      field('Project URL', url, { name: 'url' }), field('Anon key', key, { name: 'anonKey' }),
      h('div', { class: 'row' }, (() => { const b = h('button', { class: 'btn' }, 'Save project settings'); b.addEventListener('click', busy(b, async () => { try { await Auth.setCloudConfig({ url: url.value, anonKey: key.value }); toast('Cloud project saved'); render(); } catch (e) { toastError(e); } })); return b; })())));
    if (user) {
      const name = textInput({ name: 'display_name', value: user.user_metadata?.display_name || '' });
      replace(host,
        card(h('div', { class: 'card-body stack' },
          h('div', { class: 'row' }, h('div', { class: 'avatar' }, icon('user')), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, user.email), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Signed in · data synchronises automatically')), badge('success', 'Connected')),
          field('Display name', name),
          h('div', { class: 'row wrap' },
            (() => { const b = h('button', { class: 'btn' }, 'Save profile'); b.addEventListener('click', busy(b, async () => { try { await Auth.updateProfile({ display_name: name.value.trim() }); toast('Profile saved'); } catch (e) { toastError(e); } })); return b; })(),
            h('button', { class: 'btn danger', onclick: async () => {
              const pending = Sync.getSyncStatus().pending;
              if (!(await confirmDialog({ title: 'Log out?', message: pending ? `${pending} change(s) have not been uploaded yet. They stay on this device and will sync when you log in again.` : 'Your data stays on this device. Synchronisation stops until you log in again.', confirmLabel: 'Log out', danger: true }))) return;
              await Auth.signOut(); toast('Logged out'); render();
            } }, icon('logout'), 'Log out')))),
        cfgCard);
      return;
    }
    const email = textInput({ name: 'email', type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'you@company.com' });
    const pass = textInput({ name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'At least 8 characters' });
    let mode = 'signin';
    const formHost = h('div', { class: 'stack' });
    const paintForm = () => {
      const submit = h('button', { class: 'btn primary block' }, mode === 'signin' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send reset link');
      submit.addEventListener('click', busy(submit, async () => {
        if (!isOnline()) { toastError(new Error('You are offline. Connect to the internet to sign in.')); return; }
        try {
          if (mode === 'signin') { await Auth.signIn(email.value, pass.value); toast('Signed in — synchronising'); runSync(); render(); }
          else if (mode === 'signup') { const r = await Auth.signUp(email.value, pass.value); if (r.confirmed) { toast('Account created'); render(); } else toast('Check your inbox to confirm your email, then log in', { type: 'info', duration: 6000 }); }
          else { await Auth.resetPassword(email.value); toast('If the account exists, a reset link is on its way', { type: 'info' }); }
        } catch (e) { toastError(e); }
      }));
      replace(formHost,
        segmented([['signin', 'Log in'], ['signup', 'Register'], ['reset', 'Reset password']], mode, (v) => { mode = v; paintForm(); }),
        field('Email', email), mode !== 'reset' ? field('Password', pass) : null, submit);
    };
    paintForm();
    replace(host,
      card(h('div', { class: 'card-body stack' },
        h('div', { class: 'row' }, h('div', { class: 'avatar alt' }, icon('cloud')), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, 'Connect a cloud account'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Optional. Back up and sync across devices.'))),
        cfg.url ? formHost : infoState('Enter your Supabase project details below first.'))),
      infoState('You can keep using LEDGER X without an account. Everything already on this device will be uploaded when you connect.', 'shield'),
      cfgCard);
  }
  await render();
  ctx.onCleanup(Auth.onAuthChange(() => render()));
  return { title: 'Account', el: host };
}

async function businessPage(ctx) {
  const p = await Settings.getBusinessProfile();
  const f = {
    name: textInput({ name: 'name', value: p?.name }), legal_name: textInput({ name: 'legal_name', value: p?.legal_name }),
    email: textInput({ name: 'email', value: p?.email, type: 'email', inputmode: 'email' }), phone: textInput({ name: 'phone', value: p?.phone, type: 'tel' }),
    website: textInput({ name: 'website', value: p?.website, inputmode: 'url' }), tax_id: textInput({ name: 'tax_id', value: p?.tax_id }),
    address: textArea({ name: 'address', value: p?.address, rows: 3 }), payment_details: textArea({ name: 'payment_details', value: p?.payment_details, rows: 3, placeholder: 'IBAN, bank, payment link… shown on invoices' }),
    default_currency: selectInput({ name: 'default_currency', value: p?.default_currency, options: currencyOptions() }),
    default_tax_rate_bp: rateInput({ name: 'default_tax_rate_bp', valueBp: p?.default_tax_rate_bp || 0 }),
    invoice_prefix: textInput({ name: 'invoice_prefix', value: p?.invoice_prefix }), quote_prefix: textInput({ name: 'quote_prefix', value: p?.quote_prefix }),
  };
  let logo = p?.logo_data_url || null;
  const logoBox = h('div', { class: 'logo-preview' });
  const paintLogo = () => replace(logoBox, logo ? h('img', { src: logo, alt: 'Logo' }) : icon('image'));
  paintLogo();
  const pickLogo = async () => {
    const file = await pickFile('image/png,image/jpeg');
    if (!file) return;
    // Downscale to keep the database and PDFs small.
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const sc = Math.min(1, 360 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    logo = c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
    paintLogo();
  };
  const form = h('div', { class: 'stack-lg' },
    card(h('div', { class: 'card-body stack' }, h('div', { class: 'row' }, logoBox, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, 'Logo'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'PNG or JPEG, shown on PDFs')),
      h('button', { class: 'btn sm', onclick: pickLogo }, 'Choose'), logo ? h('button', { class: 'btn sm ghost', onclick: () => { logo = null; paintLogo(); } }, 'Remove') : null))),
    card(h('div', { class: 'card-body form-grid two' },
      field('Business name', f.name, { name: 'name', span: true }), field('Legal name', f.legal_name), field('Tax ID', f.tax_id),
      field('Email', f.email, { name: 'email' }), field('Phone', f.phone, { name: 'phone' }), field('Website', f.website, { span: true }),
      field('Address', f.address, { span: true }), field('Payment information', f.payment_details, { span: true }))),
    card(h('div', { class: 'card-body form-grid two' },
      field('Default currency', f.default_currency, { name: 'default_currency' }), field('Default tax rate %', f.default_tax_rate_bp, { name: 'default_tax_rate_bp' }),
      field('Invoice prefix', f.invoice_prefix, { name: 'invoice_prefix', hint: `Next: ${p.invoice_prefix}${String(p.next_invoice_seq).padStart(4, '0')}` }),
      field('Quotation prefix', f.quote_prefix, { name: 'quote_prefix', hint: `Next: ${p.quote_prefix}${String(p.next_quote_seq).padStart(4, '0')}` }))));
  const save = h('button', { class: 'btn primary lg block' }, icon('check'), 'Save business profile');
  save.addEventListener('click', busy(save, async () => {
    const data = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.bp !== undefined ? el.bp : el.value]));
    data.logo_data_url = logo;
    try { await Settings.saveBusinessProfile(data); toast('Business profile saved'); } catch (e) { if (!showErrors(form, e.errors || {})) toastError(e); }
  }));
  form.appendChild(save);
  return { title: 'Business', el: form, hideFab: true };
}

async function taxesPage(ctx) {
  const host = h('div', { class: 'stack' });
  async function render() {
    const rates = await Settings.listTaxRates();
    replace(host,
      infoState('Define the tax rates you use (VAT, GST, sales tax, KDV…). LEDGER X does not assume any country’s rules; each line item carries its own rate.'),
      rates.length ? card(h('div', { class: 'list' }, rates.map((r) => h('button', { class: 'list-item', onclick: () => edit(r) },
        h('div', { class: 'avatar neutral' }, icon('hash')), h('div', { class: 'grow' }, h('div', { class: 'primary' }, r.name), h('div', { class: 'secondary' }, formatRate(r.rate_bp))), r.is_default ? badge('info', 'Default') : null))))
        : card(emptyState({ art: 'chart', title: 'No tax rates', text: 'Add the rates you charge so you can pick them quickly on invoices.' })),
      h('button', { class: 'btn', onclick: () => edit() }, icon('plus'), 'Add tax rate'));
  }
  async function edit(r) {
    const name = textInput({ name: 'name', value: r?.name, placeholder: 'e.g. VAT standard' });
    const rate = rateInput({ name: 'rate_bp', valueBp: r?.rate_bp ?? 0 });
    let def = !!r?.is_default;
    const body = h('div', { class: 'form-grid' }, field('Name', name, { name: 'name' }), field('Rate %', rate, { name: 'rate_bp' }), toggle({ checked: def, label: 'Default for new line items', onChange: (v) => { def = v; } }));
    await openSheet({
      title: r ? 'Edit tax rate' : 'New tax rate', body,
      footer: (close) => [
        r ? h('button', { class: 'btn danger', onclick: async () => { await Settings.deleteTaxRate(r.id); toast('Deleted'); close(); render(); } }, 'Delete') : h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        (() => { const b = h('button', { class: 'btn primary' }, 'Save'); b.addEventListener('click', busy(b, async () => {
          try {
            await Settings.saveTaxRate({ id: r?.id, name: name.value, rate_bp: rate.bp, is_default: def });
            if (def) { const p = await Settings.getBusinessProfile(); await Settings.saveBusinessProfile({ ...p, default_tax_rate_bp: rate.bp }); }
            toast('Saved'); close(); render();
          } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
        })); return b; })()],
    });
  }
  await render();
  return { title: 'Tax rates', el: host };
}

async function dataPage(ctx) {
  const host = h('div', { class: 'stack-lg' });
  async function render() {
    const [info, history] = await Promise.all([databaseInfo(), Backup.backupHistory()]);
    const backupBtn = h('button', { class: 'btn primary' }, icon('archive'), 'Create full backup');
    backupBtn.addEventListener('click', busy(backupBtn, async () => {
      try {
        const b = await Backup.createBackup();
        const r = await saveFile(b.fileName, b.json, 'application/json', { share: true, title: 'LEDGER X backup' });
        await Backup.recordBackup({ ...b, location: r.location });
        toast(`Backup saved (${formatNumber(b.doc.record_count)} records)`);
        render();
      } catch (e) { toastError(e); }
    }));
    replace(host,
      card(h('div', { class: 'card-body stack' },
        h('div', { style: { fontWeight: 600 } }, 'Backup'), h('p', { class: 'muted', style: { fontSize: '13px' } }, 'A single JSON file with every business record, settings and Database Studio projects, protected by a SHA-256 checksum.'),
        h('div', { class: 'row wrap' }, backupBtn, h('button', { class: 'btn', onclick: restoreFlow }, icon('upload'), 'Restore from backup')))),
      h('div', null, sectionTitle('Export'), card(h('div', { class: 'list' },
        ...['invoices', 'invoice_items', 'customers', 'products', 'payments', 'quotations', 'expenses'].map((t) => h('button', { class: 'list-item', onclick: async () => {
          try { const r = await saveFile(`ledgerx-${t}-${todayISO()}.csv`, await Backup.exportTableCSV(t), 'text/csv', { share: true }); toast(`Exported to ${r.location}`); } catch (e) { toastError(e); }
        } }, h('div', { class: 'avatar neutral' }, icon('download')), h('div', { class: 'grow' }, h('div', { class: 'primary' }, `${t.replace('_', ' ')} (CSV)`)), icon('chevronRight', 'chev')))))),
      h('div', null, sectionTitle('Backup history'), history.length ? card(h('div', { class: 'list' }, history.map((b) => h('div', { class: 'list-item' },
        h('div', { class: 'avatar alt' }, icon('archive')), h('div', { class: 'grow' }, h('div', { class: 'primary' }, formatDateTime(b.created_at)), h('div', { class: 'secondary' }, `${formatNumber(b.record_count)} records · ${formatBytes(b.size_bytes)} · ${b.kind}${b.location ? ` · ${b.location}` : ''}`)),
        h('span', { class: 'kbd', title: b.checksum }, b.checksum.slice(0, 8))))))
        : card(h('div', { class: 'card-body muted' }, 'No backups yet.'))),
      h('div', null, sectionTitle('Database information'), card(h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
        h('dt', 'Engine'), h('dd', `SQLite (${info.driver})`), h('dt', 'Database'), h('dd', info.name), h('dt', 'Schema version'), h('dd', `${info.schemaVersion} of ${info.latestVersion}`),
        h('dt', 'Size'), h('dd', formatBytes(info.sizeBytes)), h('dt', 'Tables'), h('dd', String(info.tableCount)), h('dt', 'Records'), h('dd', formatNumber(info.records)))),
        h('div', { class: 'card-body', style: { borderTop: '1px solid var(--border)', paddingTop: '12px' } }, h('button', { class: 'btn sm', onclick: () => navigate('/studio/__business__') }, icon('database'), 'Browse in Studio')))));
  }
  async function restoreFlow() {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    const text = await file.text();
    const v = await Backup.validateBackup(text);
    let mode = 'merge';
    await openSheet({
      title: 'Restore backup',
      body: h('div', { class: 'stack' },
        v.ok ? h('div', { class: 'state-info' }, icon('check'), h('div', `Valid backup from ${formatDateTime(v.createdAt)} · ${formatNumber(Object.values(v.summary).reduce((a, b) => a + b, 0))} records · ${v.projects} Studio project(s). Checksum verified.`))
          : h('div', { class: 'state-error' }, icon('alert'), h('div', h('b', 'This backup cannot be restored'), h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, v.errors.map((e) => h('li', e))))),
        v.ok ? card(h('div', { class: 'card-body' }, h('dl', { class: 'kv' }, Object.entries(v.summary).filter(([, n]) => n).flatMap(([t, n]) => [h('dt', t), h('dd', formatNumber(n))])))) : null,
        v.ok ? segmented([['merge', 'Add missing records'], ['replace', 'Replace everything']], mode, (m) => { mode = m; document.querySelector('#lx-restore-hint').textContent = hint(m); }) : null,
        v.ok ? h('p', { id: 'lx-restore-hint', class: 'muted', style: { fontSize: '13px' } }, hint('merge')) : null),
      footer: (close) => v.ok ? [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), (() => { const b = h('button', { class: 'btn primary' }, 'Restore'); b.addEventListener('click', busy(b, async () => {
        if (mode === 'replace' && !(await confirmDialog({ title: 'Replace all business data?', message: 'Current records on this device are replaced by the backup. A safety backup of the current data is created and saved first.', confirmLabel: 'Replace', danger: true }))) return;
        try {
          const r = await Backup.restoreBackup(text, { mode });
          if (r.safety) { const s = await saveFile(r.safety.fileName, r.safety.json, 'application/json'); await Backup.recordBackup({ ...r.safety, location: s.location, kind: 'pre-restore' }); }
          const n = Object.values(r.inserted).reduce((a, b) => a + b, 0);
          const sk = Object.values(r.skipped).reduce((a, b) => a + b, 0);
          toast(`Restored ${n} records${sk ? `, kept ${sk} existing` : ''}${r.projects ? `, ${r.projects} project(s)` : ''}`, { duration: 5000 });
          notifyChange(); close(); render();
        } catch (e) { toastError(e); }
      })); return b; })()] : h('button', { class: 'btn', onclick: () => close() }, 'Close'),
    });
  }
  const hint = (m) => (m === 'merge' ? 'Only records that are not on this device are added. Existing records are never overwritten.' : 'All business records on this device are replaced. A safety backup is made first.');
  await render();
  return { title: 'Data & backup', el: host };
}

async function syncPage(ctx) {
  const host = h('div', { class: 'stack-lg' });
  async function render() {
    const st = await Sync.refreshCounts();
    const [conflicts, queue] = await Promise.all([Sync.listConflicts(), Sync.queueDetails()]);
    const user = Auth.currentUser();
    const syncBtn = h('button', { class: 'btn primary', disabled: !user }, icon('refresh'), 'Sync now');
    syncBtn.addEventListener('click', busy(syncBtn, async () => {
      const r = await runSync({ manual: true });
      if (r.skipped === 'offline') toast('You are offline — changes stay queued', { type: 'info' });
      else if (r.error) toastError(new Error(r.error));
      else if (!r.skipped) toast(`Synced · ${r.pushed} up · ${r.pulled} down${r.conflicts ? ` · ${r.conflicts} conflicts` : ''}`);
      render();
    }));
    replace(host,
      card(h('div', { class: 'card-body stack' },
        h('div', { class: 'row' }, h('div', { class: 'avatar alt' }, icon(user ? 'cloud' : 'cloudOff')),
          h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, user ? (isOnline() ? 'Connected' : 'Offline') : 'Cloud sync is off'),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, user ? `Last synchronised ${relativeTime(st.lastSyncAt)}${st.lastSyncAt ? ` (${formatDateTime(st.lastSyncAt)})` : ''}` : 'Connect an account to sync between devices')),
          badge(st.state === 'idle' ? 'success' : st.state === 'error' || st.state === 'conflict' ? 'warning' : 'draft', st.running ? 'Syncing' : st.state)),
        st.lastError ? h('div', { class: 'state-error' }, icon('alert'), st.lastError) : null,
        h('dl', { class: 'kv' }, h('dt', 'Pending changes'), h('dd', String(st.pending)), h('dt', 'Failed (will retry)'), h('dd', String(st.failed)), h('dt', 'Open conflicts'), h('dd', String(st.conflicts))),
        h('div', { class: 'row wrap' }, syncBtn,
          h('button', { class: 'btn', disabled: !st.failed, onclick: async () => { await Sync.retryFailed(); toast('Failed changes re-queued'); render(); } }, 'Retry failed'),
          user ? null : h('button', { class: 'btn', onclick: () => navigate('/settings/account') }, 'Connect account')))),
      h('div', null, sectionTitle(`Conflicts (${conflicts.length})`), conflicts.length ? card(h('div', { class: 'list' }, conflicts.map((c) => h('button', { class: 'list-item', onclick: () => resolveSheet(c) },
        h('div', { class: 'avatar', style: { color: 'var(--warning)', background: 'var(--warning-soft)' } }, icon('alert')),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, `${c.table_name.replace('_', ' ')} · ${c.local.number || c.local.name || c.local.description || c.row_id.slice(0, 8)}`), h('div', { class: 'secondary' }, `Changed on both devices: ${c.fields.join(', ')}`)),
        icon('chevronRight', 'chev')))))
        : card(h('div', { class: 'card-body muted' }, 'No conflicts. Edits to different fields merge automatically.'))),
      h('div', null, sectionTitle('Queue'), queue.length ? card(h('div', { class: 'list' }, queue.slice(0, 50).map((q) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, h('div', { class: 'primary mono', style: { fontSize: '12.5px' } }, `${q.op} ${q.table_name}`), h('div', { class: 'secondary' }, `${q.row_id.slice(0, 8)}… · ${relativeTime(q.created_at)}${q.attempts ? ` · ${q.attempts} attempt(s)` : ''}${q.last_error ? ` · ${q.last_error}` : ''}`)),
        badge(q.status === 'failed' ? 'warning' : 'info', q.status)))))
        : card(h('div', { class: 'card-body muted' }, 'Everything is uploaded.'))),
      infoState('How sync works: every change is saved on this device first and queued. When online, LEDGER X uploads with version checks, downloads newer changes, merges edits to different fields automatically and asks you only when the same field changed on two devices.'));
  }
  async function resolveSheet(c) {
    const picks = Object.fromEntries(c.fields.map((f) => [f, 'local']));
    const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
    const body = h('div', { class: 'stack' }, infoState(`This ${c.table_name.replace('_', ' ')} was changed on this device and on another device. Choose which value to keep for each field.`),
      ...c.fields.map((f) => {
        const L = h('div', { class: 'side picked' }, h('div', { class: 'caps' }, 'This device'), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, fmt(c.local[f])));
        const R = h('div', { class: 'side' }, h('div', { class: 'caps' }, 'Cloud'), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, fmt(c.remote[f])));
        L.onclick = () => { picks[f] = 'local'; L.classList.add('picked'); R.classList.remove('picked'); };
        R.onclick = () => { picks[f] = 'remote'; R.classList.add('picked'); L.classList.remove('picked'); };
        return h('div', null, h('div', { class: 'mono', style: { fontSize: '12.5px', marginBottom: '6px' } }, f), h('div', { class: 'diff' }, L, R));
      }));
    await openSheet({
      title: 'Resolve conflict', body,
      footer: (close) => [h('button', { class: 'btn ghost', onclick: () => close() }, 'Later'), (() => { const b = h('button', { class: 'btn primary' }, 'Keep selected'); b.addEventListener('click', busy(b, async () => {
        try { await Sync.resolveConflict(c.id, picks); toast('Conflict resolved'); close(); runSync(); render(); } catch (e) { toastError(e); }
      })); return b; })()],
    });
  }
  ctx.onCleanup(Sync.onSyncStatus(() => { if (ctx.isCurrent()) render(); }));
  await render();
  return { title: 'Synchronisation', el: host };
}

async function aboutPage() {
  const info = await databaseInfo();
  return {
    title: 'About',
    el: h('div', { class: 'stack-lg' },
      card(h('div', { class: 'card-body stack', style: { alignItems: 'center', textAlign: 'center', padding: '32px 20px' } },
        h('div', { style: { width: '64px', height: '64px' } }, (() => { const m = brandMark(); m.setAttribute('width', 64); m.setAttribute('height', 64); return m; })()),
        h('h2', { style: { letterSpacing: '0.14em', fontSize: '18px' } }, 'LEDGER X'),
        h('div', { class: 'muted' }, 'Professional business management & database studio'),
        h('div', { class: 'pill-row', style: { justifyContent: 'center' } }, badge('info', `Version ${Backup.APP_VERSION}`), badge('draft', `Schema v${info.schemaVersion}`), badge('draft', platformName())))),
      card(h('div', { class: 'card-body stack' }, h('div', { style: { fontWeight: 600 } }, 'Privacy'),
        h('p', { class: 'muted', style: { fontSize: '13.5px' } }, 'LEDGER X is offline-first. Your invoices, customers, products and databases are stored in SQLite on this device. Nothing leaves the device unless you connect your own Supabase project; then data is sent over HTTPS to that project only, protected by Row Level Security so each account can access only its own records. Authentication tokens are kept in Android secure storage. The app has no analytics, ads or third-party trackers, and never logs passwords, tokens or financial data.'))),
      card(h('div', { class: 'card-body stack' }, h('div', { style: { fontWeight: 600 } }, 'Open source'),
        h('p', { class: 'muted', style: { fontSize: '13.5px' } }, 'Built with Capacitor, SQLite, pdf-lib, PDF.js and Supabase. Released under the MIT licence.')))),
  };
}
