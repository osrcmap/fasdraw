// Renderers and file formats: canvas painter, SVG, PNG, PDF, Excalidraw and the native .fasdraw JSON.
import { DASH, FONT, HEADS, KINDS, LIGHT, ROUTES, cylR, docBounds, docPrims, edgeGeom, font, headR, isFilled, labelBox, labelParts, mix, nodeColor, nodeDash, parseLabel, r1, rid, textOn, tubeR, wrap } from './model.ts';
import type { Dash, Doc, Edge, Kind, Measure, Node, Prim } from './model.ts';

const PAD = 32;

// ---------- native format ----------
export const serialize = (doc: Doc) => JSON.stringify({ type: 'fasdraw', version: 1, nodes: doc.nodes, edges: doc.edges }, null, 2);

// Files are untrusted: every field is type-checked and anything unknown is dropped or defaulted.
export function parseFasdraw(text: string): Doc {
  const j = JSON.parse(text);
  if (j?.type !== 'fasdraw' || !Array.isArray(j.nodes) || !Array.isArray(j.edges)) throw new Error('not a .fasdraw file');
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
  const dash = (v: unknown) => (v === 0 || v === 1 || v === 2 ? (v as Dash) : undefined);
  const ids = new Set<string>(), nodes: Node[] = [], edges: Edge[] = [];
  for (const n of j.nodes) {
    if (typeof n?.id !== 'string' || ids.has(n.id)) continue;
    ids.add(n.id);
    const kind: Kind = Object.hasOwn(KINDS, n.kind) ? n.kind : 'rect';
    nodes.push({
      id: n.id, kind, x: num(n.x, 0), y: num(n.y, 0),
      w: Math.max(10, num(n.w, KINDS[kind].w)), h: Math.max(10, num(n.h, KINDS[kind].h)),
      text: str(n.text), color: color(n.color), dash: dash(n.dash), ext: n.ext === true || undefined,
    });
  }
  for (const e of j.edges) {
    if (typeof e?.id !== 'string' || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    edges.push({
      id: e.id, from: e.from, to: e.to, text: str(e.text), color: color(e.color), dash: dash(e.dash) ?? 0,
      route: ROUTES.includes(e.route) ? e.route : 'straight', head: HEADS.includes(e.head) ? e.head : 'end',
    });
  }
  return { nodes, edges };
}

// ---------- canvas ----------
let mctx: CanvasRenderingContext2D | undefined;
const widths = new Map<string, number>();
export const measure: Measure = (s, size, bold) => {
  const k = `${size}${bold ? 'b' : ''}|${s}`;
  let w = widths.get(k);
  if (w === undefined) {
    if (widths.size > 20000) widths.clear(); // simple size cap; an LRU would keep hot entries
    mctx ??= document.createElement('canvas').getContext('2d')!;
    mctx.font = font(size, bold);
    widths.set(k, (w = mctx.measureText(s).width));
  }
  return w;
};

export function paint(g: CanvasRenderingContext2D, prims: Prim[]) {
  g.lineJoin = 'round';
  for (const p of prims) {
    if ('d' in p) {
      const path = new Path2D(p.d);
      if (p.fill) { g.fillStyle = p.fill; g.fill(path); }
      if (p.stroke) {
        g.strokeStyle = p.stroke; g.lineWidth = p.sw ?? 1.5;
        g.setLineDash(DASH[p.dash ?? 0]); g.lineCap = p.dash === 2 ? 'round' : 'butt';
        g.stroke(path);
      }
    } else {
      g.font = font(p.size, p.bold); g.fillStyle = p.color;
      g.textAlign = p.anchor === 'start' ? 'left' : 'center';
      g.fillText(p.text, p.x, p.y);
    }
  }
  g.setLineDash([]);
}

// ---------- SVG ----------
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// #rrggbbaa -> color + opacity attribute, which every SVG consumer understands.
const paintAttr = (name: string, c: string) =>
  c.length === 9 ? `${name}="${c.slice(0, 7)}" ${name}-opacity="${(parseInt(c.slice(7), 16) / 255).toFixed(2)}"` : `${name}="${esc(c)}"`;

export function toSvg(doc: Doc, m: Measure): string {
  const [x, y, w, h] = docBounds(doc, PAD);
  const body = docPrims(doc, LIGHT, m).map(p =>
    'd' in p
      ? `<path d="${p.d}" ${p.fill ? paintAttr('fill', p.fill) : 'fill="none"'}${p.stroke ? ` ${paintAttr('stroke', p.stroke)} stroke-width="${p.sw ?? 1.5}" stroke-linejoin="round"${p.dash ? ` stroke-dasharray="${DASH[p.dash]}"${p.dash === 2 ? ' stroke-linecap="round"' : ''}` : ''}` : ''}/>`
      : `<text x="${r1(p.x)}" y="${r1(p.y)}" font-size="${p.size}"${p.bold ? ' font-weight="600"' : ''} ${paintAttr('fill', p.color)}${p.anchor === 'middle' ? ' text-anchor="middle"' : ''}>${esc(p.text)}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family='${FONT}'>\n<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>\n${body.join('\n')}\n</svg>\n`;
}

// ---------- PNG / PDF ----------
function rasterize(doc: Doc, m: Measure, scale: number): HTMLCanvasElement {
  const [x, y, w, h] = docBounds(doc, PAD);
  // Browsers cap canvas size, so very large diagrams export at reduced resolution (~16 MP).
  const s = Math.min(scale, Math.sqrt(16e6 / (w * h)), 16000 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * s); c.height = Math.ceil(h * s);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  g.setTransform(s, 0, 0, s, -x * s, -y * s);
  paint(g, docPrims(doc, LIGHT, m));
  return c;
}

export const toPng = (doc: Doc, m: Measure) =>
  new Promise<Blob>((ok, fail) => rasterize(doc, m, 2).toBlob(b => (b ? ok(b) : fail(new Error('PNG encoding failed'))), 'image/png'));

// Raster PDF (3x, lossless): crisp in print, but text is not selectable.
export function toPdf(doc: Doc, m: Measure) {
  const [, , w, h] = docBounds(doc, PAD), c = rasterize(doc, m, 3);
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const rgb = new Uint8Array(c.width * c.height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
  return pdfFromRgb(rgb, c.width, c.height, r1(w * 0.75), r1(h * 0.75));
}

// Minimal single-page PDF: one Flate-compressed RGB image scaled to the page (px -> pt).
export async function pdfFromRgb(rgb: Uint8Array<ArrayBuffer>, W: number, H: number, wPt: number, hPt: number): Promise<Blob> {
  const z = new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const parts: BlobPart[] = [], offs: number[] = [];
  let len = 0;
  const put = (p: string | Uint8Array<ArrayBuffer>) => { parts.push(p); len += p.length; }; // strings are ASCII, so length == bytes
  const obj = (body: string, stream?: Uint8Array<ArrayBuffer>) => {
    offs.push(len);
    put(`${offs.length} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  const draw = new TextEncoder().encode(`q ${wPt} 0 0 ${hPt} 0 0 cm /I Do Q`);
  put('%PDF-1.4\n');
  obj('<< /Type /Catalog /Pages 2 0 R >>');
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /I 4 0 R >> >> /Contents 5 0 R >>`);
  obj(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>`, z);
  obj(`<< /Length ${draw.length} >>`, draw);
  const xref = len;
  put(`xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// ---------- Excalidraw ----------
// Maps to native Excalidraw elements with roughness 0 (its "architect" look). Composite shapes
// (person, cylinders) are grouped parts; text and arrows bind to one "hub" element per node.
type El = Record<string, any>;
const STROKE = ['solid', 'dashed', 'dotted'];

export function toExcalidraw(doc: Doc, m: Measure) {
  const els: El[] = [], hubs = new Map<string, El>();
  const seed = () => Math.floor(Math.random() * 2 ** 31);
  const el = (type: string, x: number, y: number, width: number, height: number, o: El = {}): El => {
    const e: El = {
      id: rid(), type, x, y, width, height, angle: 0, strokeColor: LIGHT.fg, backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
      roundness: null, seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: [],
      updated: Date.now(), link: null, locked: false, ...o,
    };
    els.push(e);
    return e;
  };
  const line = (x: number, y: number, dx: number, dy: number, o: El) =>
    el('line', x, y, Math.abs(dx), Math.abs(dy), {
      ...o, backgroundColor: 'transparent', points: [[0, 0], [dx, dy]], lastCommittedPoint: null,
      startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
    });
  const text = (s: string, color: string, place: (w: number, h: number) => [number, number], o: El = {}) => {
    const lines = s.split('\n'), size = 16;
    const w = Math.max(1, ...lines.map(l => m(l, size))), h = lines.length * size * 1.25, [x, y] = place(w, h);
    return el('text', x, y, w, h, {
      strokeColor: color, text: s, originalText: s, fontSize: size, fontFamily: 2, textAlign: 'center',
      verticalAlign: 'middle', containerId: null, lineHeight: 1.25, autoResize: true, ...o,
    });
  };
  const bindText = (c: El, s: string, color: string, [cx, cy]: [number, number], max: number) => {
    if (!s) return;
    const wrapped = wrap(s, max, 16, false, m).join('\n');
    const t = text(wrapped, color, (w, h) => [cx - w / 2, cy - h / 2], { containerId: c.id, originalText: s });
    c.boundElements.push({ type: 'text', id: t.id });
  };

  for (const n of doc.nodes) {
    const { x, y, w, h } = n, c = nodeColor(n, LIGHT), solid = isFilled(n.kind);
    const st: El = {
      strokeColor: solid ? mix(c, '#000000', 0.25) : c, strokeStyle: STROKE[nodeDash(n)],
      backgroundColor: solid ? c : n.kind === 'boundary' ? 'transparent' : mix(c, '#ffffff', 0.9),
    };
    const g = { ...st, groupIds: [n.id] }, round = { roundness: { type: 3 } };
    const { name, type, desc } = labelParts(n);
    const label = [name, type && `[${type}]`, desc && `\n${desc}`].filter(Boolean).join('\n');
    let hub: El;
    switch (n.kind) {
      case 'person': {
        const r = headR(n);
        hub = el('rectangle', x, y + r * 1.7, w, h - r * 1.7, { ...g, ...round });
        el('ellipse', x + w / 2 - r, y, 2 * r, 2 * r, g);
        break;
      }
      case 'database': {
        const r = cylR(n);
        el('ellipse', x, y + h - 2 * r, w, 2 * r, g);
        hub = el('rectangle', x, y + r, w, h - 2 * r, { ...g, strokeColor: 'transparent' });
        line(x, y + r, 0, h - 2 * r, g); line(x + w, y + r, 0, h - 2 * r, g);
        el('ellipse', x, y, w, 2 * r, g);
        break;
      }
      case 'queue': {
        const r = tubeR(n);
        el('ellipse', x, y, 2 * r, h, g);
        hub = el('rectangle', x + r, y, w - 2 * r, h, { ...g, strokeColor: 'transparent' });
        line(x + r, y, w - 2 * r, 0, g); line(x + r, y + h, w - 2 * r, 0, g);
        el('ellipse', x + w - 2 * r, y, 2 * r, h, g);
        break;
      }
      case 'browser':
        hub = el('rectangle', x, y, w, h, { ...g, ...round });
        line(x, y + 22, w, 0, g);
        break;
      case 'ellipse': hub = el('ellipse', x, y, w, h, st); break;
      case 'text':
        hub = text(wrap(n.text || ' ', w, 16, false, m).join('\n'), c, () => [x, y], { textAlign: 'left', verticalAlign: 'top', originalText: n.text });
        break;
      case 'boundary':
        hub = el('rectangle', x, y, w, h, { ...g, ...round });
        if (label) text(label, c, (_, th) => [x + 12, y + h - 10 - th], { textAlign: 'left', groupIds: [n.id] });
        break;
      default: hub = el('rectangle', x, y, w, h, { ...st, ...round });
    }
    hubs.set(n.id, hub);
    if (n.kind !== 'text' && n.kind !== 'boundary') {
      const [bx, by, bw, bh] = labelBox(n);
      bindText(hub, label, solid ? textOn(c) : LIGHT.fg, [bx + bw / 2, by + bh / 2], bw - 20);
    }
  }

  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  for (const e of doc.edges) {
    const a = byId.get(e.from), b = byId.get(e.to), ha = hubs.get(e.from), hb = hubs.get(e.to);
    if (!a || !b || !ha || !hb) continue;
    const g = edgeGeom(e, a, b);
    const pts = e.route === 'curve' ? [g.pts[0], g.pts[g.pts.length >> 1], g.pts[g.pts.length - 1]] : g.pts;
    const [x0, y0] = pts[0], rel = pts.map(([x, y]) => [x - x0, y - y0]);
    const xs = rel.map(p => p[0]), ys = rel.map(p => p[1]);
    const arrow = el('arrow', x0, y0, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      strokeColor: e.color ?? LIGHT.muted, strokeStyle: STROKE[e.dash], points: rel, lastCommittedPoint: null,
      startBinding: { elementId: ha.id, focus: 0, gap: 6 }, endBinding: { elementId: hb.id, focus: 0, gap: 6 },
      startArrowhead: e.head === 'both' ? 'arrow' : null, endArrowhead: e.head === 'none' ? null : 'arrow',
      roundness: e.route === 'curve' ? { type: 2 } : null, elbowed: false,
    });
    ha.boundElements.push({ type: 'arrow', id: arrow.id });
    hb.boundElements.push({ type: 'arrow', id: arrow.id });
    const { name, tech, desc } = parseLabel(e.text);
    bindText(arrow, [name, tech && `[${tech}]`, desc].filter(Boolean).join('\n'), LIGHT.fg, g.mid, 200);
  }
  return { type: 'excalidraw', version: 2, source: 'fasdraw', elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, files: {} };
}
