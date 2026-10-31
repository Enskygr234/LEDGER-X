import { h, icon, card, sectionTitle, errorState, replace, loadingBlock, iconButton, chips, emptyState, segmented, busy } from '../components/ui.js';
import { openSheet, toast, toastError, actionSheet, confirmDialog } from '../components/Modal.js';
import { field, textInput, dateInput, moneyInput, selectInput, showErrors, currencyOptions } from '../components/Input.js';
import { lineChart, barChart, donutChart, barList } from '../components/Charts.js';
import { dataTable } from '../components/DataTable.js';
import * as A from '../services/analyticsService.js';
import * as E from '../services/expenseService.js';
import { listProjects } from '../services/studioService.js';
import { getBusinessProfile, getSetting, setSetting } from '../services/settingsService.js';
import { rangeChips, monthLabel, STATUS_COLORS } from './Dashboard.js';
import { saveFile } from '../app/platform.js';
import { formatMoney, formatNumber, formatBytes, relativeTime, formatQuantity, STATUS_LABELS, toCSV, todayISO, formatDate } from '../utils/formatting.js';
import { toDecimalString, currencyDigits } from '../utils/calculations.js';

const state = { preset: 'year', custom: {}, view: 'financial', currency: null };

async function expenseForm(currency, existing) {
  const d = textInput({ name: 'description', value: existing?.description, placeholder: 'e.g. Software subscription' });
  const v = textInput({ name: 'vendor', value: existing?.vendor });
  const c = textInput({ name: 'category', value: existing?.category, placeholder: 'e.g. Software' });
  const cur = selectInput({ name: 'currency', value: existing?.currency || currency, options: currencyOptions() });
  const amt = moneyInput({ name: 'amount_minor', valueMinor: existing?.amount_minor ?? null, currency: cur.value });
  cur.addEventListener('change', () => amt.setCurrency(cur.value));
  const date = dateInput({ name: 'spent_at', value: existing?.spent_at?.slice(0, 10) || todayISO() });
  const body = h('div', { class: 'form-grid two' }, field('Description', d, { name: 'description', span: true }), field('Amount', amt, { name: 'amount_minor' }), field('Currency', cur),
    field('Date', date, { name: 'spent_at' }), field('Category', c), field('Vendor', v, { span: true }));
  return openSheet({
    title: existing ? 'Edit expense' : 'Add expense', body,
    footer: (close) => {
      const b = h('button', { class: 'btn primary' }, 'Save');
      b.addEventListener('click', busy(b, async () => {
        try { await E.saveExpense({ id: existing?.id, description: d.value, vendor: v.value, category: c.value, currency: cur.value, amount_minor: amt.minor, spent_at: date.value }); toast('Expense saved'); close(true); } catch (e) { if (!showErrors(body, e.errors || {})) toastError(e); }
      }));
      return [h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'), b];
    },
  });
}

export async function AnalyticsPage(_p, ctx) {
  const profile = await getBusinessProfile();
  const used = await A.currenciesInUse();
  state.currency = state.currency || profile.default_currency;
  const currencies = [...new Set([profile.default_currency, ...used])];
  const expensesOn = await getSetting('expenses.enabled', false);
  const head = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack-lg' });
  let report = null;

  async function load() {
    replace(head, segmented([['financial', 'Financial'], ['database', 'Database']], state.view, (v) => { state.view = v; load(); }),
      state.view === 'financial' ? rangeChips(state, load) : null,
      state.view === 'financial' && currencies.length > 1 ? chips(currencies.map((c) => [c, c]), state.currency, (c) => { state.currency = c; load(); }) : null);
    replace(body, loadingBlock(160), loadingBlock(220));
    try {
      if (state.view === 'financial') await financial(); else await database();
    } catch (e) { replace(body, errorState(e, load)); }
  }

  async function financial() {
    const cur = state.currency;
    const fm = (v) => formatMoney(v, cur);
    const fmc = (v) => formatMoney(v, cur, { compact: true });
    const range = A.resolveRange(state.preset, state.custom);
    const [m, months, dist, custs, prods, exp, expList] = await Promise.all([
      A.dashboardMetrics({ currency: cur, ...range }), A.monthlyRevenue({ currency: cur, ...range }), A.statusDistribution({ currency: cur, ...range }),
      A.topCustomers({ currency: cur, ...range, limit: 6 }), A.topProducts({ currency: cur, ...range, limit: 6 }), A.expenseTotals({ currency: cur, ...range }),
      expensesOn ? E.listExpenses({ from: range.from, to: range.to }) : [],
    ]);
    if (!ctx.isCurrent()) return;
    report = { kind: 'financial', currency: cur, range, months, custs, prods, m, exp };
    const net = m.collected_minor - (expensesOn ? exp.total_minor : 0);
    const total = dist.reduce((a, d) => a + d.count, 0);
    if (!m.invoices_total && !months.some((x) => x.invoiced_minor || x.expenses_minor)) {
      replace(body, card(emptyState({ art: 'chart', title: 'No data for this period', text: 'Reports are calculated from your local invoices, payments and expenses. Try a wider date range.' })));
      return;
    }
    const monthRows = months.map((x, i) => {
      const prev = months[i - 1];
      return { Month: monthLabel(x.month), Invoiced: fm(x.invoiced_minor), Collected: fm(x.collected_minor), ...(expensesOn ? { Expenses: fm(x.expenses_minor) } : {}),
        Change: prev && prev.invoiced_minor ? `${Math.round(((x.invoiced_minor - prev.invoiced_minor) / prev.invoiced_minor) * 100)}%` : '—' };
    }).reverse();
    replace(body,
      h('div', { class: 'stat-grid' },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('invoice'), 'Revenue (invoiced)'), h('div', { class: 'value' }, fm(m.invoiced_minor)), h('div', { class: 'sub' }, `${m.invoices_total} invoices`)),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('wallet'), 'Collected'), h('div', { class: 'value' }, fm(m.collected_minor)), h('div', { class: 'sub' }, 'payments received')),
        expensesOn ? h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('receipt'), 'Expenses'), h('div', { class: 'value' }, fm(exp.total_minor)), h('div', { class: 'sub' }, `${exp.count} entries`)) : null,
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('chart'), 'Net balance'), h('div', { class: 'value', style: { color: net < 0 ? 'var(--danger)' : 'var(--text)' } }, fm(net)), h('div', { class: 'sub' }, expensesOn ? 'collected − expenses' : 'collected (expenses off)')),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('clock'), 'Outstanding'), h('div', { class: 'value' }, fm(m.outstanding_minor)), h('div', { class: 'sub' }, `${m.invoices_overdue} overdue`))),
      card(h('div', { class: 'card-head' }, h('h3', 'Revenue over time')), h('div', { class: 'card-body' },
        lineChart({ labels: months.map((x) => monthLabel(x.month)), series: [
          { name: 'Invoiced', values: months.map((x) => x.invoiced_minor), color: 'var(--chart-1)' },
          { name: 'Collected', values: months.map((x) => x.collected_minor), color: 'var(--chart-2)' },
          ...(expensesOn ? [{ name: 'Expenses', values: months.map((x) => x.expenses_minor), color: 'var(--chart-3)' }] : [])], format: fm, axisFormat: fmc, height: 220 }))),
      h('div', { class: 'stat-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' } },
        card(h('div', { class: 'card-head' }, h('h3', 'Best customers')), h('div', { class: 'card-body' }, custs.length ? barList(custs.map((c) => ({ label: c.name, value: c.total_minor, display: fmc(c.total_minor) })), 'var(--chart-1)') : h('p', { class: 'muted' }, 'No billed customers.'))),
        card(h('div', { class: 'card-head' }, h('h3', 'Best-selling items')), h('div', { class: 'card-body' }, prods.length ? barList(prods.map((p) => ({ label: `${p.name} · ${formatQuantity(p.quantity_milli)}`, value: p.total_minor, display: fmc(p.total_minor) })), 'var(--chart-2)') : h('p', { class: 'muted' }, 'No items sold.')))),
      card(h('div', { class: 'card-head' }, h('h3', 'Invoice status')), h('div', { class: 'card-body' }, total ? donutChart({ items: ['paid', 'partially_paid', 'pending', 'overdue', 'draft', 'cancelled'].map((s) => dist.find((d) => d.status === s)).filter(Boolean).map((d) => ({ label: STATUS_LABELS[d.status], value: d.count, color: STATUS_COLORS[d.status], display: `${d.count} · ${fmc(d.total_minor)}` })), centerValue: String(total), centerLabel: 'invoices' }) : h('p', { class: 'muted' }, 'No invoices.'))),
      h('div', null, sectionTitle('Monthly comparison'), dataTable({ columns: Object.keys(monthRows[0] || { Month: 1 }).map((k) => ({ key: k, label: k, numeric: k !== 'Month' })), rows: monthRows })),
      expensesOn ? h('div', null, sectionTitle('Expenses', h('button', { class: 'btn sm', onclick: async () => { if (await expenseForm(cur)) load(); } }, icon('plus'), 'Add')),
        expList.length ? card(h('div', { class: 'list' }, expList.slice(0, 30).map((x) => h('button', { class: 'list-item', onclick: () => actionSheet(x.description, [
          { label: 'Edit', icon: 'edit', onSelect: async () => { if (await expenseForm(cur, x)) load(); } },
          { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => { if (await confirmDialog({ title: 'Delete expense?', message: x.description, confirmLabel: 'Delete', danger: true })) { await E.deleteExpense(x.id); toast('Deleted'); load(); } } }]) },
        h('div', { class: 'avatar neutral' }, icon('receipt')), h('div', { class: 'grow' }, h('div', { class: 'primary' }, x.description), h('div', { class: 'secondary' }, [x.category, x.vendor, formatDate(x.spent_at)].filter(Boolean).join(' · '))),
        h('b', { class: 'num' }, `−${formatMoney(x.amount_minor, x.currency)}`))))) : card(h('div', { class: 'card-body muted' }, 'No expenses in this period.')))
        : card(h('div', { class: 'card-body row between' }, h('div', null, h('div', { style: { fontWeight: 600 } }, 'Expense tracking'), h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Track costs to see your net balance.')),
          h('button', { class: 'btn', onclick: async () => { await setSetting('expenses.enabled', true); ctx.refresh(); } }, 'Enable'))));
  }

  async function database() {
    const [growth, activity, projects, stats] = await Promise.all([A.databaseGrowth(), A.tableActivity(), listProjects(), A.businessDbStats()]);
    if (!ctx.isCurrent()) return;
    report = { kind: 'database', growth, activity, projects };
    const recent = [
      ...activity.filter((a) => a.last).map((a) => ({ name: a.table, where: 'Business', last: a.last })),
      ...projects.filter((p) => p.last_modified_at).map((p) => ({ name: p.name, where: 'Studio project', last: p.last_modified_at })),
    ].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 6);
    replace(body,
      h('div', { class: 'stat-grid' },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('database'), 'Business DB'), h('div', { class: 'value' }, formatBytes(stats.sizeBytes)), h('div', { class: 'sub' }, `schema v${stats.schemaVersion}`)),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('hash'), 'Business records'), h('div', { class: 'value' }, formatNumber(activity.reduce((a, x) => a + x.rows, 0)))),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('layout'), 'Studio projects'), h('div', { class: 'value' }, String(projects.length)), h('div', { class: 'sub' }, formatBytes(projects.reduce((a, p) => a + (p.sizeBytes || 0), 0)))),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('table'), 'Studio tables'), h('div', { class: 'value' }, formatNumber(projects.reduce((a, p) => a + p.tableCount, 0))), h('div', { class: 'sub' }, `${formatNumber(projects.reduce((a, p) => a + p.records, 0))} records`))),
      card(h('div', { class: 'card-head' }, h('h3', 'Database growth'), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'business records')), h('div', { class: 'card-body' }, growth.length
        ? lineChart({ labels: growth.map((g) => monthLabel(g.month)), series: [{ name: 'Total records', values: growth.map((g) => g.total), color: 'var(--chart-5)' }], format: (v) => formatNumber(Math.round(v)) })
        : h('p', { class: 'muted' }, 'No records yet.'))),
      card(h('div', { class: 'card-head' }, h('h3', 'Table sizes')), h('div', { class: 'card-body' }, barList(
        [...activity.map((a) => ({ label: a.table, value: a.rows, display: formatNumber(a.rows) })), ...projects.map((p) => ({ label: `${p.name} (Studio)`, value: p.records, display: formatNumber(p.records) }))].sort((a, b) => b.value - a.value), 'var(--chart-1)'))),
      h('div', null, sectionTitle('Recently modified'), recent.length ? card(h('div', { class: 'list' }, recent.map((r) => h('div', { class: 'list-item' }, h('div', { class: 'avatar neutral' }, icon('table')),
        h('div', { class: 'grow' }, h('div', { class: 'primary' }, r.name), h('div', { class: 'secondary' }, r.where)), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, relativeTime(r.last))))))
        : card(h('div', { class: 'card-body muted' }, 'Nothing yet.'))),
      h('div', null, sectionTitle('Schema overview'), dataTable({ columns: [{ key: 'table', label: 'Table' }, { key: 'columns', label: 'Columns', numeric: true }, { key: 'rows', label: 'Rows', numeric: true }, { key: 'last', label: 'Last change' }],
        rows: activity.map((a) => ({ ...a, last: a.last ? relativeTime(a.last) : '—' })) })));
  }

  async function exportReport() {
    if (!report) return;
    let csv;
    if (report.kind === 'financial') {
      const d = currencyDigits(report.currency);
      csv = [
        `LEDGER X financial report,${report.currency},${report.range.from > '0001' ? report.range.from : 'all'},${report.range.to < '9999' ? report.range.to : todayISO()}`,
        '', toCSV(report.months.map((x) => ({ month: x.month, invoiced: toDecimalString(x.invoiced_minor, d), collected: toDecimalString(x.collected_minor, d), expenses: toDecimalString(x.expenses_minor, d) }))),
        '', toCSV(report.custs.map((c) => ({ customer: c.name, invoices: c.invoices, total: toDecimalString(c.total_minor, d), paid: toDecimalString(c.paid_minor, d) }))),
        '', toCSV(report.prods.map((p) => ({ item: p.name, quantity: formatQuantity(p.quantity_milli), total: toDecimalString(p.total_minor, d) }))),
      ].join('\r\n');
    } else {
      csv = [toCSV(report.activity), '', toCSV(report.growth), '', toCSV(report.projects.map((p) => ({ project: p.name, tables: p.tableCount, records: p.records, size_bytes: p.sizeBytes })))].join('\r\n');
    }
    try { const r = await saveFile(`ledgerx-${report.kind}-report-${todayISO()}.csv`, csv, 'text/csv', { share: true }); toast(`Report exported to ${r.location}`); } catch (e) { toastError(e); }
  }

  ctx.onData(load);
  load();
  return { title: 'Analytics', el: h('div', { class: 'stack-lg' }, head, body), actions: [iconButton('download', { title: 'Export report (CSV)', onClick: exportReport })] };
}
