import { h, icon, card, sectionTitle, emptyState, errorState, badge, avatar, chips, loadingBlock, replace } from '../components/ui.js';
import { openSheet } from '../components/Modal.js';
import { field, dateInput } from '../components/Input.js';
import { barChart, donutChart, lineChart } from '../components/Charts.js';
import * as A from '../services/analyticsService.js';
import { getBusinessProfile } from '../services/settingsService.js';
import { databaseInfo } from '../services/database.js';
import { getSyncStatus, onSyncStatus } from '../services/syncService.js';
import { currentUser } from '../services/authService.js';
import { navigate } from '../app/router.js';
import { formatMoney, formatDate, formatNumber, formatBytes, relativeTime, STATUS_LABELS, todayISO, addDaysISO } from '../utils/formatting.js';

export const RANGE_OPTIONS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom']];
export const STATUS_COLORS = { paid: 'var(--success)', pending: 'var(--chart-1)', partially_paid: 'var(--warning)', overdue: 'var(--danger)', draft: 'var(--chart-6)', cancelled: 'var(--border-strong)' };
const state = { preset: '30d', custom: {} };

export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(y, mo - 1, 1)) + (mo === 1 ? ` ${String(y).slice(2)}` : '');
}

export async function pickCustomRange(current) {
  const from = dateInput({ name: 'from', value: current.from || addDaysISO(todayISO(), -30) });
  const to = dateInput({ name: 'to', value: current.to || todayISO() });
  return openSheet({
    title: 'Custom date range',
    body: h('div', { class: 'form-grid two' }, field('From', from), field('To', to)),
    footer: (close) => [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => close(from.value && to.value ? { from: from.value <= to.value ? from.value : to.value, to: from.value <= to.value ? to.value : from.value } : null) }, 'Apply')],
  });
}

export function rangeChips(st, onChange) {
  return chips(RANGE_OPTIONS.map(([v, l]) => [v, v === 'custom' && st.preset === 'custom' && st.custom.from ? `${formatDate(st.custom.from, 'short')} – ${formatDate(st.custom.to, 'short')}` : l]), st.preset, async (v) => {
    if (v === 'custom') {
      const r = await pickCustomRange(st.custom);
      if (!r) return;
      st.custom = r;
    }
    st.preset = v;
    onChange();
  });
}

function stat(label, value, sub, ic) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon(ic), label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function delta(cur, prev) {
  if (!prev || prev.invoiced_minor === 0) return cur > 0 ? h('span', { class: 'delta up' }, 'New') : null;
  const pct = Math.round(((cur - prev.invoiced_minor) / prev.invoiced_minor) * 100);
  return h('span', { class: ['delta', pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'], title: `vs ${formatDate(prev.from, 'short')} – ${formatDate(prev.to, 'short')}` }, `${pct > 0 ? '↑' : pct < 0 ? '↓' : ''}${Math.abs(pct)}%`);
}

export function invoiceRow(inv, onClick, { docIcon = false } = {}) {
  return h('button', { class: 'list-item', onclick: onClick },
    docIcon ? h('div', { class: 'avatar neutral' }, icon(inv.expiry_date !== undefined ? 'quote' : 'invoice')) : avatar(inv.customer_name || '?'),
    h('div', { class: 'grow' }, h('div', { class: 'primary' }, inv.customer_name || 'No customer'),
      h('div', { class: 'secondary' }, `${inv.number} · ${formatDate(inv.issue_date)}`)),
    h('div', { class: 'trail' }, h('b', { class: 'num' }, formatMoney(inv.total_minor, inv.currency)), badge(inv.status, STATUS_LABELS[inv.status])));
}

export async function DashboardPage(_p, ctx) {
  const root = h('div', { class: 'stack-lg' });
  const profile = await getBusinessProfile();
  const currency = profile?.default_currency || 'USD';
  const fm = (v) => formatMoney(v, currency);
  const fmc = (v) => formatMoney(v, currency, { compact: true });

  const chipsHost = h('div');
  const body = h('div', { class: 'stack-lg' }, loadingBlock(140), loadingBlock(220));
  root.append(h('div', { class: 'stack', style: { gap: '4px' } },
    h('div', { class: 'muted', style: { fontSize: '13px' } }, new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())),
    h('h1', { style: { fontSize: '24px' } }, profile?.name || 'Your business')), chipsHost, body);

  async function load() {
    replace(chipsHost, rangeChips(state, load));
    try {
      const range = A.resolveRange(state.preset, state.custom);
      const chartRange = state.preset === 'year' || state.preset === 'all' || state.preset === 'custom' ? range : { from: `${addDaysISO(todayISO(), -170).slice(0, 7)}-01`, to: todayISO() };
      const [m, months, dist, recent, tx, activity, info] = await Promise.all([
        A.dashboardMetrics({ currency, ...range }),
        A.monthlyRevenue({ currency, ...chartRange }),
        A.statusDistribution({ currency, ...range }),
        A.recentInvoices(5),
        A.recentTransactions(5),
        A.customerActivity(chartRange),
        databaseInfo(),
      ]);
      if (!ctx.isCurrent()) return;
      const anyData = (await A.recentInvoices(1)).length > 0;
      const nodes = [];
      if (!anyData) {
        nodes.push(card(emptyState({ art: 'invoices', title: 'Welcome to LEDGER X', text: 'Everything is stored on this device and works offline. Start by adding a customer and sending your first invoice.',
          action: h('div', { class: 'row wrap', style: { justifyContent: 'center' } },
            h('button', { class: 'btn primary', onclick: () => navigate('/invoices/new') }, icon('plus'), 'Create invoice'),
            h('button', { class: 'btn', onclick: () => navigate('/settings/business') }, 'Set up business')) })));
      }
      nodes.push(h('div', { class: 'card hero' },
        h('div', { class: 'row between' }, h('span', { class: 'caps' }, 'Total revenue'), delta(m.invoiced_minor, m.previous)),
        h('div', { class: 'value', style: { margin: '6px 0 2px' } }, fm(m.invoiced_minor)),
        h('div', { class: 'muted', style: { fontSize: '13px' } }, `${fm(m.collected_minor)} collected · ${m.invoices_total} invoice${m.invoices_total === 1 ? '' : 's'}`),
        m.otherCurrencies.length ? h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '6px' } }, `Showing ${currency}. Also invoiced in ${m.otherCurrencies.join(', ')} — see Analytics.`) : null));
      nodes.push(h('div', { class: 'stat-grid' },
        stat('Outstanding', fm(m.outstanding_minor), m.invoices_overdue ? `${m.invoices_overdue} overdue` : 'All time', 'wallet'),
        stat('Paid invoices', formatNumber(m.invoices_paid), `of ${m.invoices_total} in period`, 'receiptCheck'),
        stat('Unpaid invoices', formatNumber(m.invoices_unpaid), m.invoices_draft ? `${m.invoices_draft} drafts` : 'Pending, partial, overdue', 'clock'),
        stat('Customers', formatNumber(m.customers), `${formatNumber(m.products)} products & services`, 'users')));

      nodes.push(card(h('div', { class: 'card-head' }, h('h3', 'Monthly revenue'), h('span', { class: 'muted', style: { fontSize: '12px' } }, currency)),
        h('div', { class: 'card-body' }, months.some((x) => x.invoiced_minor || x.collected_minor)
          ? barChart({ labels: months.map((x) => monthLabel(x.month)), series: [
            { name: 'Invoiced', values: months.map((x) => x.invoiced_minor), color: 'var(--chart-1)' },
            { name: 'Collected', values: months.map((x) => x.collected_minor), color: 'var(--chart-2)' }], format: fm, axisFormat: fmc })
          : h('p', { class: 'muted' }, 'No revenue in this period yet.'))));

      const total = dist.reduce((a, d) => a + d.count, 0);
      const order = ['paid', 'partially_paid', 'pending', 'overdue', 'draft', 'cancelled'];
      const two = h('div', { class: 'stat-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' } },
        card(h('div', { class: 'card-head' }, h('h3', 'Payment status')), h('div', { class: 'card-body' }, total
          ? donutChart({ items: order.map((s) => dist.find((d) => d.status === s)).filter(Boolean).map((d) => ({ label: STATUS_LABELS[d.status], value: d.count, color: STATUS_COLORS[d.status], display: `${d.count} · ${fmc(d.total_minor)}` })), centerValue: String(total), centerLabel: 'invoices' })
          : h('p', { class: 'muted' }, 'No invoices in this period.'))),
        card(h('div', { class: 'card-head' }, h('h3', 'Customer activity')), h('div', { class: 'card-body' }, activity.length
          ? lineChart({ labels: activity.map((a) => monthLabel(a.month)), series: [{ name: 'Active customers', values: activity.map((a) => a.active_customers), color: 'var(--chart-2)' }], height: 150, format: (v) => `${Math.round(v)}` })
          : h('p', { class: 'muted' }, 'Activity appears once you issue documents.'))));
      nodes.push(two);

      nodes.push(sectionTitle('Recent invoices', h('button', { class: 'btn sm ghost', onclick: () => navigate('/invoices') }, 'See all')));
      nodes.push(recent.length ? card(h('div', { class: 'list' }, recent.map((i) => invoiceRow(i, () => navigate(`/invoices/${i.id}`)))))
        : card(h('div', { class: 'card-body muted' }, 'Invoices you create appear here.')));

      nodes.push(sectionTitle('Recent transactions'));
      nodes.push(tx.length ? card(h('div', { class: 'list' }, tx.map((t) => h('button', { class: 'list-item', onclick: () => navigate(`/invoices/${t.invoice_id}`) },
        h('div', { class: 'avatar alt' }, icon('wallet')),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, t.customer_name || t.number), h('div', { class: 'secondary' }, `${t.number} · ${t.method || 'Payment'} · ${formatDate(t.paid_at)}`)),
        h('b', { class: 'num', style: { color: 'var(--success)' } }, `+${formatMoney(t.amount_minor, t.currency)}`)))))
        : card(h('div', { class: 'card-body muted' }, 'Recorded payments appear here.')));

      const syncLine = h('div', { class: 'secondary' });
      const paintSync = (st) => {
        syncLine.textContent = !currentUser() ? 'Local only — connect an account to sync' : st.running ? 'Synchronising…' : `${st.pending} pending · last sync ${relativeTime(st.lastSyncAt)}${st.conflicts ? ` · ${st.conflicts} conflict(s)` : ''}`;
      };
      paintSync(getSyncStatus());
      ctx.onCleanup(onSyncStatus(paintSync));
      nodes.push(sectionTitle('System'));
      nodes.push(card(h('div', { class: 'list' },
        h('button', { class: 'list-item', onclick: () => navigate('/settings/data') }, h('div', { class: 'avatar neutral' }, icon('database')),
          h('div', { class: 'grow' }, h('div', { class: 'primary' }, 'Local database'), h('div', { class: 'secondary' }, `${formatNumber(info.records)} records · ${formatBytes(info.sizeBytes)} · schema v${info.schemaVersion}`)),
          badge('success', 'Healthy')),
        h('button', { class: 'list-item', onclick: () => navigate('/settings/sync') }, h('div', { class: 'avatar neutral' }, icon('cloud')),
          h('div', { class: 'grow' }, h('div', { class: 'primary' }, 'Cloud synchronisation'), syncLine), icon('chevronRight', 'chev')))));
      replace(body, ...nodes);
    } catch (e) {
      replace(body, errorState(e, load));
    }
  }
  ctx.onData(load);
  load();
  return { title: 'Dashboard', el: root };
}
