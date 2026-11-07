// fasdraw editor: state, keyboard-first (vim-flavoured) input and the UI chrome around the canvas.
import { ALIGNS, DARK, DASH, HEADS, KINDS, LIGHT, PALETTE, ROUTES, center, docBounds, docPrims, edgeGeom, fitText, hitTest, inRect, isFilled, makeEdge, makeNode, nodeAlign, nodeDash, nodePrims, rid, snap } from './model.ts';
import type { Align, Dash, Doc, Edge, EdgeStyle, Head, Kind, Node, PathPrim, Pt, Route, Theme } from './model.ts';
import { measure, paint, parseFasdraw, serialize, toExcalidraw, toPdf, toPng, toSvg } from './io.ts';
import { looksLikeDsl, parseDsl, toDsl } from './dsl.ts';

type Drag =
  | { t: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { t: 'move'; start: Pt; orig: [Node, number, number][]; moved: boolean }
  | { t: 'marquee'; start: Pt; base: string[] }
  | { t: 'connect'; from: string; at: Pt }
  | { t: 'reconnect'; e: Edge; end: 'from' | 'to'; fixed: Pt }
  | { t: 'resize'; n: Node; fx: number; fy: number; orig: [number, number, number, number] };
type Tree = { [key: string]: [string, (() => void) | Tree] };
type Fn = (key: string, e: KeyboardEvent) => void;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv'), ctx = cv.getContext('2d')!;
const editor = $<HTMLTextAreaElement>('#editor'), fileInput = $<HTMLInputElement>('#file');
const tools = $('#tools'), menu = $('#menu'), props = $('#props'), statusEl = $('#status');
const wk = $('#whichkey'), helpEl = $('#help'), toastEl = $('#toast');

// ---------- state ----------
let doc: Doc = restore();
let sel: string[] = []; // in pick order (">" chains them in this order)
const view = { x: innerWidth / 2, y: innerHeight / 2, z: 1 }; // screen = world * z + (x, y)
const style: EdgeStyle = { dash: 0, route: 'straight', head: 'end' }; // new edges copy the last style used
let mouse: Pt = [0, 0], mouseIn = false, hover: string | undefined;
let tool: Kind | undefined, lastKind: Kind = 'container', lastDir = 'l';
let mode: 'NORMAL' | 'INSERT' | 'LEADER' = 'NORMAL', leader = '', editing: string | undefined;
let drag: Drag | undefined, spaceDown = false, spacePanned = false;
const touches = new Map<number, Pt>(); // active pointers (screen px), for pinch-zoom
let pinch: { d: number; at: Pt; z: number } | undefined; // finger distance, world point under the midpoint, zoom
let dark = false, theme: Theme = LIGHT, accent = '#6965db', raf = 0, toastTimer = 0;
let past: string[] = [], future: string[] = [], saved = JSON.stringify(doc);

// ---------- lookups ----------
const nodeOf = (id?: string) => doc.nodes.find(n => n.id === id);
const edgeOf = (id?: string) => doc.edges.find(e => e.id === id);
const selNodes = () => sel.map(id => nodeOf(id)).filter((n): n is Node => !!n);
const selEdges = () => doc.edges.filter(e => sel.includes(e.id));
const selected = (): (Node | Edge)[] => [...selNodes(), ...selEdges()];
const geomOf = (e: Edge) => { const a = nodeOf(e.from), b = nodeOf(e.to); return a && b ? edgeGeom(e, a, b) : undefined; };
const toWorld = (sx: number, sy: number): Pt => [(sx - view.x) / view.z, (sy - view.y) / view.z];
const toScreen = ([x, y]: Pt): Pt => [x * view.z + view.x, y * view.z + view.y];
const near = (a: Pt, b: Pt, px: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) < px / view.z;
const screenCenter = () => toWorld(innerWidth / 2, innerHeight / 2);
const ports = (n: Node): Pt[] => {
  const o = 18 / view.z, { x, y, w, h } = n;
  return [[x + w / 2, y - o], [x + w + o, y + h / 2], [x + w / 2, y + h + o], [x - o, y + h / 2]];
};
const corners = (n: Node): Pt[] => [[n.x, n.y], [n.x + n.w, n.y], [n.x, n.y + n.h], [n.x + n.w, n.y + n.h]];
const dashOf = (el: Node | Edge) => ('from' in el ? el.dash : nodeDash(el));
const DIRS: Record<string, Pt> = { h: [-1, 0], j: [0, 1], k: [0, -1], l: [1, 0] };

// ---------- history: whole-document snapshots ----------
function commit() {
  const s = JSON.stringify(doc);
  if (s === saved) return;
  past.push(saved);
  if (past.length > 500) past.shift();
  future = [];
  saved = s;
  persist();
}
function travel(from: string[], to: string[]) {
  const s = from.pop();
  if (!s) return;
  to.push(saved);
  saved = s;
  doc = JSON.parse(s);
  sel = sel.filter(id => nodeOf(id) || edgeOf(id));
  persist();
}
function undo() { travel(past, future); }
function redo() { travel(future, past); }
function persist() { try { localStorage.setItem('fasdraw', serialize(doc)); } catch { /* storage full or blocked */ } }
function restore(): Doc {
  try { const s = localStorage.getItem('fasdraw'); if (s) return parseFasdraw(s); } catch { /* fresh start */ }
  return { nodes: [], edges: [] };
}

// ---------- rendering ----------
function draw() { raf ||= requestAnimationFrame(render); }

function render() {
  raf = 0;
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y);
  const [vx, vy] = toWorld(0, 0);
  paint(ctx, docPrims(doc, theme, measure, [vx, vy, W / view.z, H / view.z]), 3 / view.z); // labels under 3px are skipped
  overlay();
  const g = 20 * view.z; // dot grid is a CSS background: free to pan and zoom
  cv.style.backgroundImage = g < 8 ? 'none' : '';
  cv.style.backgroundSize = `${g}px ${g}px`;
  cv.style.backgroundPosition = `${view.x}px ${view.y}px`;
  ui();
}

function overlay() {
  const px = 1 / view.z;
  ctx.setLineDash([]); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = accent;
  const box = (n: Node) => ctx.strokeRect(n.x - 4 * px, n.y - 4 * px, n.w + 8 * px, n.h + 8 * px);
  selNodes().forEach(box);
  ctx.globalAlpha = 0.3; ctx.lineWidth = 6 * px;
  for (const e of selEdges()) { const g = geomOf(e); if (g) ctx.stroke(new Path2D(g.d)); }
  ctx.globalAlpha = 1; ctx.lineWidth = 1.5 * px;
  if (mode !== 'NORMAL') return;

  const one = sel.length === 1 ? nodeOf(sel[0]) : undefined, h = nodeOf(hover);
  if (one && !drag) for (const [x, y] of corners(one)) {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(x - 4 * px, y - 4 * px, 8 * px, 8 * px);
    ctx.strokeRect(x - 4 * px, y - 4 * px, 8 * px, 8 * px);
  }
  const se = sel.length === 1 && !drag ? edgeOf(sel[0]) : undefined, sg = se && geomOf(se);
  if (sg) for (const q of [sg.pts[0], sg.pts[sg.pts.length - 1]]) {
    ctx.beginPath(); ctx.arc(q[0], q[1], 5 * px, 0, Math.PI * 2);
    ctx.fillStyle = theme.bg; ctx.fill(); ctx.stroke();
  }
  if (drag?.t === 'connect' || drag?.t === 'reconnect') {
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.beginPath(); ctx.moveTo(...(drag.t === 'connect' ? drag.at : drag.fixed)); ctx.lineTo(...mouse); ctx.stroke();
    ctx.setLineDash([]);
    if (h && h.id !== (drag.t === 'connect' ? drag.from : undefined)) box(h);
  } else if (!drag) {
    const target = h ?? one;
    if (target) for (const q of ports(target)) {
      const hot = near(q, mouse, 10);
      ctx.globalAlpha = hot ? 1 : 0.45; ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(q[0], q[1], (hot ? 6 : 4) * px, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (drag?.t === 'marquee') {
    const [x0, y0] = drag.start, [x1, y1] = mouse;
    ctx.fillStyle = accent + '14';
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
  if (tool && mouseIn) {
    ctx.globalAlpha = 0.4;
    paint(ctx, nodePrims(makeNode(tool, ...mouse), theme, measure));
    ctx.globalAlpha = 1;
  }
}

// ---------- UI chrome ----------
const shown = new WeakMap<HTMLElement, string>();
function setHTML(el: HTMLElement, html: string) { if (shown.get(el) !== html) { shown.set(el, html); el.innerHTML = html; } }
const DASH_NAMES = ['solid', 'dashed', 'dotted'];
const HEAD_GLYPH: Record<Head, string> = { end: '→', both: '↔', none: '—' };
const icon = (d: string, extra = '') => `<svg viewBox="0 0 28 12"><path d="${d}"${extra}/></svg>`;
const ROUTE_D: Record<Route, string> = { straight: 'M3 10L25 2', elbow: 'M3 10H14V2H25', curve: 'M3 10C15 10 13 2 25 2' };
const ALIGN_D: Record<Align, string> = { left: 'M3 2H25M3 6H17M3 10H21', center: 'M3 2H25M8 6H20M5 10H23', right: 'M3 2H25M11 6H25M7 10H25' };
const HEAD_D: Record<Head, string> = { end: 'M3 6H24M19 2L24 6L19 10', both: 'M4 6H24M9 2L4 6L9 10M19 2L24 6L19 10', none: 'M3 6H25' };

function ui() {
  $('#empty').hidden = doc.nodes.length > 0;
  setHTML(statusEl, `<b class="mode ${mode}">${mode}</b>${sel.length ? `<span>${sel.length} selected</span>` : ''}`
    + `<span title="Style for new edges">new edges: ${style.route} · ${DASH_NAMES[style.dash]} · ${HEAD_GLYPH[style.head]}</span><span>${Math.round(view.z * 100)}%</span>`);
  for (const b of tools.querySelectorAll<HTMLElement>('[data-kind]')) b.classList.toggle('on', b.dataset.kind === tool);
  renderProps();
  wk.hidden = mode !== 'LEADER';
  if (!wk.hidden) setHTML(wk, `<div class="path"><kbd>Space</kbd>${[...leader].map(k => `<kbd>${k}</kbd>`).join('')}</div><div class="grid">`
    + Object.entries(walk(leader)).map(([k, [label, v]]) => `<kbd>${k}</kbd><span>${label}${typeof v === 'function' ? '' : ' …'}</span>`).join('') + '</div>');
  if (editing) placeEditor();
}

function seg<T extends string | number>(title: string, key: string, act: string, opts: readonly T[], cur: T, ico: (v: T) => string) {
  return `<h4>${title}<kbd>${key}</kbd></h4><div class="row">`
    + opts.map(v => `<button class="opt${v === cur ? ' on' : ''}" data-act="${act}" data-v="${v}" title="${typeof v === 'number' ? DASH_NAMES[v] : v}">${ico(v)}</button>`).join('') + '</div>';
}

function renderProps() {
  const els = selected();
  props.hidden = !els.length;
  if (!els.length) return;
  const first = els[0], ns = selNodes(), es = edgeTargets();
  setHTML(props,
    `<h4>Color<kbd>1–9 · 0</kbd></h4><div class="row">`
    + PALETTE.map((c, i) => `<button class="sw${first.color === c ? ' on' : ''}" style="background:${c}" data-act="color" data-v="${i + 1}" title="${i + 1}"></button>`).join('')
    + `<button class="sw auto${first.color ? '' : ' on'}" data-act="color" data-v="0" title="0 · default for the kind"></button></div>`
    + seg<Dash>('Stroke', '-', 'dash', [0, 1, 2], dashOf(first), v => icon('M3 6H25', v ? ` stroke-dasharray="${DASH[v]}"` : ''))
    + (es.length ? seg('Route', 'e', 'route', ROUTES, es[0].route, v => icon(ROUTE_D[v])) + seg('Arrows', 'a', 'head', HEADS, es[0].head, v => icon(HEAD_D[v])) : '')
    + (ns.length ? seg('Text', 'f', 'align', ALIGNS, nodeAlign(ns[0]), v => icon(ALIGN_D[v])) : '')
    + (ns.some(n => isFilled(n.kind)) ? `<h4>External<kbd>x</kbd></h4><div class="row"><button class="opt wide${ns[0].ext ? ' on' : ''}" data-act="ext">${ns[0].ext ? 'External system' : 'Internal'}</button></div>` : '')
    + `<h4>Actions</h4><div class="row"><button class="opt wide" data-act="del">Delete<kbd>Del</kbd></button></div>`);
}

function kindIcon(k: Kind) {
  if (k === 'text') return '<svg viewBox="0 0 24 24" stroke-width="1.8"><path d="M6 6h12M12 6v13"/></svg>';
  // Toolbar icons are miniatures of the real shapes, straight from the renderer.
  const n = { ...makeNode(k, 0, 0), x: 0, y: 0 }, V = Math.max(n.w, n.h) * 1.12, s = V / 22;
  const paths = nodePrims(n, LIGHT, () => 0).filter((p): p is PathPrim => 'd' in p);
  return `<svg viewBox="${n.w / 2 - V / 2} ${n.h / 2 - V / 2} ${V} ${V}" stroke-width="${1.6 * s}">`
    + paths.map(p => `<path d="${p.d}"${!p.stroke ? ' fill="currentColor" stroke="none"' : p.dash ? ` stroke-dasharray="${DASH[p.dash].map(v => v * s)}"` : ''}/>`).join('') + '</svg>';
}

function toast(msg: string) {
  toastEl.textContent = msg; // textContent: messages may echo file contents
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

function setTheme(d: boolean, save = false) {
  dark = d;
  theme = d ? DARK : LIGHT;
  document.documentElement.dataset.theme = d ? 'dark' : 'light';
  accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  if (save) try { localStorage.setItem('fasdraw-theme', d ? 'dark' : 'light'); } catch { /* ignore */ }
  draw();
}

// ---------- text editing (INSERT mode) ----------
function edit(id?: string) {
  const el = nodeOf(id) ?? edgeOf(id);
  if (!el) return;
  editing = el.id; mode = 'INSERT'; sel = [el.id];
  editor.value = el.text;
  editor.hidden = false;
  autosize(); placeEditor();
  editor.focus(); editor.select();
  draw();
}
function stopEdit() {
  const id = editing;
  if (!id) return;
  editing = undefined; mode = 'NORMAL';
  editor.blur(); editor.hidden = true;
  const n = nodeOf(id);
  if (n?.kind === 'text' && !n.text.trim()) { doc.nodes = doc.nodes.filter(o => o !== n); sel = []; }
  else if (n) fitText(n, measure);
  commit(); draw();
}
function autosize() { editor.style.height = 'auto'; editor.style.height = editor.scrollHeight + 'px'; }
// The input floats under the node so the rendered result stays visible while you type.
function placeEditor() {
  const n = nodeOf(editing), e = edgeOf(editing), g = e && geomOf(e);
  const [cx, top] = n ? toScreen([n.x + n.w / 2, n.y + n.h]) : g ? toScreen(g.mid) : [innerWidth / 2, innerHeight / 2];
  const w = Math.min(innerWidth - 24, Math.max(260, n ? n.w * view.z : 0));
  editor.style.width = w + 'px';
  editor.style.left = Math.max(12, Math.min(innerWidth - w - 12, cx - w / 2)) + 'px';
  editor.style.top = Math.max(12, Math.min(innerHeight - editor.offsetHeight - 12, top + (n ? 12 : 22))) + 'px';
}

// ---------- actions ----------
const nextKind = (n: Node): Kind => (n.kind === 'person' || n.kind === 'boundary' || n.kind === 'text' ? 'container' : n.kind);
const overlaps = (a: Node, b: Node, m: number) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

function create(kind: Kind, [x, y]: Pt) {
  const n = makeNode(kind, x, y);
  doc.nodes.push(n);
  if (kind !== 'boundary' && kind !== 'text') lastKind = kind;
  edit(n.id);
}

// Shape key: convert the selection, or drop a new node at the cursor. Boundary wraps the selection.
function kindKey(kind: Kind) {
  const ns = selNodes();
  if (kind === 'boundary' && ns.length) return wrapIn(ns);
  if (!ns.length) return create(kind, mouseIn ? mouse : screenCenter());
  for (const n of ns) {
    const [cx, cy] = center(n), { w, h } = KINDS[kind];
    Object.assign(n, { kind, w, h, x: snap(cx - w / 2), y: snap(cy - h / 2) });
    fitText(n, measure);
  }
  if (kind !== 'boundary' && kind !== 'text') lastKind = kind;
  commit();
}

function wrapIn(ns: Node[]) {
  const [x, y, w, h] = docBounds({ nodes: ns, edges: [] }, 40);
  const b: Node = { ...makeNode('boundary', 0, 0), x, y, w, h: h + 30 };
  doc.nodes.unshift(b);
  edit(b.id);
}

// Add a connected node next to the selected one (fans out instead of overlapping).
function grow(d: string) {
  lastDir = d;
  const src = nodeOf(sel[sel.length - 1]);
  if (!src) return;
  const n = makeNode(nextKind(src), 0, 0), [dx, dy] = DIRS[d], [cx, cy] = center(src);
  // gaps leave room for a relationship label between the boxes
  const ox = cx + dx * (src.w / 2 + 170 + n.w / 2), oy = cy + dy * (src.h / 2 + 110 + n.h / 2);
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5]) {
    n.x = snap(ox + (dy ? k * (n.w + 40) : 0) - n.w / 2);
    n.y = snap(oy + (dx ? k * (n.h + 40) : 0) - n.h / 2);
    if (!doc.nodes.some(o => o.kind !== 'boundary' && overlaps(o, n, 20))) break;
  }
  doc.nodes.push(n);
  doc.edges.push(makeEdge(src.id, n.id, style));
  reveal(n);
  edit(n.id);
}

function nav(d: string) {
  const last = sel[sel.length - 1], cur = nodeOf(last) ?? nodeOf(edgeOf(last)?.to);
  const [cx, cy] = cur ? center(cur) : screenCenter(), [dx, dy] = DIRS[d];
  let best: Node | undefined, score = Infinity;
  for (const n of doc.nodes) {
    if (n === cur || n.kind === 'boundary') continue;
    const [x, y] = center(n), along = (x - cx) * dx + (y - cy) * dy, off = Math.abs((x - cx) * dy - (y - cy) * dx);
    const s = !cur ? Math.hypot(x - cx, y - cy) : along > 0 && off < along * 2 ? along + off * 2 : Infinity;
    if (s < score) { score = s; best = n; }
  }
  if (best) { sel = [best.id]; reveal(best); }
}

function reveal(n: Node) {
  const [x1, y1] = toScreen([n.x, n.y]), [x2, y2] = toScreen([n.x + n.w, n.y + n.h]);
  if (x1 < 40 || y1 < 70 || x2 > innerWidth - 40 || y2 > innerHeight - 120) {
    const [cx, cy] = center(n);
    view.x = innerWidth / 2 - cx * view.z;
    view.y = innerHeight / 2 - cy * view.z;
  }
}

function chain() {
  const ns = selNodes();
  for (let i = 1; i < ns.length; i++)
    if (!doc.edges.some(e => e.from === ns[i - 1].id && e.to === ns[i].id)) doc.edges.push(makeEdge(ns[i - 1].id, ns[i].id, style));
  commit();
}

function editIncoming() {
  const id = sel[sel.length - 1];
  const e = [...doc.edges].reverse().find(e => e.to === id) ?? doc.edges.find(e => e.from === id);
  if (e) edit(e.id);
}

// Line styling targets selected edges, else the edges touching the selected nodes.
function edgeTargets() {
  const es = selEdges();
  if (es.length) return es;
  const ids = new Set(sel);
  return doc.edges.filter(e => ids.has(e.from) || ids.has(e.to));
}
function setColor(i: number) {
  for (const el of selected()) el.color = i ? PALETTE[i - 1] : undefined;
  commit();
}
function setDash(v?: Dash) {
  const els = selected();
  const next = v ?? (((els.length ? dashOf(els[0]) : style.dash) + 1) % 3) as Dash;
  for (const el of els) el.dash = next;
  if (!els.length || selEdges().length) style.dash = next;
  commit();
}
function setRoute(v?: Route) {
  const es = edgeTargets();
  style.route = v ?? ROUTES[(ROUTES.indexOf((es[0] ?? style).route) + 1) % ROUTES.length];
  for (const e of es) e.route = style.route;
  commit();
}
function setHead(v?: Head) {
  const es = edgeTargets();
  style.head = v ?? HEADS[(HEADS.indexOf((es[0] ?? style).head) + 1) % HEADS.length];
  for (const e of es) e.head = style.head;
  commit();
}
function setAlign(v?: Align) {
  const ns = selNodes();
  if (!ns.length) return;
  const next = v ?? ALIGNS[(ALIGNS.indexOf(nodeAlign(ns[0])) + 1) % ALIGNS.length];
  for (const n of ns) n.align = next;
  commit();
}
function toggleExt() {
  const ns = selNodes();
  if (!ns.length) return;
  const v = !ns[0].ext;
  for (const n of ns) n.ext = v || undefined;
  commit();
}

// Moving a boundary carries whatever sits inside it.
function withContents(ns: Node[]): Node[] {
  const set = new Set(ns);
  for (const b of ns) if (b.kind === 'boundary')
    for (const n of doc.nodes) if (n !== b && inRect(b, center(n), 0)) set.add(n);
  return [...set];
}
function nudge(k: string, big: boolean) {
  const [dx, dy] = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, Pt>)[k];
  for (const n of withContents(selNodes())) { n.x += dx * (big ? 50 : 10); n.y += dy * (big ? 50 : 10); }
  commit();
}
function remove() {
  const ids = new Set(sel);
  doc.nodes = doc.nodes.filter(n => !ids.has(n.id));
  doc.edges = doc.edges.filter(e => !ids.has(e.id) && !ids.has(e.from) && !ids.has(e.to));
  sel = [];
  commit();
}
function align(axis: 0 | 1) {
  const ns = selNodes();
  if (ns.length < 2) return toast('Select 2+ nodes to align');
  const c = center(ns[0])[axis];
  for (const n of ns) axis ? (n.y = c - n.h / 2) : (n.x = c - n.w / 2);
  commit();
}
function distribute(axis: 0 | 1) {
  const ns = selNodes().sort((a, b) => center(a)[axis] - center(b)[axis]);
  if (ns.length < 3) return toast('Select 3+ nodes to distribute');
  const a = center(ns[0])[axis], step = (center(ns[ns.length - 1])[axis] - a) / (ns.length - 1);
  ns.forEach((n, i) => (axis ? (n.y = a + i * step - n.h / 2) : (n.x = a + i * step - n.w / 2)));
  commit();
}
function escape() {
  if (!helpEl.hidden) helpEl.hidden = true;
  else if (!menu.hidden) menu.hidden = true;
  else if (tool) tool = undefined;
  else sel = [];
}
function selectAll() { sel = [...doc.nodes, ...doc.edges].map(x => x.id); }
function zoomAt(sx: number, sy: number, f: number) {
  const z = Math.min(4, Math.max(0.1, view.z * f));
  view.x = sx - ((sx - view.x) * z) / view.z;
  view.y = sy - ((sy - view.y) * z) / view.z;
  view.z = z;
}
function fit() {
  const [x, y, w, h] = docBounds(doc, 60);
  view.z = doc.nodes.length ? Math.min(1.25, innerWidth / w, (innerHeight - 60) / h) : 1;
  view.x = innerWidth / 2 - (x + w / 2) * view.z;
  view.y = innerHeight / 2 - (y + h / 2) * view.z;
}
function newDoc() { doc = { nodes: [], edges: [] }; sel = []; commit(); fit(); }

// ---------- clipboard & files ----------
function subset(ids: string[]): Doc {
  const set = new Set(ids), nodes = withContents(doc.nodes.filter(n => set.has(n.id))), nid = new Set(nodes.map(n => n.id));
  return { nodes, edges: doc.edges.filter(e => nid.has(e.from) && nid.has(e.to)) };
}
function insert(part: Doc, at?: Pt) {
  const map = new Map<string, string>(), [bx, by] = docBounds(part);
  const [dx, dy] = at ? [snap(at[0] - bx), snap(at[1] - by)] : [20, 20];
  const nodes = part.nodes.map(n => { const id = rid(); map.set(n.id, id); return { ...n, id, x: n.x + dx, y: n.y + dy }; });
  const edges = part.edges.map(e => ({ ...e, id: rid(), from: map.get(e.from)!, to: map.get(e.to)! }));
  doc.nodes.push(...nodes);
  doc.edges.push(...edges);
  sel = [...nodes, ...edges].map(x => x.id);
  commit();
}
// Structurizr DSL; `!include` resolves against files opened together (matched by file name).
function readDsl(text: string, files?: Map<string, string>) {
  const missing: string[] = [];
  const model = parseDsl(text, measure, path => {
    const t = files?.get(path.split(/[\\/]/).pop() ?? '');
    if (t === undefined) missing.push(path);
    return t;
  });
  return { model, missing };
}
const missingNote = (missing: string[]) => missing.length ? ` Not found: ${missing.join(', ')}. Open included files together with it.` : '';
async function openFiles(list: Iterable<File>) {
  const files = [...list], texts = new Map<string, string>();
  for (const f of files) texts.set(f.name, await f.text());
  const main = files.find(f => /^\s*workspace\b/m.test(texts.get(f.name)!)) ?? files[0];
  if (main) load(texts.get(main.name)!, main.name, texts);
}
function load(text: string, name: string, files?: Map<string, string>) {
  try {
    const { model: d, missing } = /^\s*\{/.test(text) ? { model: parseFasdraw(text), missing: [] } : readDsl(text, files);
    if (!d.nodes.length) throw new Error('no diagram elements found');
    doc = d; sel = []; commit(); fit(); toast(`Opened ${name}.${missingNote(missing)}`);
  }
  catch (err) { toast(`Can't open ${name}: ${(err as Error).message}`); }
  draw();
}
async function exportAs(fmt: 'png' | 'svg' | 'pdf' | 'excalidraw' | 'dsl' | 'fasdraw') {
  if (fmt !== 'fasdraw' && !doc.nodes.length) return toast('Nothing to export yet');
  try {
    const blob =
      fmt === 'png' ? await toPng(doc, measure)
      : fmt === 'pdf' ? await toPdf(doc, measure)
      : fmt === 'svg' ? new Blob([toSvg(doc, measure)], { type: 'image/svg+xml' })
      : fmt === 'excalidraw' ? new Blob([JSON.stringify(toExcalidraw(doc, measure), null, 2)], { type: 'application/json' })
      : fmt === 'dsl' ? new Blob([toDsl(doc)], { type: 'text/plain' })
      : new Blob([serialize(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diagram.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(`Export failed: ${(err as Error).message}`);
  }
}

// ---------- keymap: one table drives dispatch and the help screen ----------
const KEYS = new Map<string, Fn>(), HELP: [string, string][] = [];
function bind(keys: string, desc: string, fn: Fn, label = keys) { for (const k of keys.split(' ')) KEYS.set(k, fn); HELP.push([label, desc]); }
const section = (title: string) => HELP.push(['', title]);

section('Shapes · drop at cursor, or convert the selection');
for (const k of Object.keys(KINDS) as Kind[]) bind(KINDS[k].key, KINDS[k].name + (k === 'boundary' ? ' · wraps the selection' : ''), () => kindKey(k));
section('Flow');
bind('h j k l', 'Select nearest node ← ↓ ↑ →', k => nav(k));
bind('H J K L', 'Grow: new connected node ← ↓ ↑ →', k => grow(k.toLowerCase()));
bind('Tab', 'Grow again in the last direction (works while typing)', () => grow(lastDir));
bind('>', 'Connect the selected nodes in the order you picked them', chain);
bind('Enter i', 'Edit label', () => edit(sel[0]));
bind('I', 'Label the relationship into the selected node', editIncoming);
section('Style');
bind('1 2 3 4 5 6 7 8 9', 'Color', k => setColor(+k), '1–9');
bind('0', 'Default color for the kind', () => setColor(0));
bind('-', 'Stroke: solid → dashed → dotted', () => setDash());
bind('e', 'Route: straight → elbow → curve', () => setRoute());
bind('a', 'Arrows: end → both → none', () => setHead());
bind('f', 'Text: left → center → right', () => setAlign());
bind('x', 'Toggle external (C4 gray)', toggleExt);
section('Edit & view');
bind('ArrowLeft ArrowRight ArrowUp ArrowDown', 'Nudge (Shift: ×5)', (k, e) => nudge(k, e.shiftKey), '← → ↑ ↓');
bind('Delete Backspace', 'Delete', remove, 'Del');
bind('u', 'Undo', undo);
bind('z', 'Zoom to fit', fit);
bind('Escape', 'Deselect / cancel', escape, 'Esc');
bind('Space', 'Command menu (hold + drag to pan)', (_, e) => { if (!e.repeat) { spaceDown = true; spacePanned = false; } });
bind('?', 'Show / hide this help', toggleHelp);
HELP.push(['Ctrl+Z Ctrl+⇧Z', 'Undo / redo (also Ctrl+R)'], ['Ctrl+C Ctrl+V Ctrl+D', 'Copy / paste / duplicate'], ['Ctrl+S Ctrl+O', 'Save / open .fasdraw']);

const LEADER: Tree = {
  o: ['Open .fasdraw / .dsl', () => fileInput.click()],
  s: ['Save .fasdraw', () => exportAs('fasdraw')],
  e: ['Export', { p: ['PNG', () => exportAs('png')], s: ['SVG', () => exportAs('svg')], d: ['PDF', () => exportAs('pdf')], x: ['Excalidraw', () => exportAs('excalidraw')], t: ['Structurizr DSL', () => exportAs('dsl')] }],
  a: ['Arrange', { r: ['Align in a row', () => align(1)], c: ['Align in a column', () => align(0)], h: ['Distribute horizontally', () => distribute(0)], v: ['Distribute vertically', () => distribute(1)] }],
  n: ['New diagram', newDoc],
  t: ['Toggle dark mode', () => setTheme(!dark, true)],
  z: ['Zoom to fit', fit],
  '?': ['Keyboard help', toggleHelp],
};
function walk(seq: string): Tree { return [...seq].reduce((t, k) => t[k][1] as Tree, LEADER); }
function runSeq(seq: string) { (walk(seq.slice(0, -1))[seq.slice(-1)][1] as () => void)(); }
function commandRows(t: Tree, seq = ''): string {
  return Object.entries(t).map(([k, [label, v]]) => typeof v === 'function'
    ? `<button data-seq="${seq + k}"><span>${label}</span><span>${['Space', ...seq + k].map(c => `<kbd>${c}</kbd>`).join('')}</span></button>`
    : `<div class="grp">${label}</div>${commandRows(v, seq + k)}`).join('');
}

function toggleHelp() {
  helpEl.hidden = !helpEl.hidden;
  setHTML(helpEl, '<h2>Keyboard</h2><div class="cols">'
    + HELP.map(([k, d]) => (k ? `<div class="kv"><span>${d}</span><span>${k.split(' ').map(x => `<kbd>${x}</kbd>`).join('')}</span></div>` : `<h3>${d}</h3>`)).join('')
    + `<h3>Commands</h3>${commandRows(LEADER)}`
    + '<h3>Labels</h3><p>First line is the name. <code>Name [tech]</code> or a <code>[tech]</code> line sets the technology; more lines (<kbd>⇧</kbd><kbd>Enter</kbd>) are the description.</p>'
    + '<h3>Mouse</h3><p>Drag from the dots around a node to connect it; drop on empty space to create a connected node. Drag a selected line\'s end onto another node to reconnect it. Double-click to add or edit. Wheel pans, Ctrl+wheel or pinch zooms, two fingers pan.</p>'
    + '<h3>Diagrams as code</h3><p>Paste or open Structurizr DSL (the open C4 language) to drop in a whole model, laid out for you. Open the files a workspace <code>!include</code>s together with it. <kbd>Space</kbd><kbd>e</kbd><kbd>t</kbd> exports it back, layout included.</p></div>');
}

function modKey(e: KeyboardEvent) {
  const k = e.key.toLowerCase(), cx = innerWidth / 2, cy = innerHeight / 2;
  const fn = ({
    z: e.shiftKey ? redo : undo, y: redo, r: e.shiftKey ? undefined : redo, a: selectAll,
    d: () => sel.length && insert(subset(sel)), s: () => exportAs('fasdraw'), o: () => fileInput.click(),
    '0': () => zoomAt(cx, cy, 1 / view.z), '=': () => zoomAt(cx, cy, 1.2), '+': () => zoomAt(cx, cy, 1.2), '-': () => zoomAt(cx, cy, 1 / 1.2),
  } as Record<string, (() => void) | undefined>)[k];
  if (!fn) return;
  e.preventDefault();
  fn();
  draw();
}

// ---------- events ----------
addEventListener('keydown', e => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
  if (e.ctrlKey || e.metaKey) return modKey(e);
  if (e.altKey) return;
  const k = e.key === ' ' ? 'Space' : e.key;
  if (mode === 'LEADER') {
    e.preventDefault();
    const t = walk(leader), a = Object.hasOwn(t, k) ? t[k] : undefined;
    if (!a) mode = 'NORMAL';
    else if (typeof a[1] === 'function') { mode = 'NORMAL'; a[1](); }
    else leader += k;
    return draw();
  }
  const fn = KEYS.get(k);
  if (!fn) return;
  e.preventDefault();
  fn(k, e);
  draw();
});
// Space opens the command menu on release, unless it was held to pan.
addEventListener('keyup', e => {
  if (e.key !== ' ' || !spaceDown) return;
  spaceDown = false;
  if (!spacePanned && mode === 'NORMAL') { mode = 'LEADER'; leader = ''; }
  spacePanned = false;
  draw();
});
addEventListener('blur', () => { spaceDown = false; });
addEventListener('resize', draw);
// Keep focus (and therefore keys) on the canvas when clicking UI buttons.
addEventListener('mousedown', e => { if ((e.target as Element).closest('button')) e.preventDefault(); });

editor.addEventListener('input', () => {
  const el = nodeOf(editing) ?? edgeOf(editing);
  if (el) el.text = editor.value;
  autosize();
  draw();
});
editor.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.isComposing) return;
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); stopEdit(); }
  else if (e.key === 'Tab') { e.preventDefault(); stopEdit(); grow(lastDir); }
});
editor.addEventListener('blur', stopEdit);

cv.addEventListener('pointerdown', e => {
  e.preventDefault(); // no focus shuffle: a node created on click must keep its label editor focused
  menu.hidden = true; helpEl.hidden = true;
  if (mode === 'LEADER') mode = 'NORMAL';
  stopEdit();
  const p = toWorld(e.clientX, e.clientY);
  mouse = p;
  cv.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) { // second finger: drop whatever the first started and pinch instead
    cancelDrag();
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, at: toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), z: view.z };
    return draw();
  }
  if (touches.size > 2) return;
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { t: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    spacePanned = true;
    return draw();
  }
  if (e.button !== 0) return;
  if (tool) { create(tool, p); tool = undefined; return; }
  const se = sel.length === 1 ? edgeOf(sel[0]) : undefined, sg = se && geomOf(se);
  if (se && sg) {
    const a = sg.pts[0], b = sg.pts[sg.pts.length - 1], end = near(a, p, 10) ? 'from' : near(b, p, 10) ? 'to' : undefined;
    if (end) { drag = { t: 'reconnect', e: se, end, fixed: end === 'from' ? b : a }; return draw(); }
  }
  const one = sel.length === 1 ? nodeOf(sel[0]) : undefined, h = nodeOf(hover) ?? one;
  const port = h && ports(h).find(q => near(q, p, 10));
  if (h && port) { drag = { t: 'connect', from: h.id, at: port }; return draw(); }
  const ci = one ? corners(one).findIndex(q => near(q, p, 10)) : -1;
  if (one && ci >= 0) { const [fx, fy] = corners(one)[3 - ci]; drag = { t: 'resize', n: one, fx, fy, orig: [one.x, one.y, one.w, one.h] }; return draw(); }
  const hit = hitTest(doc, p, 5 / view.z);
  if (hit) {
    if (e.shiftKey) sel = sel.includes(hit) ? sel.filter(s => s !== hit) : [...sel, hit];
    else if (!sel.includes(hit)) sel = [hit];
    drag = { t: 'move', start: p, orig: withContents(selNodes()).map(n => [n, n.x, n.y]), moved: false };
  } else {
    if (!e.shiftKey) sel = [];
    drag = { t: 'marquee', start: p, base: sel };
  }
  draw();
});

cv.addEventListener('pointermove', e => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch) { // zoom by finger spread, keeping the world point under the fingers in place
    const [a, b] = [...touches.values()], z = Math.min(4, Math.max(0.1, (pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d));
    view.z = z;
    view.x = (a[0] + b[0]) / 2 - pinch.at[0] * z;
    view.y = (a[1] + b[1]) / 2 - pinch.at[1] * z;
    return draw();
  }
  const p = toWorld(e.clientX, e.clientY), d = drag;
  mouse = p; mouseIn = true;
  if (!d) {
    // Keep hover while the pointer is in the dot band just outside the node, so the dots are reachable.
    const keep = nodeOf(hover), band = keep && inRect(keep, p, 26 / view.z) && !inRect(keep, p, 0);
    hover = hitTest(doc, p, 4 / view.z, true) ?? (band ? keep.id : undefined);
    const one = sel.length === 1 ? nodeOf(sel[0]) : undefined, h = nodeOf(hover) ?? one;
    const ci = one ? corners(one).findIndex(q => near(q, p, 10)) : -1;
    const se = sel.length === 1 ? edgeOf(sel[0]) : undefined, sg = se && geomOf(se);
    const onEnd = !!sg && (near(sg.pts[0], p, 10) || near(sg.pts[sg.pts.length - 1], p, 10));
    cv.style.cursor = tool || onEnd || (h && ports(h).some(q => near(q, p, 10))) ? 'crosshair'
      : ci >= 0 ? (ci === 0 || ci === 3 ? 'nwse-resize' : 'nesw-resize')
      : hitTest(doc, p, 5 / view.z) ? 'move' : 'default';
  } else if (d.t === 'pan') {
    view.x = d.vx + e.clientX - d.sx;
    view.y = d.vy + e.clientY - d.sy;
  } else if (d.t === 'move') {
    const dx = snap(p[0] - d.start[0]), dy = snap(p[1] - d.start[1]);
    for (const [n, x, y] of d.orig) { n.x = x + dx; n.y = y + dy; }
    d.moved ||= dx !== 0 || dy !== 0;
  } else if (d.t === 'marquee') {
    const [x0, y0] = d.start, x = Math.min(x0, p[0]), y = Math.min(y0, p[1]), w = Math.abs(p[0] - x0), h = Math.abs(p[1] - y0);
    const inside = new Set(doc.nodes.filter(n => n.x >= x && n.y >= y && n.x + n.w <= x + w && n.y + n.h <= y + h).map(n => n.id));
    sel = [...new Set([...d.base, ...inside, ...doc.edges.filter(e => inside.has(e.from) && inside.has(e.to)).map(e => e.id)])];
  } else if (d.t === 'resize') {
    const x = snap(p[0]), y = snap(p[1]), n = d.n;
    n.w = Math.max(40, Math.abs(x - d.fx)); n.h = Math.max(30, Math.abs(y - d.fy));
    n.x = x < d.fx ? d.fx - n.w : d.fx; n.y = y < d.fy ? d.fy - n.h : d.fy;
  } else if (d.t === 'connect' || d.t === 'reconnect') {
    hover = hitTest(doc, p, 4 / view.z, true);
  }
  draw();
});

function cancelDrag() {
  const d = drag;
  drag = undefined;
  if (d?.t === 'move') for (const [n, x, y] of d.orig) { n.x = x; n.y = y; }
  else if (d?.t === 'marquee') sel = d.base;
  else if (d?.t === 'resize') [d.n.x, d.n.y, d.n.w, d.n.h] = d.orig;
}
const lift = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = undefined; };
cv.addEventListener('pointerup', e => {
  lift(e);
  const d = drag;
  drag = undefined;
  if (d?.t === 'reconnect') {
    const to = nodeOf(hover), other = d.end === 'from' ? d.e.to : d.e.from;
    if (to && to.id !== other) { d.e[d.end] = to.id; commit(); }
  } else if (d?.t === 'connect') {
    const to = nodeOf(hover), src = nodeOf(d.from);
    if (to && src && to !== src) {
      const dup = doc.edges.find(e => e.from === src.id && e.to === to.id);
      const e = dup ?? makeEdge(src.id, to.id, style);
      if (!dup) doc.edges.push(e);
      sel = [e.id];
      commit();
    } else if (!to && src && Math.hypot(d.at[0] - mouse[0], d.at[1] - mouse[1]) > 30) {
      const n = makeNode(nextKind(src), ...mouse);
      doc.nodes.push(n);
      doc.edges.push(makeEdge(src.id, n.id, style));
      edit(n.id);
    }
  } else if (d?.t === 'resize' || (d?.t === 'move' && d.moved)) commit();
  draw();
});
cv.addEventListener('pointercancel', e => { lift(e); cancelDrag(); draw(); });
cv.addEventListener('pointerleave', () => { mouseIn = false; if (!drag) hover = undefined; draw(); });

cv.addEventListener('dblclick', e => {
  const p = toWorld(e.clientX, e.clientY), hit = hitTest(doc, p, 5 / view.z);
  if (hit) edit(hit);
  else create(lastKind, p);
});

cv.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1; // Firefox reports lines for mouse wheels
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.01));
  else if (e.shiftKey && !e.deltaX) view.x -= e.deltaY * k;
  else { view.x -= e.deltaX * k; view.y -= e.deltaY * k; }
  draw();
}, { passive: false });

addEventListener('copy', e => {
  if (editing || !sel.length) return;
  e.clipboardData?.setData('text/plain', serialize(subset(sel)));
  e.preventDefault();
});
addEventListener('cut', e => {
  if (editing || !sel.length) return;
  e.clipboardData?.setData('text/plain', serialize(subset(sel)));
  e.preventDefault();
  remove();
  draw();
});
addEventListener('paste', e => {
  if (editing) return;
  const t = e.clipboardData?.getData('text/plain') ?? '';
  const at = mouseIn ? mouse : screenCenter();
  try { insert(parseFasdraw(t), at); }
  catch {
    const { model, missing } = looksLikeDsl(t) ? readDsl(t) : { model: undefined, missing: [] };
    if (model?.nodes.length) { insert(model, at); if (missing.length) toast(missingNote(missing).trim()); return draw(); }
    if (!t.trim()) return;
    const n = makeNode('text', ...at, t.trim());
    fitText(n, measure);
    doc.nodes.push(n);
    sel = [n.id];
    commit();
  }
  draw();
});
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) await openFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', async () => {
  if (fileInput.files?.length) await openFiles(fileInput.files);
  fileInput.value = '';
});

tools.innerHTML = (Object.keys(KINDS) as Kind[]).map(k => (k === 'boundary' || k === 'rect' ? '<i class="sep"></i>' : '')
  + `<button class="btn" data-kind="${k}" title="${KINDS[k].name} (${KINDS[k].key})" aria-label="${KINDS[k].name}">${kindIcon(k)}<kbd>${KINDS[k].key}</kbd></button>`).join('');
tools.addEventListener('click', e => {
  const k = (e.target as Element).closest<HTMLElement>('[data-kind]')?.dataset.kind as Kind | undefined;
  if (!k) return;
  if (selNodes().length) kindKey(k);
  else tool = tool === k ? undefined : k;
  draw();
});
props.addEventListener('click', e => {
  const b = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!b) return;
  const v = b.dataset.v ?? '';
  ({ color: () => setColor(+v), dash: () => setDash(+v as Dash), route: () => setRoute(v as Route), head: () => setHead(v as Head), align: () => setAlign(v as Align), ext: toggleExt, del: remove } as Record<string, () => void>)[b.dataset.act!]?.();
  draw();
});
menu.innerHTML = commandRows(LEADER);
for (const el of [menu, helpEl]) el.addEventListener('click', e => {
  const seq = (e.target as Element).closest<HTMLElement>('[data-seq]')?.dataset.seq;
  if (!seq) return;
  menu.hidden = true;
  runSeq(seq);
  draw();
});
$('#menu-btn').addEventListener('click', () => { menu.hidden = !menu.hidden; });

// ---------- boot ----------
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem('fasdraw-theme'); } catch { /* ignore */ }
setTheme(savedTheme ? savedTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
if (doc.nodes.length) fit();
draw();
