// fasdraw core: document model, C4 conventions, geometry and the display list.
// Pure (no DOM): the same code drives the canvas, every exporter and the node tests.

export type Kind = 'person' | 'system' | 'container' | 'component' | 'database' | 'queue' | 'browser' | 'boundary' | 'rect' | 'ellipse' | 'text';
export type Dash = 0 | 1 | 2; // solid, dashed, dotted
export type Route = 'straight' | 'elbow' | 'curve';
export type Head = 'end' | 'both' | 'none';
export type Align = 'left' | 'center' | 'right';
export type Pt = [number, number];
export interface Node { id: string; kind: Kind; x: number; y: number; w: number; h: number; text: string; color?: string; dash?: Dash; ext?: boolean; align?: Align }
export interface Edge { id: string; from: string; to: string; text: string; color?: string; dash: Dash; route: Route; head: Head }
export interface Doc { nodes: Node[]; edges: Edge[] }
export type EdgeStyle = Pick<Edge, 'dash' | 'route' | 'head'>;
export type Measure = (s: string, size: number, bold?: boolean) => number;
// `detail`: the decoration's size in world units; renderers may skip it when it would be under ~3 screen px.
export interface PathPrim { d: string; fill?: string; stroke?: string; sw?: number; dash?: Dash; detail?: number }
export interface TextPrim { text: string; x: number; y: number; size: number; bold?: boolean; color: string; anchor: 'start' | 'middle' | 'end' }
export type Prim = PathPrim | TextPrim;
export interface Theme { fg: string; muted: string; bg: string }

export const LIGHT: Theme = { fg: '#1e1e24', muted: '#5f6068', bg: '#ffffff' };
export const DARK: Theme = { fg: '#e3e3e8', muted: '#a2a2ad', bg: '#121214' };
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const font = (size: number, bold?: boolean) => `${bold ? 600 : 400} ${size}px ${FONT}`;
export const DASH: number[][] = [[], [8, 5], [1.5, 4.5]];
export const ROUTES: Route[] = ['straight', 'elbow', 'curve'];
export const HEADS: Head[] = ['end', 'both', 'none'];
export const ALIGNS: Align[] = ['left', 'center', 'right'];
export const GRID = 10;
export const PALETTE = ['#1168bd', '#08427b', '#438dd5', '#85bbf0', '#7d7d7d', '#2f9e44', '#f08c00', '#e03131', '#7048e8'];
const EXTERNAL = '#7d7d7d';

// C4 kinds are filled and carry a "[Type: tech]" line; the rest are plain outlined shapes.
export const KINDS: Record<Kind, { key: string; name: string; w: number; h: number; color?: string; c4?: string }> = {
  person: { key: 'p', name: 'Person', w: 180, h: 180, color: '#08427b', c4: 'Person' },
  system: { key: 's', name: 'Software System', w: 220, h: 120, color: '#1168bd', c4: 'Software System' },
  container: { key: 'c', name: 'Container', w: 220, h: 120, color: '#438dd5', c4: 'Container' },
  component: { key: 'm', name: 'Component', w: 200, h: 110, color: '#85bbf0', c4: 'Component' },
  database: { key: 'd', name: 'Database', w: 200, h: 130, color: '#438dd5', c4: 'Container' },
  queue: { key: 'q', name: 'Queue / Pub-Sub', w: 220, h: 100, color: '#438dd5', c4: 'Container' },
  browser: { key: 'w', name: 'Web App / UI', w: 220, h: 130, color: '#438dd5', c4: 'Container' },
  boundary: { key: 'b', name: 'Boundary', w: 480, h: 320 },
  rect: { key: 'r', name: 'Rectangle', w: 160, h: 80 },
  ellipse: { key: 'o', name: 'Ellipse', w: 160, h: 90 },
  text: { key: 't', name: 'Text', w: 200, h: 30 },
};

export const rid = () => Math.random().toString(36).slice(2, 10);
export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const center = (n: Node): Pt => [n.x + n.w / 2, n.y + n.h / 2];
export const inRect = (n: Node, p: Pt, pad: number) => p[0] >= n.x - pad && p[0] <= n.x + n.w + pad && p[1] >= n.y - pad && p[1] <= n.y + n.h + pad;
export const isFilled = (k: Kind) => !!KINDS[k].color;
export const nodeDash = (n: Node): Dash => n.dash ?? (n.kind === 'boundary' ? 1 : 0);
export const nodeAlign = (n: Node): Align => n.align ?? (n.kind === 'boundary' || n.kind === 'text' ? 'left' : 'center');
export const nodeColor = (n: Node, t: Theme) => n.color ?? (n.ext && isFilled(n.kind) ? EXTERNAL : KINDS[n.kind].color ?? t.fg);

export function makeNode(kind: Kind, cx: number, cy: number, text = ''): Node {
  const { w, h } = KINDS[kind];
  return { id: rid(), kind, x: snap(cx - w / 2), y: snap(cy - h / 2), w, h, text };
}
export const makeEdge = (from: string, to: string, s: EdgeStyle): Edge => ({ id: rid(), from, to, text: '', ...s });

// ---------- colors (6-digit hex in, 6-digit hex out) ----------
const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
export const mix = (a: string, b: string, t: number) =>
  '#' + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
export const textOn = (c: string) => {
  const [r, g, b] = rgb(c);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#1e1e24' : '#ffffff';
};

// ---------- labels ----------
// Typing convention: first line is the name, "Name [tech]" or a "[tech]" line sets the technology,
// remaining lines are the description.
export function parseLabel(text: string) {
  const [first = '', ...rest] = text.split('\n');
  let name = first, tech = '';
  const m = first.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
  if (m) [, name, tech] = m;
  const desc: string[] = [];
  for (const l of rest) {
    const t = l.trim().match(/^\[(.*)\]$/);
    if (t && !tech) tech = t[1];
    else desc.push(l);
  }
  return { name: name.trim(), tech: tech.trim(), desc: desc.join('\n').trim() };
}

export function labelParts(n: Node) {
  const { name, tech, desc } = parseLabel(n.text), c4 = KINDS[n.kind].c4;
  return { name, type: c4 ? (tech ? `${c4}: ${tech}` : c4) : tech, desc };
}

export function wrap(s: string, max: number, size: number, bold: boolean, m: Measure): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && m(next, size, bold) > max) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

interface Line { s: string; size: number; bold?: boolean; muted?: boolean; gap?: number }
const lh = (l: Line) => l.size * 1.35 + (l.gap ?? 0);
const textHeight = (ls: Line[]) => ls.reduce((a, l) => a + lh(l), 0);

function stack(name: string, type: string, desc: string, max: number, m: Measure, big: number, bold: boolean): Line[] {
  const out: Line[] = [];
  if (name) for (const s of wrap(name, max, big, bold, m)) out.push({ s, size: big, bold });
  if (type) for (const s of wrap(`[${type}]`, max, 11, false, m)) out.push({ s, size: 11, muted: true });
  if (desc) wrap(desc, max, 12, false, m).forEach((s, i) => out.push({ s, size: 12, gap: i ? 0 : 5 }));
  return out;
}

function nodeLines(n: Node, m: Measure): Line[] {
  const max = labelBox(n)[2] - 20;
  if (n.kind === 'text') return wrap(n.text, max, 15, false, m).map(s => ({ s, size: 15 }));
  const { name, type, desc } = labelParts(n);
  return stack(name, type, desc, max, m, n.kind === 'boundary' ? 14 : 15, true);
}

// ---------- shapes ----------
// Tagged template that rounds every interpolated number: compact, deterministic path strings.
const P = (s: TemplateStringsArray, ...v: number[]) => s.reduce((a, b, i) => a + r1(v[i - 1]) + b);
// Curves are cubic Béziers only (no SVG arcs), so one path syntax serves canvas, SVG and PDF.
const K = 0.5523; // control-point ratio approximating a quarter ellipse
// Quarter ellipse from a to b; `flat` = the tangent at a is horizontal.
const qc = (ax: number, ay: number, bx: number, by: number, flat: boolean) => flat
  ? P`C${ax + (bx - ax) * K} ${ay} ${bx} ${by + (ay - by) * K} ${bx} ${by}`
  : P`C${ax} ${ay + (by - ay) * K} ${bx + (ax - bx) * K} ${by} ${bx} ${by}`;
const rr = (x: number, y: number, w: number, h: number, r: number) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const R = x + w, B = y + h;
  return P`M${x + r} ${y}H${R - r}` + qc(R - r, y, R, y + r, true) + P`V${B - r}` + qc(R, B - r, R - r, B, false)
    + P`H${x + r}` + qc(x + r, B, x, B - r, true) + P`V${y + r}` + qc(x, y + r, x + r, y, false) + 'Z';
};
const ell = (cx: number, cy: number, rx: number, ry: number) =>
  P`M${cx - rx} ${cy}` + qc(cx - rx, cy, cx, cy - ry, false) + qc(cx, cy - ry, cx + rx, cy, true)
  + qc(cx + rx, cy, cx, cy + ry, false) + qc(cx, cy + ry, cx - rx, cy, true) + 'Z';
export const headR = (n: Node) => Math.min(n.w, n.h) * 0.17; // person head radius
export const cylR = (n: Node) => Math.min(16, n.h * 0.12); // database lid half-height
export const tubeR = (n: Node) => Math.min(16, n.w * 0.1); // queue end half-width

// Area the label is centred in (excludes heads, lids, title bars).
export function labelBox(n: Node): [number, number, number, number] {
  const { x, y, w, h } = n;
  if (n.kind === 'person') { const r = headR(n); return [x, y + 2 * r, w, h - 2 * r]; }
  if (n.kind === 'database') { const r = cylR(n); return [x, y + 2 * r, w, h - 3 * r]; }
  if (n.kind === 'queue') { const r = tubeR(n); return [x + r, y, w - 3 * r, h]; }
  if (n.kind === 'browser') return [x, y + 22, w, h - 22];
  return [x, y, w, h];
}

export function nodePrims(n: Node, t: Theme, m: Measure): Prim[] {
  const { x, y, w, h } = n, c = nodeColor(n, t), solid = isFilled(n.kind), dash = nodeDash(n);
  const stroke = solid ? mix(c, '#000000', 0.25) : c;
  const fill = solid ? c : n.kind === 'text' ? undefined : c + (n.kind === 'boundary' ? '08' : '1a');
  const out: Prim[] = [];
  const shape = (d: string) => out.push({ d, fill, stroke, sw: 1.5, dash });
  const line = (d: string) => out.push({ d, stroke, sw: 1.5 });
  switch (n.kind) {
    case 'person': {
      const r = headR(n);
      shape(rr(x, y + r * 1.7, w, h - r * 1.7, r * 1.2));
      shape(ell(x + w / 2, y + r, r, r));
      break;
    }
    case 'database': {
      const r = cylR(n);
      const cx = x + w / 2, R = x + w, B = y + h;
      shape(P`M${x} ${y + r}` + qc(x, y + r, cx, y, false) + qc(cx, y, R, y + r, true) + P`V${B - r}`
        + qc(R, B - r, cx, B, false) + qc(cx, B, x, B - r, true) + 'Z');
      line(P`M${x} ${y + r}` + qc(x, y + r, cx, y + 2 * r, false) + qc(cx, y + 2 * r, R, y + r, true));
      break;
    }
    case 'queue': {
      const r = tubeR(n);
      const cy = y + h / 2, R = x + w, B = y + h;
      shape(P`M${x + r} ${y}H${R - r}` + qc(R - r, y, R, cy, true) + qc(R, cy, R - r, B, false)
        + P`H${x + r}` + qc(x + r, B, x, cy, true) + qc(x, cy, x + r, y, false) + 'Z');
      line(P`M${R - r} ${y}` + qc(R - r, y, R - 2 * r, cy, true) + qc(R - 2 * r, cy, R - r, B, false));
      break;
    }
    case 'browser':
      shape(rr(x, y, w, h, 8));
      line(P`M${x} ${y + 22}H${x + w}`);
      out.push({ d: ell(x + 12, y + 11, 3, 3) + ell(x + 22, y + 11, 3, 3) + ell(x + 32, y + 11, 3, 3), fill: stroke, detail: 6 });
      break;
    case 'ellipse': shape(ell(x + w / 2, y + h / 2, w / 2, h / 2)); break;
    case 'text': break;
    default: shape(rr(x, y, w, h, n.kind === 'boundary' ? 12 : n.kind === 'component' ? 6 : 10));
  }

  const ls = nodeLines(n, m), [bx, by, bw, bh] = labelBox(n), th = textHeight(ls);
  const al = nodeAlign(n), pad = n.kind === 'text' ? 4 : 12, anchor = al === 'left' ? 'start' : al === 'right' ? 'end' : 'middle';
  const tx = al === 'left' ? bx + pad : al === 'right' ? bx + bw - pad : bx + bw / 2;
  const tc = solid ? textOn(c) : n.kind === 'text' ? c : t.fg;
  let ty = n.kind === 'boundary' ? y + h - 10 - th : by + (bh - th) / 2;
  for (const l of ls) {
    ty += lh(l);
    if (l.s) out.push({ text: l.s, x: tx, y: ty - l.size * 0.36, size: l.size, bold: l.bold, color: l.muted ? (solid ? tc + 'bf' : t.muted) : tc, anchor });
  }
  return out;
}

// Grow a node so its label fits (never shrinks a box the user made bigger).
export function fitText(n: Node, m: Measure) {
  const up = (v: number) => Math.ceil(v / GRID) * GRID, th = textHeight(nodeLines(n, m));
  if (n.kind === 'text') n.h = Math.max(30, up(th + 10));
  else if (n.kind !== 'boundary') n.h = Math.max(n.h, up(th + 20 + n.h - labelBox(n)[3]));
}

// ---------- edges ----------
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const toward = (p: Pt, q: Pt, r: number): Pt => {
  const l = dist(p, q) || 1;
  return [p[0] + ((q[0] - p[0]) * r) / l, p[1] + ((q[1] - p[1]) * r) / l];
};
const GAP = 6;

// Where the ray from the node centre along (dx, dy) leaves the node (+gap).
function clip(n: Node, dx: number, dy: number): Pt {
  const [cx, cy] = center(n), rx = n.w / 2 + GAP, ry = n.h / 2 + GAP;
  if (!dx && !dy) return [cx, cy];
  const t = n.kind === 'ellipse' ? 1 / Math.hypot(dx / rx, dy / ry) : Math.min(rx / Math.abs(dx), ry / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

// Polyline with rounded corners.
function poly(pts: Pt[], r = 0): string {
  let d = P`M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const q = Math.min(r, dist(pts[i - 1], pts[i]) / 2, dist(pts[i], pts[i + 1]) / 2);
    const a = toward(pts[i], pts[i - 1], q), b = toward(pts[i], pts[i + 1], q);
    d += P`L${a[0]} ${a[1]}Q${pts[i][0]} ${pts[i][1]} ${b[0]} ${b[1]}`;
  }
  const [x, y] = pts[pts.length - 1];
  return d + P`L${x} ${y}`;
}

const bez = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
  const u = 1 - t;
  return [0, 1].map(i => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]) as Pt;
};

function along(pts: Pt[], t: number): Pt {
  let left = t * pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (left <= l) return toward(pts[i - 1], pts[i], left);
    left -= l;
  }
  return pts[pts.length - 1];
}

// pts: the polyline (curves sampled) used for arrowheads, hit testing and the label midpoint.
// ---------- memo: unchanged nodes and edges reuse their geometry and display list across frames ----------
// Keyed by object; a signature of every input decides whether the cached value is still valid.
function memo<K extends object, V>() {
  const cache = new WeakMap<K, { sig: string; v: V }>();
  return (k: K, sig: string, make: () => V) => {
    const hit = cache.get(k);
    if (hit?.sig === sig) return hit.v;
    const v = make();
    cache.set(k, { sig, v });
    return v;
  };
}
const refs = new WeakMap<object, number>();
let refCount = 0;
const ref = (o: object) => refs.get(o) ?? (refs.set(o, ++refCount), refCount); // stable id for themes/measures
const boxSig = (n: Node) => `${n.x},${n.y},${n.w},${n.h},${n.kind}`;
const nodeSig = (n: Node) => `${boxSig(n)},${n.color},${n.dash},${n.ext},${n.align}\n${n.text}`;
const geomMemo = memo<Edge, ReturnType<typeof geom>>(), nodeMemo = memo<Node, Prim[]>(), edgeMemo = memo<Edge, Prim[]>();

export const edgeGeom = (e: Edge, a: Node, b: Node) => geomMemo(e, `${e.route}|${boxSig(a)}|${boxSig(b)}`, () => geom(e, a, b));

function geom(e: Edge, a: Node, b: Node) {
  const [ax, ay] = center(a), [bx, by] = center(b), dx = bx - ax, dy = by - ay;
  let pts: Pt[], d: string;
  if (e.route === 'straight') {
    pts = [clip(a, dx, dy), clip(b, -dx, -dy)];
    d = poly(pts);
  } else {
    const hz = Math.abs(dx) >= Math.abs(dy), sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    const p1: Pt = hz ? [ax + sx * (a.w / 2 + GAP), ay] : [ax, ay + sy * (a.h / 2 + GAP)];
    const p2: Pt = hz ? [bx - sx * (b.w / 2 + GAP), by] : [bx, by - sy * (b.h / 2 + GAP)];
    if (e.route === 'elbow') {
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      pts = hz ? [p1, [mx, p1[1]], [mx, p2[1]], p2] : [p1, [p1[0], my], [p2[0], my], p2];
      d = poly(pts, 10);
    } else {
      const k = Math.max(30, (hz ? Math.abs(p2[0] - p1[0]) : Math.abs(p2[1] - p1[1])) / 2);
      const c1: Pt = hz ? [p1[0] + sx * k, p1[1]] : [p1[0], p1[1] + sy * k];
      const c2: Pt = hz ? [p2[0] - sx * k, p2[1]] : [p2[0], p2[1] - sy * k];
      pts = Array.from({ length: 17 }, (_, i) => bez(p1, c1, c2, p2, i / 16));
      d = P`M${p1[0]} ${p1[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
    }
  }
  return { d, pts, mid: along(pts, 0.5) };
}

function head(tip: Pt, from: Pt, s = 10): string {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]), l = a + 2.7, r = a - 2.7;
  return P`M${tip[0]} ${tip[1]}L${tip[0] + s * Math.cos(l)} ${tip[1] + s * Math.sin(l)}L${tip[0] + s * Math.cos(r)} ${tip[1] + s * Math.sin(r)}Z`;
}

export function edgePrims(e: Edge, a: Node, b: Node, t: Theme, m: Measure): Prim[] {
  const g = edgeGeom(e, a, b), c = e.color ?? t.muted, n = g.pts.length;
  const out: Prim[] = [{ d: g.d, stroke: c, sw: 1.5, dash: e.dash }];
  if (e.head !== 'none') out.push({ d: head(g.pts[n - 1], g.pts[n - 2]), fill: c, stroke: c, sw: 1, detail: 10 });
  if (e.head === 'both') out.push({ d: head(g.pts[0], g.pts[1]), fill: c, stroke: c, sw: 1, detail: 10 });
  if (e.text.trim()) {
    const { name, tech, desc } = parseLabel(e.text);
    const ls = stack(name, tech, desc, 200, m, 12, false);
    const w = Math.max(...ls.map(l => m(l.s, l.size, l.bold))) + 12, h = textHeight(ls) + 6;
    out.push({ d: rr(g.mid[0] - w / 2, g.mid[1] - h / 2, w, h, 5), fill: t.bg, detail: 12 });
    let ty = g.mid[1] - h / 2 + 3;
    for (const l of ls) {
      ty += lh(l);
      out.push({ text: l.s, x: g.mid[0], y: ty - l.size * 0.36, size: l.size, color: l.muted ? t.muted : t.fg, anchor: 'middle' });
    }
  }
  return out;
}

// ---------- whole document ----------
// Paint order: boundaries, nodes, edges (+labels on top). `view` culls off-screen work.
export function docPrims(doc: Doc, t: Theme, m: Measure, view?: [number, number, number, number]): Prim[] {
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  const vis = (x0: number, y0: number, x1: number, y1: number) =>
    !view || (x0 < view[0] + view[2] && x1 > view[0] && y0 < view[1] + view[3] && y1 > view[1]);
  const out: Prim[] = [];
  for (const pass of [true, false])
    for (const n of doc.nodes) if ((n.kind === 'boundary') === pass && vis(n.x, n.y, n.x + n.w, n.y + n.h))
      out.push(...nodeMemo(n, `${ref(t)} ${ref(m)} ${nodeSig(n)}`, () => nodePrims(n, t, m)));
  for (const e of doc.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (a && b && vis(Math.min(a.x, b.x) - 60, Math.min(a.y, b.y) - 60, Math.max(a.x + a.w, b.x + b.w) + 60, Math.max(a.y + a.h, b.y + b.h) + 60))
      out.push(...edgeMemo(e, `${ref(t)} ${ref(m)} ${e.dash}${e.head}${e.color}|${boxSig(a)}|${boxSig(b)}|${e.route}\n${e.text}`, () => edgePrims(e, a, b, t, m)));
  }
  return out;
}

export function docBounds(doc: Doc, pad = 0): [number, number, number, number] {
  if (!doc.nodes.length) return [-pad, -pad, 2 * pad + 1, 2 * pad + 1];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of doc.nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
  }
  return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// Top-most hit: nodes, then edges, then boundaries (only their border and label band, so you can
// still marquee-select inside them).
export function hitTest(doc: Doc, p: Pt, tol: number, nodesOnly = false): string | undefined {
  const ns = doc.nodes;
  for (let i = ns.length - 1; i >= 0; i--) if (ns[i].kind !== 'boundary' && inRect(ns[i], p, tol)) return ns[i].id;
  if (!nodesOnly) {
    const byId = new Map(ns.map(n => [n.id, n]));
    for (const e of doc.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const g = edgeGeom(e, a, b);
      if ((e.text && dist(g.mid, p) < 16) || g.pts.some((q, i) => i > 0 && segDist(p, g.pts[i - 1], q) < tol)) return e.id;
    }
  }
  for (let i = ns.length - 1; i >= 0; i--) {
    const n = ns[i];
    if (n.kind === 'boundary' && inRect(n, p, tol) && (!inRect(n, p, -12) || p[1] > n.y + n.h - 44)) return n.id;
  }
}
