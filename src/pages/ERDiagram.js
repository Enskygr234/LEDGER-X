/**
 * Interactive ER diagram generated from the real SQLite schema
 * (PRAGMA table_info / foreign_key_list). Pan, pinch/wheel zoom, drag
 * tables (positions persisted), automatic layered layout, PNG export.
 */
import { h, icon, iconButton, replace, emptyState, card, infoState } from '../components/ui.js';
import { toast, toastError } from '../components/Modal.js';
import { navigate } from '../app/router.js';
import * as S from '../services/studioService.js';
import { saveFile } from '../app/platform.js';
import { studioTabs } from './DatabaseStudio.js';
import { todayISO } from '../utils/formatting.js';

const NS = 'http://www.w3.org/2000/svg';
const NODE_W = 232, HEAD = 34, ROW = 22, PADB = 8, GAP_X = 90, GAP_Y = 36;
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
};

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { bg: v('--bg-2'), card: v('--card'), head: v('--card-2'), border: v('--border-strong'), text: v('--text'), muted: v('--text-3'), accent: v('--accent'), warning: v('--warning'), accent2: v('--accent-2'), grid: v('--grid') };
}

export function autoLayout(tables, vertical = false) {
  // Level = longest chain of foreign keys pointing to parents; parents on the left.
  const byName = new Map(tables.map((t) => [t.name, t]));
  const level = new Map();
  const visit = (name, stack = new Set()) => {
    if (level.has(name)) return level.get(name);
    if (stack.has(name)) return 0;
    stack.add(name);
    const t = byName.get(name);
    let lv = 0;
    for (const fk of t?.foreignKeys || []) if (fk.table !== name && byName.has(fk.table)) lv = Math.max(lv, visit(fk.table, stack) + 1);
    level.set(name, lv);
    return lv;
  };
  tables.forEach((t) => visit(t.name));
  const cols = new Map();
  for (const t of tables) { const l = level.get(t.name); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(t); }
  const pos = {};
  if (vertical) {
    // Portrait phones: one level per band, top to bottom, tables side by side.
    let y = 40;
    for (const l of [...cols.keys()].sort((a, b) => a - b)) {
      const list = cols.get(l);
      let x = 40, bandH = 0;
      for (const t of list) { pos[t.name] = { x, y }; x += NODE_W + 40; bandH = Math.max(bandH, HEAD + t.columns.length * ROW + PADB); }
      y += bandH + 70;
    }
    return pos;
  }
  for (const [l, list] of cols) {
    let y = 40;
    for (const t of list.sort((a, b) => b.foreignKeys.length - a.foreignKeys.length || a.name.localeCompare(b.name))) {
      pos[t.name] = { x: 40 + l * (NODE_W + GAP_X), y };
      y += HEAD + t.columns.length * ROW + PADB + GAP_Y;
    }
  }
  return pos;
}

export async function ERDiagramPage({ pid }, ctx) {
  const project = await S.getProject(pid);
  if (!project) throw new Error('Database not found');
  const { tables, layout } = await S.introspect(pid);
  const el = h('div', { class: 'stack' }, studioTabs(pid, 'er'));
  if (!tables.length) {
    el.appendChild(card(emptyState({ art: 'database', title: 'Nothing to draw yet', text: 'The diagram is generated from your real tables and foreign keys.', action: project.readOnly ? null : h('button', { class: 'btn primary', onclick: () => navigate(`/studio/${pid}`) }, 'Create a table') })));
    return { title: 'ER diagram', el };
  }
  const P = palette();
  const saved = Object.fromEntries(layout.filter((l) => l.pos_x !== null).map((l) => [l.table_name, { x: l.pos_x, y: l.pos_y }]));
  const narrow = () => window.innerWidth < 640;
  const auto = autoLayout(tables, narrow());
  const pos = Object.fromEntries(tables.map((t) => [t.name, saved[t.name] || auto[t.name]]));
  const view = { x: 0, y: 0, k: 1 };

  const svg = s('svg', { role: 'img', 'aria-label': `Entity relationship diagram of ${project.name}` });
  const root = s('g');
  const edgesG = s('g');
  const nodesG = s('g');
  root.append(edgesG, nodesG);
  svg.appendChild(root);
  const nodeEls = new Map();
  let selected = null;

  const colY = (t, colName) => {
    const i = t.columns.findIndex((c) => c.name === colName);
    return HEAD + (i < 0 ? 0 : i) * ROW + ROW / 2 + 2;
  };
  const nodeH = (t) => HEAD + t.columns.length * ROW + PADB;

  function drawNode(t) {
    const g = s('g', { class: 'er-node', cursor: 'move' });
    g.appendChild(s('rect', { class: 'body', width: NODE_W, height: nodeH(t), rx: 12, fill: P.card, stroke: P.border, 'stroke-width': 1 }));
    g.appendChild(s('path', { d: `M0,12 a12,12 0 0 1 12,-12 h${NODE_W - 24} a12,12 0 0 1 12,12 v${HEAD - 12} h-${NODE_W} z`, fill: P.head }));
    g.appendChild(s('line', { x1: 0, x2: NODE_W, y1: HEAD, y2: HEAD, stroke: P.border, 'stroke-width': 1 }));
    g.appendChild(s('text', { x: 14, y: 22, fill: P.text, 'font-size': 13, 'font-weight': 600, 'font-family': 'Inter, Roboto, system-ui, sans-serif' }, t.name));
    g.appendChild(s('text', { x: NODE_W - 12, y: 22, fill: P.muted, 'font-size': 10.5, 'text-anchor': 'end', 'font-family': 'Inter, Roboto, system-ui, sans-serif' }, `${t.rowCount} rows`));
    t.columns.forEach((c, i) => {
      const y = HEAD + i * ROW + 15 + 2;
      const tagX = 14;
      if (c.pk) g.appendChild(s('text', { x: tagX, y, fill: P.warning, 'font-size': 9.5, 'font-weight': 700, 'font-family': 'Inter, Roboto, sans-serif' }, 'PK'));
      else if (c.fk) g.appendChild(s('text', { x: tagX, y, fill: P.accent, 'font-size': 9.5, 'font-weight': 700, 'font-family': 'Inter, Roboto, sans-serif' }, 'FK'));
      else if (c.unique) g.appendChild(s('text', { x: tagX, y, fill: P.accent2, 'font-size': 9.5, 'font-weight': 700, 'font-family': 'Inter, Roboto, sans-serif' }, 'UQ'));
      const label = c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name;
      g.appendChild(s('text', { x: 38, y, fill: P.text, 'font-size': 12, 'font-weight': c.pk ? 600 : 400, 'font-family': 'Inter, Roboto, system-ui, sans-serif' }, label));
      g.appendChild(s('text', { x: NODE_W - 12, y, fill: P.muted, 'font-size': 10.5, 'text-anchor': 'end', 'font-family': 'ui-monospace, Menlo, monospace' }, `${c.type || 'ANY'}${c.notNull ? '' : '?'}`));
    });
    g.addEventListener('dblclick', () => navigate(`/studio/${pid}/t/${encodeURIComponent(t.name)}`));
    nodesG.appendChild(g);
    nodeEls.set(t.name, g);
    g.dataset.table = t.name;
  }
  const place = (name) => { const p = pos[name]; nodeEls.get(name).setAttribute('transform', `translate(${p.x},${p.y})`); };

  function drawEdges() {
    edgesG.replaceChildren();
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        const target = tables.find((x) => x.name === fk.table);
        if (!target) continue;
        const a = pos[t.name], b = pos[target.name];
        const ay = a.y + colY(t, fk.from);
        const by = b.y + colY(target, fk.to || target.columns.find((c) => c.pk)?.name);
        let ax, bx, c1, c2;
        if (t === target) { ax = a.x + NODE_W; bx = a.x + NODE_W; c1 = ax + 60; c2 = bx + 60; }
        else if (a.x > b.x + NODE_W / 2) { ax = a.x; bx = b.x + NODE_W; c1 = ax - 50; c2 = bx + 50; }
        else if (a.x + NODE_W / 2 < b.x) { ax = a.x + NODE_W; bx = b.x; c1 = ax + 50; c2 = bx - 50; }
        else { ax = a.x; bx = b.x; c1 = ax - 60; c2 = bx - 60; }
        edgesG.appendChild(s('path', { d: `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`, fill: 'none', stroke: P.accent, 'stroke-width': 1.6, opacity: 0.8 }));
        // crow's foot (many) at the child, bar (one) at the parent
        const dir = c1 > ax ? 1 : -1;
        edgesG.appendChild(s('path', { d: `M${ax + dir * 10},${ay} L${ax},${ay - 6} M${ax + dir * 10},${ay} L${ax},${ay + 6} M${ax + dir * 10},${ay} L${ax},${ay}`, stroke: P.accent, 'stroke-width': 1.6, fill: 'none' }));
        const dir2 = c2 > bx ? 1 : -1;
        edgesG.appendChild(s('path', { d: `M${bx + dir2 * 8},${by - 6} L${bx + dir2 * 8},${by + 6}`, stroke: P.accent, 'stroke-width': 1.6 }));
        edgesG.appendChild(s('circle', { cx: ax, cy: ay, r: 3, fill: P.accent }));
      }
    }
  }
  const applyView = () => root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);

  tables.forEach(drawNode);
  tables.forEach((t) => place(t.name));
  drawEdges();

  // ---- interactions
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), k: view.k, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, vx: view.x, vy: view.y };
      drag = null;
      return;
    }
    const node = e.target.closest?.('.er-node');
    if (node) {
      const name = node.dataset.table;
      const w = toWorld(e.clientX, e.clientY);
      drag = { type: 'node', name, dx: w.x - pos[name].x, dy: w.y - pos[name].y, moved: false };
      nodesG.appendChild(node);
      if (selected) selected.classList.remove('sel');
      selected = node; node.classList.add('sel');
      node.querySelector('rect.body').setAttribute('stroke', P.accent);
      for (const n of nodeEls.values()) if (n !== node) n.querySelector('rect.body').setAttribute('stroke', P.border);
    } else {
      drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      svg.classList.add('dragging');
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const k = Math.min(2.5, Math.max(0.25, pinch.k * (Math.hypot(p1.x - p2.x, p1.y - p2.y) / pinch.d)));
      const r = svg.getBoundingClientRect();
      const cx = pinch.cx - r.left, cy = pinch.cy - r.top;
      view.x = cx - ((cx - pinch.vx) * k) / pinch.k;
      view.y = cy - ((cy - pinch.vy) * k) / pinch.k;
      view.k = k;
      applyView();
      return;
    }
    if (!drag) return;
    if (drag.type === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; applyView(); }
    else {
      const w = toWorld(e.clientX, e.clientY);
      pos[drag.name] = { x: Math.round(w.x - drag.dx), y: Math.round(w.y - drag.dy) };
      drag.moved = true;
      place(drag.name); drawEdges();
    }
  });
  const end = async (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    svg.classList.remove('dragging');
    if (drag?.type === 'node' && drag.moved) {
      const p = pos[drag.name];
      try { await S.saveTablePosition(pid, drag.name, p.x, p.y); } catch { /* non-fatal */ }
    }
    drag = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const k = Math.min(2.5, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = cx - ((cx - view.x) * k) / view.k; view.y = cy - ((cy - view.y) * k) / view.k; view.k = k;
    applyView();
  }, { passive: false });

  const bounds = () => {
    const xs = tables.map((t) => pos[t.name].x), ys = tables.map((t) => pos[t.name].y);
    const xe = tables.map((t) => pos[t.name].x + NODE_W), ye = tables.map((t) => pos[t.name].y + nodeH(t));
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xe), y1: Math.max(...ye) };
  };
  function fit() {
    const b = bounds();
    const r = svg.getBoundingClientRect();
    const k = Math.min(1.4, Math.max(0.25, Math.min((r.width - 40) / (b.x1 - b.x0), (r.height - 40) / (b.y1 - b.y0))));
    view.k = k; view.x = (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k; view.y = (r.height - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
    applyView();
  }
  const zoom = (f) => { const r = svg.getBoundingClientRect(); const cx = r.width / 2, cy = r.height / 2; const k = Math.min(2.5, Math.max(0.25, view.k * f)); view.x = cx - ((cx - view.x) * k) / view.k; view.y = cy - ((cy - view.y) * k) / view.k; view.k = k; applyView(); };

  async function relayout() {
    const a = autoLayout(tables, narrow());
    for (const t of tables) { pos[t.name] = a[t.name]; place(t.name); }
    drawEdges();
    await S.clearLayout(pid);
    fit();
    toast('Automatic layout applied');
  }

  async function exportPng() {
    try {
      const b = bounds();
      const pad = 32;
      const w = b.x1 - b.x0 + pad * 2, hgt = b.y1 - b.y0 + pad * 2;
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', NS);
      clone.setAttribute('width', w); clone.setAttribute('height', hgt);
      clone.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
      clone.querySelector('g').setAttribute('transform', `translate(${pad - b.x0},${pad - b.y0})`);
      clone.insertBefore(s('rect', { width: w, height: hgt, fill: P.bg }), clone.firstChild);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = hgt * scale;
      const g = canvas.getContext('2d');
      g.scale(scale, scale); g.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await saveFile(`${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-er-${todayISO()}.png`, bytes, 'image/png', { share: true });
      toast(`Diagram exported to ${r.location}`);
    } catch (e) { toastError(e); }
  }

  const wrap = h('div', { class: 'er-wrap' }, svg, h('div', { class: 'er-tools' },
    iconButton('zoomIn', { title: 'Zoom in', onClick: () => zoom(1.2) }),
    iconButton('zoomOut', { title: 'Zoom out', onClick: () => zoom(1 / 1.2) }),
    iconButton('maximize', { title: 'Fit to screen', onClick: fit }),
    iconButton('layout', { title: 'Automatic layout', onClick: relayout }),
    iconButton('image', { title: 'Export as PNG', onClick: exportPng })));
  el.append(wrap, h('div', { class: 'muted', style: { fontSize: '12px' } }, `${tables.length} tables · ${tables.reduce((a, t) => a + t.foreignKeys.length, 0)} relationships · drag to move · pinch or scroll to zoom · double-tap a table to open it`));
  requestAnimationFrame(() => requestAnimationFrame(fit));
  return { title: 'ER diagram', el, hideFab: true, actions: [iconButton('image', { title: 'Export PNG', onClick: exportPng })] };
}
