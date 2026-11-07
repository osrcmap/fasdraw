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

test('structurizr DSL: hierarchical ids, unknown blocks, deployment', async () => {
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
  // model, then the Live environment > Box node > instance of A
  assert.deepEqual(d.nodes.map(n => n.kind), ['person', 'boundary', 'container', 'container', 'boundary', 'boundary', 'container']);
  assert.equal(d.edges.length, 2);
  assert.equal(d.nodes[4].text, 'Live [Deployment Environment]');
  assert.equal(d.nodes[6].text, 'A');
  assert.ok(d.nodes[4].y > Math.max(...d.nodes.slice(0, 4).map(n => n.y + n.h)), 'deployment sits below the model');
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
  assert.match(dsl, /diagram = softwareSystem "Diagram" "" "fasdraw:generated" \{[\s\S]*components = container "Components" "" "" "fasdraw:generated" \{\n\s+orphan = component "Orphan"/);
  assert.ok(!back.nodes.some(n => n.text.startsWith('Diagram')), 'generated wrappers are not drawn');
  // positions survive the round trip
  for (const n of d.nodes) {
    const b = back.nodes.find(x => x.text.split('\n')[0] === n.text.split('\n')[0])!;
    assert.deepEqual([b.x, b.y, b.w, b.h], [n.x, n.y, n.w, n.h], n.text);
  }
});

test('structurizr DSL: deployment instances inherit relationships, and round-trip', async () => {
  const { parseDsl, toDsl } = await import('./dsl.ts');
  const d = parseDsl(`workspace {
    model {
      s = softwareSystem "Shop" {
        api = container "API" "" "Go"
        db = container "DB" "" "PostgreSQL" "Database"
      }
      api -> db "Reads" "SQL"
      prod = deploymentEnvironment "Prod" {
        aws = deploymentNode "AWS" "" "Cloud" {
          ecs = deploymentNode "ECS" "" "Fargate" "" "3" {
            apiOnEcs = containerInstance api
          }
          rds = deploymentNode "RDS" {
            dbOnRds = containerInstance db
          }
          lb = infrastructureNode "Load balancer" "" "ALB"
        }
        lb -> apiOnEcs "Forwards to"
      }
    }
  }`, m);
  const by = (t: string) => d.nodes.find(n => n.text.startsWith(t))!;
  assert.equal(by('ECS ×3').text, 'ECS ×3 [Deployment Node: Fargate]');
  assert.equal(by('Load balancer').text, 'Load balancer [Infrastructure Node: ALB]');
  const dbs = d.nodes.filter(n => n.kind === 'database');
  assert.equal(dbs.length, 2, 'the instance looks like the database it deploys');
  assert.equal(d.edges.length, 3, 'model edge, its implied instance edge, and the explicit deployment edge');
  const back = parseDsl(toDsl(d), m);
  assert.deepEqual(back.nodes.map(n => `${n.kind}:${n.text.split('\n')[0]}`).sort(), d.nodes.map(n => `${n.kind}:${n.text.split('\n')[0]}`).sort());
  assert.equal(back.edges.length, 3);
});

test('structurizr DSL: !include resolves through the callback', async () => {
  const { parseDsl } = await import('./dsl.ts');
  const asked: string[] = [];
  const files: Record<string, string> = { 'people.dsl': 'u = person "User"\n!include missing.dsl', 'rels.dsl': 'u -> s "Uses"' };
  const d = parseDsl('workspace {\n model {\n  !include people.dsl\n  s = softwareSystem "Sys"\n  !include "rels.dsl"\n }\n}', m, p => { asked.push(p); return files[p]; });
  assert.deepEqual(asked, ['people.dsl', 'missing.dsl', 'rels.dsl']);
  assert.deepEqual(d.nodes.map(n => n.kind), ['person', 'system']);
  assert.equal(d.edges.length, 1);
});

test('vector PDF draws shapes and text, and declines glyphs the base fonts lack', async () => {
  const { vectorPdf } = await import('./io.ts');
  const d = sample();
  d.nodes[0].text = 'Señor (QA)';
  const pdf = await vectorPdf(d);
  assert.ok(pdf);
  const bytes = new Uint8Array(await pdf.arrayBuffer()), s = Array.from(bytes, c => String.fromCharCode(c)).join(''); // 1 char per byte
  const xref = Number(s.match(/startxref\n(\d+)/)![1]);
  [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].forEach((r, i) => assert.ok(s.startsWith(`${i + 1} 0 obj`, Number(r[1]))));
  const start = s.indexOf('stream\n', s.indexOf('4 0 obj')) + 7, len = Number(s.match(/4 0 obj\n<< \/Length (\d+)/)![1]);
  const raw = bytes.slice(start, start + len);
  const content = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).text();
  assert.match(content, /\(Se\\361or \\\(QA\\\)\) Tj/); // ñ in WinAnsi, parentheses escaped
  assert.match(content, / c /); // curves came through as cubic Béziers
  assert.ok(pdf.size < 8000, `vector PDF stays small (${pdf.size} B)`);
  d.nodes[0].text = '数据库';
  assert.equal(await vectorPdf(d), undefined);
});

test('text alignment moves the label anchor', async () => {
  const { nodePrims, LIGHT } = await import('./model.ts');
  const n = makeNode('container', 0, 0, 'API');
  const anchorX = () => nodePrims(n, LIGHT, m).flatMap(p => ('text' in p ? [[p.anchor, p.x]] : []))[0];
  assert.deepEqual(anchorX(), ['middle', n.x + n.w / 2]);
  n.align = 'right';
  assert.deepEqual(anchorX(), ['end', n.x + n.w - 12]);
  n.align = 'left';
  assert.deepEqual(anchorX(), ['start', n.x + 12]);
});
