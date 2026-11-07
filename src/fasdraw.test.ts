// Run: npm test  (Node's built-in runner; Node >= 22.18 runs TypeScript directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeGeom, hitTest, makeEdge, makeNode, parseLabel } from './model.ts';
import type { Doc } from './model.ts';
import { parseFasdraw, pdfFromRgb, serialize, toExcalidraw, toSvg } from './io.ts';

const m = (s: string, size: number) => s.length * size * 0.55;
const sample = (): Doc => {
  const a = makeNode('person', 0, 0, 'User'), b = makeNode('container', 400, 0, 'API [Go]\nServes orders'), c = makeNode('database', 400, 300, 'DB');
  return {
    nodes: [a, b, c],
    edges: [makeEdge(a.id, b.id, { dash: 0, route: 'straight', head: 'end' }), makeEdge(b.id, c.id, { dash: 1, route: 'elbow', head: 'both' })],
  };
};

test('label convention', () => {
  assert.deepEqual(parseLabel('API [Spring Boot]\nHandles orders'), { name: 'API', tech: 'Spring Boot', desc: 'Handles orders' });
  assert.deepEqual(parseLabel('DB\n[PostgreSQL]\nstores\nstuff'), { name: 'DB', tech: 'PostgreSQL', desc: 'stores\nstuff' });
  assert.deepEqual(parseLabel('plain'), { name: 'plain', tech: '', desc: '' });
});

test('.fasdraw round-trips and rejects junk', () => {
  const d = sample();
  assert.equal(serialize(parseFasdraw(serialize(d))), serialize(d));
  assert.throws(() => parseFasdraw('{"type":"other"}'));
  const bad = parseFasdraw(JSON.stringify({
    type: 'fasdraw',
    nodes: [{ id: 'a', kind: 'toString', x: 'nope', color: '"><script>' }, { id: 'a' }],
    edges: [{ id: 'e', from: 'a', to: 'missing' }],
  }));
  assert.equal(bad.nodes.length, 1);
  assert.equal(bad.nodes[0].kind, 'rect');
  assert.equal(bad.nodes[0].x, 0);
  assert.equal(bad.nodes[0].color, undefined);
  assert.equal(bad.edges.length, 0);
});

test('hit testing finds nodes and edges', () => {
  const d = sample(), [a, b] = d.nodes;
  assert.equal(hitTest(d, [b.x + 5, b.y + 5], 4), b.id);
  assert.equal(hitTest(d, [-999, -999], 4), undefined);
  assert.equal(hitTest(d, edgeGeom(d.edges[0], a, b).mid, 4), d.edges[0].id);
});

test('svg escapes user text', () => {
  const d = sample();
  d.nodes[0].text = '<b>&"x"';
  const svg = toSvg(d, m);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('&#60;b&#62;&#38;&#34;x&#34;'));
});

test('excalidraw export keeps bindings consistent', () => {
  const x = toExcalidraw(sample(), m), ids = new Set(x.elements.map(e => e.id));
  for (const e of x.elements) {
    for (const b of e.boundElements) assert.ok(ids.has(b.id), `dangling boundElement ${b.id}`);
    if (e.containerId) assert.ok(ids.has(e.containerId));
    if (e.startBinding) assert.ok(ids.has(e.startBinding.elementId) && ids.has(e.endBinding.elementId));
  }
  assert.equal(x.elements.filter(e => e.type === 'arrow').length, 2);
});

test('pdf xref offsets point at their objects', async () => {
  const pdf = await pdfFromRgb(new Uint8Array(2 * 2 * 3).fill(255), 2, 2, 10, 10);
  const s = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
  assert.ok(s.startsWith('%PDF-1.4'));
  const xref = Number(s.match(/startxref\n(\d+)/)![1]);
  assert.ok(s.startsWith('xref', xref));
  const offs = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map(r => Number(r[1]));
  assert.equal(offs.length, 5);
  offs.forEach((o, i) => assert.ok(s.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
});

test('structurizr DSL import: kinds, styles, nesting, layout', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseDsl } = await import('./dsl.ts');
  const d = parseDsl(readFileSync(new URL('../examples/shop.dsl', import.meta.url), 'utf8'), m);
  const by = (name: string) => d.nodes.find(n => n.text.startsWith(name))!;
  assert.equal(d.nodes.length, 10);
  assert.equal(d.edges.length, 8);
  assert.equal(by('Customer').kind, 'person');
  assert.equal(by('Shop').kind, 'boundary');
  assert.equal(by('Shop').text.split('\n')[0], 'Shop [Software System]');
  assert.equal(by('Orders DB').kind, 'database');
  assert.equal(by('Order events').kind, 'queue');
  assert.equal(by('Storefront').kind, 'browser');
  assert.equal(by('Email provider').ext, true);
  assert.equal(by('API').text, 'API [Go]\nOrders, catalogue and checkout');
  assert.equal(d.edges.filter(e => e.dash === 1).length, 2); // "Async" relationship style
  // every container sits inside the Shop boundary, and siblings don't overlap
  const shop = by('Shop'), inner = d.nodes.filter(n => n.kind !== 'boundary' && n.kind !== 'person' && !n.ext);
  for (const n of inner) assert.ok(n.x >= shop.x && n.y >= shop.y && n.x + n.w <= shop.x + shop.w && n.y + n.h <= shop.y + shop.h, n.text);
  for (const a of d.nodes) for (const b of d.nodes)
    if (a !== b && a.kind !== 'boundary' && b.kind !== 'boundary')
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.text} overlaps ${b.text}`);
});

test('structurizr DSL tolerates the syntax we do not model', async () => {
  const { parseDsl } = await import('./dsl.ts');
  const d = parseDsl(`
    # comment
    workspace {
      !identifiers hierarchical
      model {
        u = person User
        s = softwareSystem "Sys" {
          a = container "A" {
            properties {
              "k" "v"
            }
            -> s.b "Uses"
          }
          b = container "B"
        }
        u -> s.a "Uses"
        u -> nowhere "Dangling"
        live = deploymentEnvironment "Live" {
          deploymentNode "Box" {
            containerInstance s.a
          }
        }
      }
    }`, m);
  assert.deepEqual(d.nodes.map(n => n.kind), ['person', 'boundary', 'container', 'container']);
  assert.equal(d.edges.length, 2);
});

test('structurizr DSL export round-trips kinds and relationships', async () => {
  const { parseDsl, toDsl } = await import('./dsl.ts');
  const d = sample();
  d.nodes[2].ext = true;
  d.nodes.push(makeNode('component', 2000, 2000, 'Orphan [Rust]')); // no container around it: gets wrapped
  const dsl = toDsl(d), back = parseDsl(dsl, m);
  const sig = (x: Doc) => x.nodes.filter(n => n.kind !== 'boundary').map(n => `${n.kind}:${n.text.split('\n')[0]}`).sort();
  assert.deepEqual(sig(back), sig(d));
  assert.equal(back.edges.length, 2);
  assert.ok(back.edges.some(e => e.dash === 1 && e.route === 'elbow'));
  assert.ok(back.nodes.find(n => n.text.startsWith('DB'))!.ext);
  assert.match(dsl, /diagram = softwareSystem "Diagram" \{[\s\S]*components = container "Components" \{\n\s+orphan = component "Orphan"/);
});
