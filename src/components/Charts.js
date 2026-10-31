/**
 * Lightweight SVG charts (no external library): line/area, grouped bars,
 * donut and horizontal bar lists. Thin marks, recessive grid, one y-axis,
 * crosshair/per-mark tooltips, a legend whenever there are ≥ 2 series,
 * and a "view as table" toggle for accessibility.
 */
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  return el;
};

let tipEl;
function tip() {
  if (!tipEl) { tipEl = h('div', { class: 'chart-tip hidden', role: 'tooltip' }); document.body.appendChild(tipEl); }
  return tipEl;
}
function showTip(x, y, title, rows) {
  const t = tip();
  t.replaceChildren(h('div', { class: 't' }, title), ...rows.map(([label, value, color]) =>
    h('div', { class: 'r' }, h('span', color ? h('i', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: color, marginRight: '6px' } }) : null, label), h('b', value))));
  t.classList.remove('hidden');
  const w = t.offsetWidth, hgt = t.offsetHeight;
  t.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  t.style.top = `${Math.max(8, y - hgt - 14)}px`;
}
const hideTip = () => tipEl?.classList.add('hidden');
window.addEventListener('scroll', hideTip, true);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function legend(series) {
  if (series.length < 2) return null;
  return h('div', { class: 'chart-legend' }, series.map((sr) => h('span', h('i', { style: { background: sr.color } }), sr.name)));
}

function tableView(labels, series, fmt) {
  return h('div', { class: 'table-wrap', style: { marginTop: '8px' } }, h('table', { class: 'grid' },
    h('thead', h('tr', h('th', ''), series.map((sr) => h('th', { class: 'right' }, sr.name)))),
    h('tbody', labels.map((l, i) => h('tr', h('td', l), series.map((sr) => h('td', { class: 'n' }, fmt(sr.values[i]))))))));
}

function withTableToggle(chartNode, labels, series, fmt) {
  const wrap = h('div', chartNode);
  let table = null;
  const btn = h('button', { class: 'btn sm ghost', style: { marginTop: '4px', paddingLeft: 0, color: 'var(--text-3)' },
    onclick: () => {
      if (table) { table.remove(); table = null; btn.textContent = 'View as table'; } else { table = tableView(labels, series, fmt); wrap.appendChild(table); btn.textContent = 'Hide table'; }
    } }, 'View as table');
  wrap.appendChild(btn);
  return wrap;
}

/**
 * Line chart. series: [{ name, values: number[], color }], labels: string[].
 * opts: { height, format(v), axisFormat(v), area }
 */
export function lineChart({ labels, series, height = 200, format = String, axisFormat = format, area = true }) {
  const W = 640, H = height, padL = 52, padR = 12, padT = 12, padB = 26;
  const max = niceMax(Math.max(0, ...series.flatMap((x) => x.values)));
  const n = labels.length;
  const x = (i) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Line chart: ${series.map((x) => x.name).join(', ')}` });
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    svg.appendChild(s('line', { class: 'gridline', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const t = s('text', { x: padL - 8, y: y(v) + 3.5, 'text-anchor': 'end' }); t.textContent = axisFormat(v); svg.appendChild(t);
  }
  const step = Math.max(1, Math.ceil(n / 7));
  labels.forEach((l, i) => {
    if (i % step && i !== n - 1) return;
    const t = s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }); t.textContent = l; svg.appendChild(t);
  });
  for (const sr of series) {
    const pts = sr.values.map((v, i) => [x(i), y(v)]);
    if (area && series.length === 1) {
      const gid = `g${Math.random().toString(36).slice(2, 8)}`;
      const defs = s('defs');
      const g = s('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
      g.appendChild(s('stop', { offset: '0%', 'stop-color': sr.color, 'stop-opacity': 0.22 }));
      g.appendChild(s('stop', { offset: '100%', 'stop-color': sr.color, 'stop-opacity': 0 }));
      defs.appendChild(g); svg.appendChild(defs);
      svg.appendChild(s('path', { d: `M${pts[0][0]},${y(0)} ${pts.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${pts[pts.length - 1][0]},${y(0)} Z`, fill: `url(#${gid})` }));
    }
    svg.appendChild(s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' '), fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (pts.length <= 12) for (const p of pts) svg.appendChild(s('circle', { cx: p[0], cy: p[1], r: 4, fill: sr.color, stroke: 'var(--card)', 'stroke-width': 2 }));
  }
  // Crosshair hover layer
  const cross = s('line', { class: 'tip-line', y1: padT, y2: H - padB, visibility: 'hidden' });
  const dots = series.map((sr) => { const c = s('circle', { r: 4.5, fill: sr.color, stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' }); svg.appendChild(c); return c; });
  svg.appendChild(cross);
  const hit = s('rect', { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: 'transparent' });
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    series.forEach((sr, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(sr.values[i])); dots[k].setAttribute('visibility', 'visible'); });
    showTip(r.left + (x(i) / W) * r.width, r.top + (y(Math.max(...series.map((sr) => sr.values[i]))) / H) * r.height, labels[i], series.map((sr) => [sr.name, format(sr.values[i]), sr.color]));
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
  svg.appendChild(hit);
  return withTableToggle(h('div', svg, legend(series)), labels, series, format);
}

/** Grouped vertical bars. Same inputs as lineChart. */
export function barChart({ labels, series, height = 200, format = String, axisFormat = format }) {
  const W = 640, H = height, padL = 52, padR = 8, padT = 12, padB = 26;
  const max = niceMax(Math.max(0, ...series.flatMap((x) => x.values)));
  const n = labels.length;
  const band = (W - padL - padR) / Math.max(1, n);
  const gap = 2;
  const bw = Math.max(3, Math.min(22, (band * 0.68 - gap * (series.length - 1)) / series.length));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Bar chart: ${series.map((x) => x.name).join(', ')}` });
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    svg.appendChild(s('line', { class: 'gridline', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const t = s('text', { x: padL - 8, y: y(v) + 3.5, 'text-anchor': 'end' }); t.textContent = axisFormat(v); svg.appendChild(t);
  }
  const step = Math.max(1, Math.ceil(n / 8));
  labels.forEach((l, i) => {
    const cx = padL + band * i + band / 2;
    if (!(i % step) || i === n - 1) { const t = s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }); t.textContent = l; svg.appendChild(t); }
    const groupW = bw * series.length + gap * (series.length - 1);
    series.forEach((sr, k) => {
      const v = sr.values[i];
      const top = y(v), base = y(0);
      const bx = cx - groupW / 2 + k * (bw + gap);
      const hgt = Math.max(0, base - top);
      const r = Math.min(4, bw / 2, hgt);
      // Rounded data end, square baseline.
      const d = hgt <= 0 ? '' : `M${bx},${base} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + bw - r} Q${bx + bw},${top} ${bx + bw},${top + r} V${base} Z`;
      if (d) svg.appendChild(s('path', { d, fill: sr.color }));
    });
    const hit = s('rect', { x: padL + band * i, y: padT, width: band, height: H - padT - padB, fill: 'transparent' });
    const on = (ev) => {
      const rr = svg.getBoundingClientRect();
      showTip(rr.left + (cx / W) * rr.width, ev.clientY, l, series.map((sr) => [sr.name, format(sr.values[i]), sr.color]));
    };
    hit.addEventListener('pointerenter', on); hit.addEventListener('pointermove', on); hit.addEventListener('pointerdown', on);
    hit.addEventListener('pointerleave', hideTip);
    svg.appendChild(hit);
  });
  return withTableToggle(h('div', svg, legend(series)), labels, series, format);
}

/** Donut with an always-visible labelled legend. items: [{ label, value, color, display }] */
export function donutChart({ items, size = 132, centerLabel, centerValue }) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const R = 54, r = 38, C = 64;
  const svg = s('svg', { viewBox: '0 0 128 128', width: size, height: size, role: 'img', 'aria-label': 'Donut chart' });
  let a0 = -Math.PI / 2;
  const gapA = items.filter((i) => i.value > 0).length > 1 ? 0.025 : 0;
  for (const it of items) {
    if (it.value <= 0) continue;
    const a1 = a0 + (it.value / total) * Math.PI * 2;
    const s0 = a0 + gapA / 2, s1 = Math.max(s0 + 0.001, a1 - gapA / 2);
    const large = s1 - s0 > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
    const d = it.value === total
      ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} L${C - 0.01},${C - r} A${r},${r} 0 1 0 ${C},${C - r} Z`
      : `M${p(s0, R)} A${R},${R} 0 ${large} 1 ${p(s1, R)} L${p(s1, r)} A${r},${r} 0 ${large} 0 ${p(s0, r)} Z`;
    const path = s('path', { d, fill: it.color });
    path.addEventListener('pointerenter', (ev) => showTip(ev.clientX, ev.clientY, it.label, [['Share', `${Math.round((it.value / total) * 100)}%`], ['Value', it.display ?? String(it.value)]]));
    path.addEventListener('pointerleave', hideTip);
    svg.appendChild(path);
    a0 = a1;
  }
  if (centerValue !== undefined) {
    const t1 = s('text', { x: C, y: C + 2, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 600, fill: 'var(--text)' }); t1.textContent = centerValue; svg.appendChild(t1);
    const t2 = s('text', { x: C, y: C + 18, 'text-anchor': 'middle', 'font-size': 9.5, fill: 'var(--text-2)' }); t2.textContent = centerLabel || ''; svg.appendChild(t2);
  }
  return h('div', { class: 'donut-wrap' }, svg, h('div', { class: 'legend' }, items.map((it) =>
    h('div', { class: 'li' }, h('i', { style: { background: it.color } }), h('span', it.label), h('span', it.display ?? String(it.value))))));
}

/** Ranked horizontal bars: [{ label, value, display }] */
export function barList(items, color = 'var(--chart-1)') {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h('div', { class: 'bars-h' }, items.map((it) => h('div', { class: 'bar-h' },
    h('span', { class: 'ellipsis' }, it.label), h('b', { class: 'num' }, it.display ?? String(it.value)),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(it.value / max) * 100}%`, background: color } })))));
}
