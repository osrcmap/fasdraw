// Structurizr DSL <-> fasdraw. Structurizr DSL is the open text language for C4 models
// (https://docs.structurizr.com/dsl). Import reads the model plus element/relationship styles and lays
// it out (the DSL carries no positions). Export writes a workspace that Structurizr tooling accepts.
import { LIGHT, center, fitText, inRect, makeEdge, makeNode, nodeColor, parseLabel, snap, textOn } from './model.ts';
import type { Doc, Edge, Kind, Measure, Node } from './model.ts';

type ElType = 'person' | 'softwaresystem' | 'container' | 'component' | 'group';
interface El { type: ElType; name: string; desc: string; tech: string; tags: string[]; parent?: El; path: string; kids: El[]; node?: Node }
interface Rel { from: string; ctx?: El; to: string; desc: string; tech: string; tags: string[] }
interface Style { shape?: string; background?: string; style?: string; routing?: string }
interface Frame { k: 'model' | 'views' | 'styles' | 'style' | 'skip'; el?: El; st?: Style }

const TYPE: Record<ElType, string> = { person: 'Person', softwaresystem: 'Software System', container: 'Container', component: 'Component', group: 'Group' };
const DEFAULT_KIND: Record<ElType, Kind> = { person: 'person', softwaresystem: 'system', container: 'container', component: 'component', group: 'boundary' };
const SHAPE: Record<string, Kind> = {
  cylinder: 'database', pipe: 'queue', webbrowser: 'browser', window: 'browser', mobiledeviceportrait: 'browser',
  mobiledevicelandscape: 'browser', person: 'person', robot: 'person', ellipse: 'ellipse', circle: 'ellipse',
};
const own = <T>(o: Record<string, T>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const split = (s = '') => s.split(',').map(t => t.trim()).filter(Boolean);
// Tag conventions people use without declaring a shape style.
const guess = (tags: string): Kind | undefined =>
  /database|datastore|\bdb\b/.test(tags) ? 'database'
  : /queue|topic|bus|pub.?sub|stream/.test(tags) ? 'queue'
  : /browser|\bspa\b|mobile/.test(tags) ? 'browser' : undefined;

export const looksLikeDsl = (s: string) => /^\s*(workspace\b|[\w.-]+\s*=\s*(person|softwareSystem|container|component)\b)/im.test(s);

export function parseDsl(src: string, m: Measure): Doc {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\\r?\n/g, ' ')
    .split('\n').filter(l => !/^\s*(#|\/\/)/.test(l)).join('\n');
  const ids = new Map<string, El>(), els: El[] = [], rels: Rel[] = [];
  const styles = { element: new Map<string, Style>(), relationship: new Map<string, Style>() };
  const stack: Frame[] = [{ k: 'model' }];
  let dir = '';

  const statement = (a: string[], opens: boolean) => {
    const top = stack[stack.length - 1], kw = (a[0] ?? '').toLowerCase(), v = (a[1] ?? '').toLowerCase();
    const push = (f: Frame) => { if (opens) stack.push(f); };
    if (top.k === 'skip') return push({ k: 'skip' });
    if (top.k === 'style') {
      const st = top.st!;
      if (kw === 'shape') st.shape = v;
      else if (kw === 'background' && /^#([0-9a-f]{3}){1,2}$/.test(v)) st.background = v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v;
      else if (kw === 'style') st.style = v;
      else if (kw === 'dashed') st.style = v === 'true' ? 'dashed' : 'solid';
      else if (kw === 'routing') st.routing = v;
      return push({ k: 'skip' });
    }
    if (top.k === 'styles') {
      if ((kw === 'element' || kw === 'relationship') && a[1]) {
        const map = styles[kw], st = map.get(a[1]) ?? {};
        map.set(a[1], st);
        return push({ k: 'style', st });
      }
      return push({ k: 'skip' });
    }
    if (top.k === 'views') {
      if (kw === 'autolayout' && !dir) dir = v || 'tb';
      return push({ k: kw === 'styles' ? 'styles' : 'views' });
    }
    if (kw === 'views') return push({ k: 'views' });
    if (kw === 'workspace' || kw === 'model' || kw === 'enterprise') return push({ k: 'model', el: top.el });

    const assign = a[1] === '=', b = assign ? a.slice(2) : a, type = (b[0] ?? '').toLowerCase(), arrow = b.indexOf('->');
    if (arrow >= 0) { // [id =] [source] -> destination [description] [technology] [tags]
      const [to = '', desc = '', tech = '', tags = ''] = b.slice(arrow + 1);
      rels.push({ from: arrow === 0 ? 'this' : b[0], ctx: top.el, to, desc, tech, tags: split(tags) });
      return push({ k: 'skip' });
    }
    if (Object.hasOwn(TYPE, type)) { // [id =] person|softwareSystem name [description] [tags], container|component add [technology]
      const t = type as ElType, hasTech = t === 'container' || t === 'component';
      const el: El = {
        type: t, name: b[1] ?? '', desc: t === 'group' ? '' : (b[2] ?? ''), tech: hasTech ? (b[3] ?? '') : '',
        tags: split(hasTech ? b[4] : t === 'group' ? '' : b[3]), parent: top.el, path: '', kids: [],
      };
      top.el?.kids.push(el);
      els.push(el);
      if (assign) { // register flat and hierarchical (system.container) identifiers
        let p = top.el;
        while (p && !p.path) p = p.parent;
        el.path = p ? `${p.path}.${a[0]}` : a[0];
        if (!ids.has(a[0])) ids.set(a[0], el);
        ids.set(el.path, el);
      }
      return push({ k: 'model', el });
    }
    if (top.el) {
      if (kw === 'description') top.el.desc = a[1] ?? '';
      else if (kw === 'technology') top.el.tech = a[1] ?? '';
      else if (kw === 'tags') top.el.tags.push(...a.slice(1).flatMap(s => split(s)));
    }
    push({ k: 'skip' }); // deployment, properties, perspectives, !directives, …
  };

  // Line-based language: a statement ends at a newline or `{`; `}` closes the current block.
  let cur: string[] = [];
  const flush = (opens: boolean) => { if (cur.length || opens) statement(cur, opens); cur = []; };
  for (const [, quoted, sym, word] of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|(->|[{}=\n])|([^\s{}="]+)/g)) {
    if (quoted !== undefined) cur.push(quoted.replace(/\\(.)/g, '$1'));
    else if (sym === '\n') flush(false);
    else if (sym === '{') flush(true);
    else if (sym === '}') { flush(false); if (stack.length > 1) stack.pop(); }
    else cur.push(sym ?? word);
  }
  flush(false);

  const styleOf = (tags: string[], map: Map<string, Style>): Style => Object.assign({}, ...tags.map(t => map.get(t) ?? {}));
  for (const el of els) {
    const st = styleOf(['Element', TYPE[el.type], ...el.tags], styles.element), tags = el.tags.join(',').toLowerCase();
    const boundary = el.type === 'group' || el.kids.length > 0;
    const kind: Kind = boundary ? 'boundary' : own(SHAPE, st.shape ?? '') ?? guess(tags) ?? DEFAULT_KIND[el.type];
    const type = el.tech ? `${TYPE[el.type]}: ${el.tech}` : TYPE[el.type];
    const text = boundary
      ? (el.type === 'group' ? el.name : `${el.name} [${type}]`) + (el.desc ? `\n${el.desc}` : '')
      : el.name + (el.tech ? ` [${el.tech}]` : '') + (el.desc ? `\n${el.desc}` : '');
    const n = makeNode(kind, 0, 0, text);
    if (tags.includes('external')) n.ext = true;
    if (!boundary && st.background && st.background !== nodeColor(n, LIGHT)) n.color = st.background;
    if (!boundary) fitText(n, m);
    el.node = n;
  }

  const links: [El, El][] = [], edges: Edge[] = [];
  for (const r of rels) {
    const a = r.from === 'this' ? r.ctx : ids.get(r.from), b = ids.get(r.to);
    if (!a?.node || !b?.node || a === b) continue;
    const st = styleOf(['Relationship', ...r.tags], styles.relationship);
    const e = makeEdge(a.node.id, b.node.id, {
      dash: st.style === 'dotted' ? 2 : st.style === 'dashed' ? 1 : 0,
      route: st.routing === 'orthogonal' ? 'elbow' : st.routing === 'curved' ? 'curve' : 'straight', head: 'end',
    });
    e.text = r.desc + (r.tech ? ` [${r.tech}]` : '');
    edges.push(e);
    links.push([a, b]);
  }

  const roots = els.filter(e => !e.parent), lr = dir === 'lr' || dir === 'rl';
  layout(roots, links, lr);
  offset(roots, 0, 0);
  return { nodes: els.map(e => e.node!), edges };
}

// ---------- auto-layout ----------
// ponytail: layered layout (longest path + one barycenter pass), recursive for boundaries.
// Good for typical C4 sizes; reach for ELK/dagre if crossings on big models get annoying.
const PAD = 40, LABEL = 40;

function layout(kids: El[], links: [El, El][], lr: boolean): [number, number] {
  if (!kids.length) return [0, 0];
  for (const k of kids) if (k.kids.length) {
    const [w, h] = layout(k.kids, links, lr);
    k.node!.w = Math.max(240, w + 2 * PAD);
    k.node!.h = h + 2 * PAD + LABEL;
  }
  // Lift every relationship to the pair of siblings at this level that contain its endpoints.
  const lift = (e?: El) => { while (e && !kids.includes(e)) e = e.parent; return e; };
  const out = new Map(kids.map(k => [k, new Set<El>()]));
  for (const [a, b] of links) { const x = lift(a), y = lift(b); if (x && y && x !== y) out.get(x)!.add(y); }

  // Reverse DFS postorder is a topological order; edges pointing backwards in it close cycles and are ignored.
  const post: El[] = [], visited = new Set<El>();
  const dfs = (u: El) => { visited.add(u); for (const v of out.get(u)!) if (!visited.has(v)) dfs(v); post.push(u); };
  for (const k of kids) if (!visited.has(k)) dfs(k);
  const topo = post.reverse(), at = new Map(topo.map((k, i) => [k, i])), rank = new Map(kids.map(k => [k, 0]));
  for (const u of topo) for (const v of out.get(u)!) if (at.get(v)! > at.get(u)!) rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));

  const cols: El[][] = [];
  for (const k of kids) (cols[rank.get(k)!] ??= []).push(k);
  const size = (k: El) => (lr ? [k.node!.w, k.node!.h] : [k.node!.h, k.node!.w]); // [along ranks, across]
  const [gapMain, gapCross] = lr ? [170, 60] : [130, 80];
  const mid = new Map<El, number>(), spots: [El, number, number][] = [];
  let main = 0;
  for (const col of cols) {
    const key = (k: El) => {
      const ps = kids.filter(p => out.get(p)!.has(k) && mid.has(p));
      return ps.length ? ps.reduce((s, p) => s + mid.get(p)!, 0) / ps.length : 0;
    };
    col.sort((a, b) => key(a) - key(b));
    const extent = Math.max(...col.map(k => size(k)[0]));
    let c = -(col.reduce((s, k) => s + size(k)[1], 0) + gapCross * (col.length - 1)) / 2;
    for (const k of col) {
      const [along, across] = size(k);
      spots.push([k, main + (extent - along) / 2, c]);
      mid.set(k, c + across / 2);
      c += across + gapCross;
    }
    main += extent + gapMain;
  }
  const minCross = Math.min(...spots.map(s => s[2]));
  let w = 0, h = 0;
  for (const [k, along, across] of spots) {
    const n = k.node!;
    [n.x, n.y] = lr ? [along, across - minCross] : [across - minCross, along];
    w = Math.max(w, n.x + n.w);
    h = Math.max(h, n.y + n.h);
  }
  return [w, h];
}

function offset(kids: El[], ox: number, oy: number) {
  for (const k of kids) {
    const n = k.node!;
    n.x = snap(n.x + ox);
    n.y = snap(n.y + oy);
    if (k.kids.length) offset(k.kids, n.x + PAD, n.y + PAD);
  }
}

// ---------- export ----------
const CONTAINERS: Kind[] = ['container', 'database', 'queue', 'browser'];
const TAG: Partial<Record<Kind, string>> = { database: 'Database', queue: 'Queue', browser: 'Web Browser', ellipse: 'Ellipse' };
const NEEDS: Record<string, string> = { person: 'root', softwareSystem: 'root', container: 'softwareSystem', component: 'container' };

export function toDsl(doc: Doc): string {
  // Containment comes from geometry: a node belongs to the smallest boundary around its centre.
  const area = (n: Node) => n.w * n.h, bounds = doc.nodes.filter(n => n.kind === 'boundary');
  const parent = new Map(doc.nodes.map(n => [n, bounds.filter(b => area(b) > area(n) && inRect(b, center(n), 0)).sort((a, b) => area(a) - area(b))[0]]));
  const btype = new Map<Node, string>();
  for (const b of bounds) {
    const tech = parseLabel(b.text).tech.toLowerCase(), ks = doc.nodes.filter(n => parent.get(n) === b);
    btype.set(b, tech.startsWith('software system') ? 'softwareSystem' : tech.startsWith('container') ? 'container'
      : ks.some(k => CONTAINERS.includes(k.kind)) ? 'softwareSystem' : ks.some(k => k.kind === 'component') ? 'container' : 'group');
  }
  const typeOf = (n: Node) => n.kind === 'boundary' ? btype.get(n)! : n.kind === 'person' ? 'person'
    : CONTAINERS.includes(n.kind) ? 'container' : n.kind === 'component' ? 'component' : n.kind === 'text' ? '' : 'softwareSystem';

  // Structurizr nesting rules: people/systems at the top, containers in systems, components in containers,
  // groups anywhere. Anything drawn elsewhere moves to the top or into a generated wrapper.
  const home = new Map<Node, Node | 'root' | 'sys' | 'cont'>();
  for (const n of doc.nodes) {
    const t = typeOf(n);
    if (!t) continue;
    let p = parent.get(n);
    while (p && btype.get(p) === 'group') p = parent.get(p);
    const legal = t === 'group' || (p ? btype.get(p) : 'root') === NEEDS[t];
    home.set(n, legal ? (parent.get(n) ?? 'root') : t === 'container' ? 'sys' : t === 'component' ? 'cont' : 'root');
  }

  const used = new Set<string>(), ids = new Map<Node, string>();
  for (const n of home.keys()) if (typeOf(n) !== 'group') {
    const base = (parseLabel(n.text).name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || typeOf(n).toLowerCase()).replace(/^(\d)/, '_$1');
    let id = base, i = 2;
    while (used.has(id)) id = `${base}${i++}`;
    used.add(id);
    ids.set(n, id);
  }

  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ')}"`;
  const args = (...a: string[]) => { while (a.length > 1 && !a[a.length - 1]) a.pop(); return a.map(q).join(' '); };
  const colors = new Set<string>(), lines: string[] = [];
  const emit = (where: Node | string, depth: number) => {
    const ind = '    '.repeat(depth);
    for (const [n, h] of home) if (h === where) {
      const t = typeOf(n), { name, tech, desc } = parseLabel(n.text), label = name || 'Unnamed';
      if (n.color) colors.add(n.color);
      const tags = [TAG[n.kind], n.ext && 'External', n.color && `Color ${n.color.slice(1)}`].filter(Boolean).join(',');
      const tk = n.kind === 'boundary' ? tech.replace(/^(software system|container)\s*:?\s*/i, '') : tech;
      const head = t === 'group' ? `group ${q(label)}`
        : `${ids.get(n)} = ${t} ${t === 'container' || t === 'component' ? args(label, desc, tk, tags) : args(label, desc, tags)}`;
      if ([...home.values()].includes(n)) {
        lines.push(`${ind}${head} {`);
        emit(n, depth + 1);
        lines.push(`${ind}}`);
      } else lines.push(ind + head);
    }
  };
  const wrapped = [...home.values()];
  emit('root', 2);
  if (wrapped.includes('sys') || wrapped.includes('cont')) {
    lines.push('        diagram = softwareSystem "Diagram" {');
    emit('sys', 3);
    if (wrapped.includes('cont')) { lines.push('            components = container "Components" {'); emit('cont', 4); lines.push('            }'); }
    lines.push('        }');
  }

  const byId = new Map(doc.nodes.map(n => [n.id, n])), rels = new Set<string>(), relTags = new Set<string>();
  for (const e of doc.edges) {
    const a = ids.get(byId.get(e.from)!), b = ids.get(byId.get(e.to)!), { name, tech } = parseLabel(e.text);
    if (!a || !b || rels.has(`${a}>${b}>${name}`)) continue; // Structurizr rejects duplicate relationships
    rels.add(`${a}>${b}>${name}`);
    const tags = [['', 'Dashed', 'Dotted'][e.dash], { straight: '', elbow: 'Orthogonal', curve: 'Curved' }[e.route]].filter(Boolean);
    tags.forEach(t => relTags.add(t));
    lines.push(`        ${a} -> ${b}${name || tech || tags.length ? ' ' + args(name, tech, tags.join(',')) : ''}`);
  }

  const views = ['        systemLandscape "landscape" {', '            include *', '            autolayout lr', '        }'];
  for (const [n, id] of ids) {
    const t = n.kind === 'boundary' ? btype.get(n) : '';
    if (t === 'softwareSystem' || t === 'container')
      views.push(`        ${t === 'softwareSystem' ? 'container' : 'component'} ${id} "${id}" {`, '            include *', '            autolayout lr', '        }');
  }
  const style = (what: string, tag: string, props: string[]) => [`            ${what} ${q(tag)} {`, ...props.map(p => `                ${p}`), '            }'];
  const REL: Record<string, string> = { Dashed: 'style dashed', Dotted: 'style dotted', Orthogonal: 'routing orthogonal', Curved: 'routing curved' };
  const styleLines = [
    ...style('element', 'Person', ['shape person', 'background #08427b', 'color #ffffff']),
    ...style('element', 'Software System', ['background #1168bd', 'color #ffffff']),
    ...style('element', 'Container', ['background #438dd5', 'color #ffffff']),
    ...style('element', 'Component', ['background #85bbf0', 'color #000000']),
    ...style('element', 'Database', ['shape cylinder']),
    ...style('element', 'Queue', ['shape pipe']),
    ...style('element', 'Web Browser', ['shape webbrowser']),
    ...style('element', 'Ellipse', ['shape ellipse']),
    ...style('element', 'External', ['background #7d7d7d', 'color #ffffff']),
    ...[...colors].flatMap(c => style('element', `Color ${c.slice(1)}`, [`background ${c}`, `color ${textOn(c) === '#ffffff' ? '#ffffff' : '#000000'}`])),
    ...style('relationship', 'Relationship', ['style solid']),
    ...[...relTags].flatMap(t => style('relationship', t, [REL[t]])),
  ];
  return ['workspace "Diagram" "Exported from fasdraw" {', '    model {', ...lines, '    }', '', '    views {', ...views, '        styles {', ...styleLines, '        }', '    }', '}', ''].join('\n');
}

