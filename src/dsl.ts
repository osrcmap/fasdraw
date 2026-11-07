// Structurizr DSL <-> fasdraw. Structurizr DSL is the open text language for C4 models
// (https://docs.structurizr.com/dsl). Import reads the model, deployment environments and styles; elements
// are laid out automatically unless the file carries fasdraw positions (written by our own export, as
// workspace properties). Export writes a workspace that Structurizr tooling accepts.
import { LIGHT, center, fitText, inRect, makeEdge, makeNode, nodeColor, parseLabel, snap, textOn } from './model.ts';
import type { Doc, Edge, Kind, Measure, Node } from './model.ts';

type ElType = 'person' | 'softwaresystem' | 'container' | 'component' | 'group'
  | 'deploymentenvironment' | 'deploymentnode' | 'infrastructurenode' | 'containerinstance' | 'softwaresysteminstance';
type Field = 'name' | 'desc' | 'tech' | 'ref' | 'count';
interface El { type: ElType; ident: string; path: string; name: string; desc: string; tech: string; ref: string; count: string; tags: string[]; parent?: El; kids: El[]; node?: Node }
interface Rel { from: string; ctx?: El; to: string; desc: string; tech: string; tags: string[] }
interface Style { shape?: string; background?: string; style?: string; routing?: string }
interface Frame { k: 'model' | 'views' | 'styles' | 'style' | 'props' | 'skip'; el?: El; st?: Style }

const TYPE: Record<ElType, string> = {
  person: 'Person', softwaresystem: 'Software System', container: 'Container', component: 'Component', group: 'Group',
  deploymentenvironment: 'Deployment Environment', deploymentnode: 'Deployment Node', infrastructurenode: 'Infrastructure Node',
  containerinstance: 'Container Instance', softwaresysteminstance: 'Software System Instance',
};
// Positional arguments after each keyword ('' = an argument we ignore, e.g. deployment groups).
const ARGS: Record<ElType, (Field | 'tags' | '')[]> = {
  person: ['name', 'desc', 'tags'], softwaresystem: ['name', 'desc', 'tags'], container: ['name', 'desc', 'tech', 'tags'],
  component: ['name', 'desc', 'tech', 'tags'], group: ['name'], deploymentenvironment: ['name'],
  deploymentnode: ['name', 'desc', 'tech', 'tags', 'count'], infrastructurenode: ['name', 'desc', 'tech', 'tags'],
  containerinstance: ['ref', '', 'tags'], softwaresysteminstance: ['ref', '', 'tags'],
};
const DEFAULT_KIND: Record<ElType, Kind> = {
  person: 'person', softwaresystem: 'system', container: 'container', component: 'component', group: 'boundary',
  deploymentenvironment: 'boundary', deploymentnode: 'rect', infrastructurenode: 'rect', containerinstance: 'container', softwaresysteminstance: 'system',
};
const SHAPE: Record<string, Kind> = {
  cylinder: 'database', pipe: 'queue', webbrowser: 'browser', window: 'browser', mobiledeviceportrait: 'browser',
  mobiledevicelandscape: 'browser', person: 'person', robot: 'person', ellipse: 'ellipse', circle: 'ellipse',
};
const GENERATED = 'fasdraw:generated'; // tag on wrappers our export adds to satisfy Structurizr nesting rules
const own = <T>(o: Record<string, T>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const split = (s = '') => s.split(',').map(t => t.trim()).filter(Boolean);
// Tag conventions people use without declaring a shape style.
const guess = (tags: string): Kind | undefined =>
  /database|datastore|\bdb\b/.test(tags) ? 'database'
  : /queue|topic|bus|pub.?sub|stream/.test(tags) ? 'queue'
  : /browser|\bspa\b|mobile/.test(tags) ? 'browser' : undefined;
const leafText = (e: El) => e.name + (e.tech ? ` [${e.tech}]` : '') + (e.desc ? `\n${e.desc}` : '');

export const looksLikeDsl = (s: string) => /^\s*(workspace\b|[\w.-]+\s*=\s*(person|softwareSystem|container|component)\b)/im.test(s);

// `include` resolves an `!include` path to that file's text (undefined: not available).
export function parseDsl(src: string, m: Measure, include?: (path: string) => string | undefined): Doc {
  const expand = (s: string, depth: number): string => s.replace(/^[ \t]*!include[ \t]+"?([^"\r\n]*?)"?[ \t]*\r?$/gm, (_, path: string) => {
    const t = depth < 8 ? include?.(path.trim()) : undefined;
    return t === undefined ? '' : expand(t, depth + 1);
  });
  const text = expand(src, 0).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\\r?\n/g, ' ')
    .split('\n').filter(l => !/^\s*(#|\/\/)/.test(l)).join('\n');
  const ids = new Map<string, El>(), els: El[] = [], rels: Rel[] = [], props = new Map<string, string>();
  const styles = { element: new Map<string, Style>(), relationship: new Map<string, Style>() };
  const stack: Frame[] = [{ k: 'model' }];
  let dir = '';

  const statement = (a: string[], opens: boolean) => {
    const top = stack[stack.length - 1], kw = (a[0] ?? '').toLowerCase(), v = (a[1] ?? '').toLowerCase();
    const push = (f: Frame) => { if (opens) stack.push(f); };
    if (top.k === 'skip') return push({ k: 'skip' });
    if (top.k === 'props') { if (a.length >= 2) props.set(a[0], a[1]); return push({ k: 'skip' }); }
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
    if (kw === 'properties') return push({ k: 'props' });
    if (kw === 'workspace' || kw === 'model' || kw === 'enterprise') return push({ k: 'model', el: top.el });

    const assign = a[1] === '=', b = assign ? a.slice(2) : a, type = (b[0] ?? '').toLowerCase(), arrow = b.indexOf('->');
    if (arrow >= 0) { // [id =] [source] -> destination [description] [technology] [tags]
      const [to = '', desc = '', tech = '', tags = ''] = b.slice(arrow + 1);
      rels.push({ from: arrow === 0 ? 'this' : b[0], ctx: top.el, to, desc, tech, tags: split(tags) });
      return push({ k: 'skip' });
    }
    if (Object.hasOwn(TYPE, type)) {
      const el: El = { type: type as ElType, ident: assign ? a[0] : '', path: '', name: '', desc: '', tech: '', ref: '', count: '', tags: [], parent: top.el, kids: [] };
      ARGS[el.type].forEach((f, i) => {
        if (f === 'tags') el.tags.push(...split(b[i + 1]));
        else if (f) el[f] = b[i + 1] ?? '';
      });
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
    push({ k: 'skip' }); // perspectives, health checks, !directives, …
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
  for (const el of els) if (!el.ref) {
    const st = styleOf(['Element', TYPE[el.type], ...el.tags], styles.element), tags = el.tags.join(',').toLowerCase();
    const boundary = el.type === 'group' || el.type === 'deploymentenvironment' || el.kids.length > 0;
    const kind: Kind = boundary ? 'boundary' : own(SHAPE, st.shape ?? '') ?? guess(tags) ?? DEFAULT_KIND[el.type];
    const name = el.count && el.count !== '1' ? `${el.name} ×${el.count}` : el.name;
    const type = el.tech ? `${TYPE[el.type]}: ${el.tech}` : TYPE[el.type];
    const deploy = el.type === 'deploymentnode' || el.type === 'infrastructurenode';
    const text = el.type === 'group' ? el.name + (el.desc ? `\n${el.desc}` : '')
      : boundary || deploy ? `${name} [${type}]` + (el.desc ? `\n${el.desc}` : '') : leafText(el);
    const n = makeNode(kind, 0, 0, text);
    if (tags.includes('external')) n.ext = true;
    if (!boundary && st.background && st.background !== nodeColor(n, LIGHT)) n.color = st.background;
    if (!boundary) fitText(n, m);
    el.node = n;
  }
  // Instances look like what they deploy (a system drawn expanded is deployed as a plain system box).
  for (const el of els) if (el.ref) {
    const src = ids.get(el.ref), s = src?.node;
    if (!src || !s || src.ref) continue;
    const n = makeNode(s.kind === 'boundary' ? DEFAULT_KIND[src.type] : s.kind, 0, 0, leafText(src));
    Object.assign(n, { ext: s.ext, color: s.color });
    fitText(n, m);
    el.node = n;
  }
  const live = els.filter(e => e.node); // drops instances of unknown elements
  for (const e of live) e.kids = e.kids.filter(k => k.node);

  const links: [El, El][] = [], edges: Edge[] = [];
  const connect = (a: El, b: El, r: Rel) => {
    const st = styleOf(['Relationship', ...r.tags], styles.relationship);
    const e = makeEdge(a.node!.id, b.node!.id, {
      dash: st.style === 'dotted' ? 2 : st.style === 'dashed' ? 1 : 0,
      route: st.routing === 'orthogonal' ? 'elbow' : st.routing === 'curved' ? 'curve' : 'straight', head: 'end',
    });
    e.text = r.desc + (r.tech ? ` [${r.tech}]` : '');
    edges.push(e);
    links.push([a, b]);
  };
  // Deployed instances inherit the relationships of what they deploy, within one environment.
  const envOf = (e: El) => { let p = e.parent; while (p && p.type !== 'deploymentenvironment') p = p.parent; return p; };
  const deployed = new Map<El, El[]>();
  for (const e of live) if (e.ref) { const src = ids.get(e.ref)!; deployed.set(src, [...(deployed.get(src) ?? []), e]); }
  for (const r of rels) {
    const a = r.from === 'this' ? r.ctx : ids.get(r.from), b = ids.get(r.to);
    if (!a?.node || !b?.node || a === b) continue;
    connect(a, b, r);
    for (const ia of deployed.get(a) ?? []) for (const ib of deployed.get(b) ?? []) if (envOf(ia) === envOf(ib)) connect(ia, ib, r);
  }

  place(live, links, dir === 'lr' || dir === 'rl', props);
  return { nodes: live.filter(e => !e.tags.includes(GENERATED)).map(e => e.node!), edges };
}

// Stored positions (our export's "fasdraw.layout.<id>" properties) win; anything without one is laid out:
// everything for a plain Structurizr file, or only what was added since the export, in a row underneath.
function place(els: El[], links: [El, El][], lr: boolean, props: Map<string, string>) {
  const known = new Map<El, number[]>();
  for (const e of els) {
    const key = e.type === 'group' ? `group:${e.name}` : e.ident, v = key ? props.get(`fasdraw.layout.${key}`)?.split(',').map(Number) : undefined;
    if (v?.length === 4 && v.every(Number.isFinite)) known.set(e, v);
  }
  const roots = els.filter(e => !e.parent);
  if (!known.size) { // the model first, each deployment environment below it
    const model = roots.filter(e => e.type !== 'deploymentenvironment');
    layout(model, links, lr);
    offset(model, 0, 0);
    let y = Math.max(0, ...model.map(e => e.node!.y + e.node!.h)) + 200;
    for (const env of roots.filter(e => e.type === 'deploymentenvironment')) {
      layout([env], links, lr);
      offset([env], 0, y);
      y += env.node!.h + 200;
    }
    return;
  }
  for (const [e, [x, y, w, h]] of known) Object.assign(e.node!, { x, y, w, h });
  const memo = new Map<El, boolean>();
  const hasKnown = (e: El): boolean => memo.get(e) ?? (memo.set(e, known.has(e) || e.kids.some(hasKnown)), memo.get(e)!);
  const placed = [...known.keys()].map(e => e.node!);
  let x = Math.min(...placed.map(n => n.x)), y = Math.max(...placed.map(n => n.y + n.h)) + 120;
  for (const e of els) if (!hasKnown(e) && (!e.parent || hasKnown(e.parent))) {
    layout([e], links, lr);
    offset([e], x, y);
    x += e.node!.w + 80;
  }
  // Boundaries grow to hold their contents (children come after parents in `els`).
  for (const e of [...els].reverse()) if (e.kids.length && hasKnown(e)) {
    const n = e.node!, ks = e.kids.map(k => k.node!), was = known.get(e);
    const x0 = Math.min(...ks.map(k => k.x)) - PAD, y0 = Math.min(...ks.map(k => k.y)) - PAD;
    const x1 = Math.max(...ks.map(k => k.x + k.w)) + PAD, y1 = Math.max(...ks.map(k => k.y + k.h)) + PAD + LABEL;
    const [bx, by, bx1, by1] = was ? [Math.min(x0, n.x), Math.min(y0, n.y), Math.max(x1, n.x + n.w), Math.max(y1, n.y + n.h)] : [x0, y0, x1, y1];
    Object.assign(n, { x: bx, y: by, w: bx1 - bx, h: by1 - by });
  }
}

// ---------- auto-layout ----------
// Layered layout (longest path + one barycenter pass), recursive for boundaries.
// Suits typical C4 model sizes; very large models can show edge crossings.
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
  const techOf = (n: Node) => parseLabel(n.text).tech.toLowerCase();
  const btype = new Map<Node, string>();
  for (const b of bounds) {
    const tech = techOf(b), ks = doc.nodes.filter(n => parent.get(n) === b);
    btype.set(b, tech.startsWith('deployment environment') ? 'deploymentEnvironment' : tech.startsWith('deployment node') ? 'deploymentNode'
      : tech.startsWith('software system') ? 'softwareSystem' : tech.startsWith('container') ? 'container'
      : ks.some(k => CONTAINERS.includes(k.kind)) ? 'softwareSystem' : ks.some(k => k.kind === 'component') ? 'container' : 'group');
  }
  const inDeployment = (n: Node) => { for (let p: Node | undefined = n; p; p = parent.get(p)) if (btype.get(p)?.startsWith('deployment')) return true; return false; };
  const typeOf = (n: Node) => n.kind === 'boundary' ? btype.get(n)! : n.kind === 'person' ? 'person'
    : CONTAINERS.includes(n.kind) ? 'container' : n.kind === 'component' ? 'component' : n.kind === 'text' ? '' : 'softwareSystem';

  // Structurizr nesting rules: people/systems at the top, containers in systems, components in containers,
  // groups anywhere. Anything drawn elsewhere moves to the top or into a generated wrapper.
  const home = new Map<Node, Node | 'root' | 'sys' | 'cont'>();
  for (const n of doc.nodes) {
    const t = typeOf(n);
    if (!t || inDeployment(n)) continue;
    let p = parent.get(n);
    while (p && btype.get(p) === 'group') p = parent.get(p);
    const legal = t === 'group' || (p ? btype.get(p) : 'root') === NEEDS[t];
    home.set(n, legal ? (parent.get(n) ?? 'root') : t === 'container' ? 'sys' : t === 'component' ? 'cont' : 'root');
  }

  const used = new Set<string>(), ids = new Map<Node, string>();
  const idFor = (n: Node) => {
    const base = (parseLabel(n.text).name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || n.kind).replace(/^(\d)/, '_$1');
    let id = base, i = 2;
    while (used.has(id)) id = `${base}${i++}`;
    used.add(id);
    ids.set(n, id);
    return id;
  };
  for (const n of home.keys()) if (typeOf(n) !== 'group') idFor(n);

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
    lines.push(`        diagram = softwareSystem "Diagram" "" "${GENERATED}" {`);
    emit('sys', 3);
    if (wrapped.includes('cont')) {
      lines.push(`            components = container "Components" "" "" "${GENERATED}" {`);
      emit('cont', 4);
      lines.push('            }');
    }
    lines.push('        }');
  }

  // Deployment: environments and nodes from boundaries labelled as such; leaves inside them become
  // instances of the model element with the same name, or infrastructure nodes.
  const modelByName = new Map<string, Node>();
  for (const n of ids.keys()) modelByName.set(`${typeOf(n)}:${parseLabel(n.text).name}`, n);
  const instanceOf = new Map<Node, Node>();
  const emitDeploy = (n: Node, depth: number) => {
    const ind = '    '.repeat(depth), { name, tech, desc } = parseLabel(n.text), id = idFor(n);
    const tk = tech.replace(/^(deployment environment|deployment node|infrastructure node)\s*:?\s*/i, '');
    const kids = doc.nodes.filter(k => parent.get(k) === n);
    const ref = n.kind === 'boundary' ? undefined : modelByName.get(`${typeOf(n)}:${name}`);
    let head: string;
    if (btype.get(n) === 'deploymentEnvironment') head = `${id} = deploymentEnvironment ${q(name || 'Deployment')}`;
    else if (n.kind === 'boundary' || techOf(n).startsWith('deployment node')) head = `${id} = deploymentNode ${args(name || 'Node', desc, tk)}`;
    else if (ref && !techOf(n).startsWith('infrastructure node')) {
      instanceOf.set(n, ref);
      head = `${id} = ${typeOf(ref) === 'softwareSystem' ? 'softwareSystemInstance' : 'containerInstance'} ${ids.get(ref)}`;
    } else head = `${id} = infrastructureNode ${args(name || 'Node', desc, tk)}`;
    if (!kids.length) return void lines.push(ind + head);
    lines.push(`${ind}${head} {`);
    for (const k of kids) emitDeploy(k, depth + 1);
    lines.push(`${ind}}`);
  };
  const tops = doc.nodes.filter(n => inDeployment(n) && !(parent.get(n) && inDeployment(parent.get(n)!)));
  for (const n of tops) if (btype.get(n) === 'deploymentEnvironment') emitDeploy(n, 2);
  const loose = tops.filter(n => btype.get(n) !== 'deploymentEnvironment');
  if (loose.length) {
    lines.push('        deployment = deploymentEnvironment "Deployment" {');
    for (const n of loose) emitDeploy(n, 3);
    lines.push('        }');
  }

  const byId = new Map(doc.nodes.map(n => [n.id, n])), rels = new Set<string>(), relTags = new Set<string>();
  for (const e of doc.edges) {
    const na = byId.get(e.from)!, nb = byId.get(e.to)!, a = ids.get(na), b = ids.get(nb), { name, tech } = parseLabel(e.text);
    const ra = instanceOf.get(na), rb = instanceOf.get(nb);
    if (ra && rb && doc.edges.some(x => x.from === ra.id && x.to === rb.id)) continue; // implied by the model
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
    if (t === 'deploymentEnvironment')
      views.push(`        deployment * ${q(parseLabel(n.text).name || 'Deployment')} "${id}" {`, '            include *', '            autolayout lr', '        }');
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
  // Positions are not part of the DSL; keep them as workspace properties so a round trip loses nothing.
  const box = (n: Node) => [n.x, n.y, n.w, n.h].map(Math.round).join(',');
  const layout = [
    ...[...ids].map(([n, id]) => `        ${q(`fasdraw.layout.${id}`)} "${box(n)}"`),
    ...bounds.filter(b => btype.get(b) === 'group' && home.has(b)).map(b => `        ${q(`fasdraw.layout.group:${parseLabel(b.text).name || 'Unnamed'}`)} "${box(b)}"`),
  ];
  return ['workspace "Diagram" "Exported from fasdraw" {', '    model {', ...lines, '    }', '', '    views {', ...views, '        styles {', ...styleLines, '        }', '    }',
    ...(layout.length ? ['', '    properties {', ...layout, '    }'] : []), '}', ''].join('\n');
}
