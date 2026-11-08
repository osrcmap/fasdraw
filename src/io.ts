// Renderers and file formats: canvas painter, SVG, PNG, PDF, Excalidraw and the native .fasdraw JSON.
import { ALIGNS, DASH, FONT, HEADS, KINDS, LIGHT, ROUTES, cylR, docBounds, docPrims, edgeGeom, font, headR, isFilled, labelBox, labelParts, mix, nodeAlign, nodeColor, nodeDash, parseLabel, r1, rid, textOn, tubeR, wrap } from './model.ts';
import type { Dash, Doc, Edge, Kind, Measure, Node, PathPrim, Prim } from './model.ts';

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
      align: ALIGNS.includes(n.align) ? n.align : undefined,
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

// Parsed paths live as long as their (memoized) prims, so a pan or zoom parses nothing.
const paths = new WeakMap<PathPrim, Path2D>();
// `minText` (world units): skip text and decorations smaller than this; on screen that is ~3px, so nothing
// readable is lost, and tiny labels and arrowheads are most of the cost of a zoomed-out view.
export function paint(g: CanvasRenderingContext2D, prims: Prim[], minText = 0) {
  g.lineJoin = 'round';
  for (const p of prims) {
    if ('d' in p) {
      if ((p.detail ?? Infinity) < minText) continue;
      let path = paths.get(p);
      if (!path) paths.set(p, (path = new Path2D(p.d)));
      if (p.fill) { g.fillStyle = p.fill; g.fill(path); }
      if (p.stroke) {
        g.strokeStyle = p.stroke; g.lineWidth = p.sw ?? 1.5;
        // A dash pattern shorter than the skip size can't be seen; drawing it solid is far cheaper.
        const dash = DASH[p.dash ?? 0], solid = dash[0] + dash[1] < minText;
        g.setLineDash(solid ? [] : dash); g.lineCap = p.dash === 2 && !solid ? 'round' : 'butt';
        g.stroke(path);
      }
    } else if (p.size >= minText) {
      g.font = font(p.size, p.bold); g.fillStyle = p.color;
      g.textAlign = p.anchor === 'start' ? 'left' : p.anchor === 'end' ? 'right' : 'center';
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
      : `<text x="${r1(p.x)}" y="${r1(p.y)}" font-size="${p.size}"${p.bold ? ' font-weight="600"' : ''} ${paintAttr('fill', p.color)}${p.anchor === 'start' ? '' : ` text-anchor="${p.anchor}"`}>${esc(p.text)}</text>`,
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

// ---------- PDF ----------
const deflate = async (b: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
const r2 = (v: number) => Math.round(v * 100) / 100;

// Minimal single-page PDF: catalog, pages, page, a Flate-compressed content stream and an optional RGB image.
async function writePdf(wPt: number, hPt: number, resources: string, content: string, image?: { W: number; H: number; rgb: Uint8Array<ArrayBuffer> }): Promise<Blob> {
  const parts: BlobPart[] = [], offs: number[] = [];
  let len = 0;
  const put = (p: string | Uint8Array<ArrayBuffer>) => { parts.push(p); len += p.length; }; // strings are ASCII, so length == bytes
  const obj = (body: string, stream?: Uint8Array<ArrayBuffer>) => {
    offs.push(len);
    put(`${offs.length} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  const body = await deflate(new TextEncoder().encode(content)); // content is ASCII: text bytes are octal-escaped
  put('%PDF-1.4\n');
  obj('<< /Type /Catalog /Pages 2 0 R >>');
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << ${resources} >> /Contents 4 0 R >>`);
  obj(`<< /Length ${body.length} /Filter /FlateDecode >>`, body);
  if (image) {
    const z = await deflate(image.rgb);
    obj(`<< /Type /XObject /Subtype /Image /Width ${image.W} /Height ${image.H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>`, z);
  }
  const xref = len;
  put(`xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

export const pdfFromRgb = (rgb: Uint8Array<ArrayBuffer>, W: number, H: number, wPt: number, hPt: number) =>
  writePdf(wPt, hPt, '/XObject << /I 5 0 R >>', `q ${wPt} 0 0 ${hPt} 0 0 cm /I Do Q`, { W, H, rgb });

// Vector PDF straight from the display list, using the PDF base fonts (nothing embedded, a few KB).
// Labels with characters outside WinAnsi (Western European) fall back to a 3x raster page.
export const toPdf = async (doc: Doc, m: Measure) => (await vectorPdf(doc)) ?? rasterPdf(doc, m);

function rasterPdf(doc: Doc, m: Measure) {
  const [, , w, h] = docBounds(doc, PAD), c = rasterize(doc, m, 3);
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const rgb = new Uint8Array(c.width * c.height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
  return pdfFromRgb(rgb, c.width, c.height, r1(w * 0.75), r1(h * 0.75));
}

// Advance widths (1/1000 em) of Helvetica and Helvetica-Bold for ASCII 32–126, from the Adobe AFM files.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, ...Array(10).fill(556), 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
  500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, ...Array(10).fill(556), 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611,
  556, 778, 556, 556, 500, 389, 280, 389, 584];
// Accented letters measure as their base letter; anything else as a digit.
export const helvetica: Measure = (s, size, bold) => {
  const t = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const ch of s) { const c = ch.normalize('NFD').charCodeAt(0); w += c >= 32 && c < 127 ? t[c - 32] : 556; }
  return (w * size) / 1000;
};
// WinAnsiEncoding: Latin-1 plus the typographic punctuation Windows-1252 puts in 0x80–0x9f.
const WIN: Record<string, number | undefined> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const winAnsi = (ch: string) => { const c = ch.charCodeAt(0); return ch.length === 1 && ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) ? c : WIN[ch]; };
const pdfText = (s: string) => [...s].map(ch => {
  const c = winAnsi(ch)!;
  return c === 40 || c === 41 || c === 92 ? '\\' + ch : c > 126 ? '\\' + c.toString(8).padStart(3, '0') : ch;
}).join('');

// Our path strings only use M L H V Q C Z (see model.ts); quadratics become cubics.
function pdfPath(d: string): string {
  const t = d.match(/[MLHVQCZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, out = '';
  const n = () => Number(t[i++]);
  while (i < t.length) {
    const c = t[i++];
    if (c === 'M') { x = sx = n(); y = sy = n(); out += `${x} ${y} m `; }
    else if (c === 'L') { x = n(); y = n(); out += `${x} ${y} l `; }
    else if (c === 'H') { x = n(); out += `${x} ${y} l `; }
    else if (c === 'V') { y = n(); out += `${x} ${y} l `; }
    else if (c === 'C') { const v = [n(), n(), n(), n(), n(), n()]; out += `${v.join(' ')} c `; x = v[4]; y = v[5]; }
    else if (c === 'Q') {
      const qx = n(), qy = n(), ex = n(), ey = n();
      out += `${r2(x + (2 / 3) * (qx - x))} ${r2(y + (2 / 3) * (qy - y))} ${r2(ex + (2 / 3) * (qx - ex))} ${r2(ey + (2 / 3) * (qy - ey))} ${ex} ${ey} c `;
      x = ex; y = ey;
    } else if (c === 'Z') { out += 'h '; x = sx; y = sy; }
  }
  return out;
}

export async function vectorPdf(doc: Doc): Promise<Blob | undefined> {
  const prims = docPrims(doc, LIGHT, helvetica); // wrap with the PDF font's metrics so lines fit their boxes
  if (prims.some(p => 'text' in p && [...p.text].some(ch => winAnsi(ch) === undefined))) return undefined;
  const [x0, y0, w, h] = docBounds(doc, PAD), k = 0.75, states = new Map<string, string>();
  const rgb = (c: string) => [1, 3, 5].map(i => r2(parseInt(c.slice(i, i + 2), 16) / 255)).join(' ');
  const alpha = (c?: string) => (c?.length === 9 ? r2(parseInt(c.slice(7), 16) / 255) : 1);
  const gs = (fill?: string, stroke?: string) => {
    const key = `${alpha(fill)} ${alpha(stroke)}`;
    if (!states.has(key)) states.set(key, `G${states.size}`);
    return `/${states.get(key)} gs `;
  };
  // px -> pt, and flip y so the display list's coordinates are used as-is (text flips back via Tm).
  let out = `${k} 0 0 ${-k} ${r2(-x0 * k)} ${r2((y0 + h) * k)} cm 1 1 1 rg ${x0} ${y0} ${w} ${h} re f 1 j\n`;
  for (const p of prims) {
    if ('d' in p) {
      out += gs(p.fill, p.stroke);
      if (p.fill) out += `${rgb(p.fill)} rg `;
      if (p.stroke) out += `${rgb(p.stroke)} RG ${p.sw ?? 1.5} w [${DASH[p.dash ?? 0].join(' ')}] 0 d ${p.dash === 2 ? 1 : 0} J `;
      out += pdfPath(p.d) + (p.fill && p.stroke ? 'B' : p.fill ? 'f' : 'S') + '\n';
    } else {
      const tw = helvetica(p.text, p.size, p.bold), tx = p.anchor === 'middle' ? p.x - tw / 2 : p.anchor === 'end' ? p.x - tw : p.x;
      out += `${gs(p.color)}${rgb(p.color)} rg BT /F${p.bold ? 2 : 1} ${p.size} Tf 1 0 0 -1 ${r2(tx)} ${r2(p.y)} Tm (${pdfText(p.text)}) Tj ET\n`;
    }
  }
  const font = (name: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const resources = `/Font << /F1 ${font('Helvetica')} /F2 ${font('Helvetica-Bold')} >> /ExtGState << `
    + [...states].map(([key, name]) => { const [ca, CA] = key.split(' '); return `/${name} << /ca ${ca} /CA ${CA} >>`; }).join(' ') + ' >>';
  return writePdf(r2(w * k), r2(h * k), resources, out);
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
  // Place text of width w inside [x, x + span] according to the alignment.
  const alignX = (al: string, x: number, span: number, w: number, pad: number) => al === 'left' ? x + pad : al === 'right' ? x + span - pad - w : x + (span - w) / 2;
  const bindText = (c: El, s: string, color: string, [bx, by, bw, bh]: number[], align = 'center') => {
    if (!s) return;
    const wrapped = wrap(s, bw - 20, 16, false, m).join('\n');
    const t = text(wrapped, color, (w, h) => [alignX(align, bx, bw, w, 10), by + (bh - h) / 2], { containerId: c.id, originalText: s, textAlign: align });
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
        hub = text(wrap(n.text || ' ', w, 16, false, m).join('\n'), c, tw => [alignX(nodeAlign(n), x, w, tw, 0), y], { textAlign: nodeAlign(n), verticalAlign: 'top', originalText: n.text });
        break;
      case 'boundary':
        hub = el('rectangle', x, y, w, h, { ...g, ...round });
        if (label) text(label, c, (tw, th) => [alignX(nodeAlign(n), x, w, tw, 12), y + h - 10 - th], { textAlign: nodeAlign(n), groupIds: [n.id] });
        break;
      default: hub = el('rectangle', x, y, w, h, { ...st, ...round });
    }
    hubs.set(n.id, hub);
    if (n.kind !== 'text' && n.kind !== 'boundary') {
      bindText(hub, label, solid ? textOn(c) : LIGHT.fg, labelBox(n), nodeAlign(n));
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
      startArrowhead: e.head === 'start' || e.head === 'both' ? 'arrow' : null, endArrowhead: e.head === 'end' || e.head === 'both' ? 'arrow' : null,
      roundness: e.route === 'curve' ? { type: 2 } : null, elbowed: false,
    });
    ha.boundElements.push({ type: 'arrow', id: arrow.id });
    hb.boundElements.push({ type: 'arrow', id: arrow.id });
    const { name, tech, desc } = parseLabel(e.text);
    bindText(arrow, [name, tech && `[${tech}]`, desc].filter(Boolean).join('\n'), LIGHT.fg, [g.mid[0] - 110, g.mid[1] - 40, 220, 80]);
  }
  return { type: 'excalidraw', version: 2, source: 'fasdraw', elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, files: {} };
}
