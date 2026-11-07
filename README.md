<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg">
  <img src="brand/logo.svg" alt="fasdraw" width="340">
</picture>

**Architecture diagrams at the speed you think.**

Keyboard-first C4 diagramming with an Excalidraw-clean canvas: shapes, lines, colors and labels are
one keystroke away, the way switching from an IDE to Vim feels.

[![MIT license](https://img.shields.io/badge/license-MIT-6965db)](LICENSE)
![runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-2f9e44)
![bundle: 24 kB gzip](https://img.shields.io/badge/bundle-24%20kB%20gzip-438dd5)

**[Try it in your browser at fasdraw.osrcmap.dev](https://fasdraw.osrcmap.dev)**. Nothing to install.

<img src="docs/screenshot.png" alt="fasdraw showing a C4 container diagram of an online shop" width="100%">

</div>

## Why

Draw.io and Excalidraw are great, but getting an idea from your head onto the board still means
hunting through palettes and dragging handles. fasdraw is built around three ideas:

- **C4 conventions, not UML ceremony.** Person, system, container, component, database, queue,
  web app and boundary are first-class shapes with C4 colors and `[Container: tech]` captions.
- **Modal, keyboard-first editing.** Drop a shape at the cursor with one key, grow a connected node
  with `Tab`, flip a line to dashed with `-`. Every action is also clickable, and the UI shows the key.
- **Diagrams as code when you want it.** Paste [Structurizr DSL](https://docs.structurizr.com/dsl),
  the open C4 language, and get a laid-out diagram; export it back for your repo.

## Quick start

Open **[fasdraw.osrcmap.dev](https://fasdraw.osrcmap.dev)** to try it right away, or run it locally:

```sh
git clone https://github.com/osrcmap/fasdraw && cd fasdraw
npm install
npm run dev        # http://localhost:5173
```

```sh
npm test           # node's built-in test runner (Node ≥ 22.18)
npm run build      # static site in dist/ — host it anywhere
```

## Drawing from your head

Hover the canvas and type. Typing `p` *Customer* `Tab` *Web App [React]* `Tab` *API [Go]*
`Esc` gives you three connected boxes without touching the mouse.

| Keys | Action |
| --- | --- |
| `p` `s` `c` `m` `d` `q` `w` | person · system · container · component · database · queue · web app. Drops at the cursor, or **converts** the selection |
| `b` | boundary. With nodes selected, it wraps them |
| `r` `o` `t` | rectangle · ellipse · text |
| `H` `J` `K` `L` · `Tab` | grow a new connected node ← ↓ ↑ →. `Tab` repeats the last direction, even while typing |
| `h` `j` `k` `l` | jump to the nearest node in that direction |
| `1`–`9` · `0` | color · back to the C4 default |
| `-` · `e` · `a` | solid/dashed/dotted · straight/elbow/curved · arrowheads. The last style sticks for new lines |
| `f` | text alignment: left → center → right |
| `x` | mark as external (C4 gray) |
| `>` | connect the selected nodes in the order you picked them |
| `i` / `Enter` · `I` | edit label · label the incoming relationship |
| `Space` | command menu: open, save, export, align, distribute, theme (hold and drag to pan) |
| `?` | every shortcut |

**Labels have a tiny grammar.** `API [Go]` sets name and technology, `Shift+Enter` adds a
description line, and the C4 caption is rendered for you.

**With the mouse or a touch screen:** drag from the dots around a node to connect it (drop on empty
space to create the next node), drag either end of a selected line onto another node to reconnect it,
pinch to zoom and pan with two fingers.

<img src="docs/dark.png" alt="Dark mode with the Space command menu open" width="100%">

## Diagrams as code: Structurizr DSL

fasdraw reads and writes [Structurizr DSL](https://docs.structurizr.com/dsl) instead of
inventing a new format, so your models work with the rest of the C4 tooling.

```text
workspace {
    model {
        customer = person "Customer"
        shop = softwareSystem "Shop" {
            api = container "API" "Orders and checkout" "Go"
            db = container "Orders DB" "" "PostgreSQL" "Database"
        }
        customer -> api "Buys using" "HTTPS"
        api -> db "Reads and writes" "SQL"
    }
}
```

- **Import:** paste it on the canvas, drop a `.dsl` file, or `Space o`. Elements, nesting
  (systems → containers → components, groups), tags, `shape`/`background` styles,
  relationship `style`/`routing` and `autolayout` direction are understood. Models are laid out
  automatically.
- **Deployment:** deployment environments, deployment nodes, infrastructure nodes and container /
  system instances are drawn below the model. Instances inherit the relationships of what they deploy.
- **`!include`:** select or drop the workspace together with the files it includes, and they are
  stitched in by file name.
- **Export:** `Space e t` writes a valid workspace with views and C4 styles. Positions travel as
  workspace properties, so exporting and importing again keeps your layout. Elements you add in
  text afterwards are laid out under the existing drawing.

A complete example lives in [`examples/shop.dsl`](examples/shop.dsl). It is the diagram in the
screenshot above.

## Files

| Format | |
| --- | --- |
| `.fasdraw` | native, lossless JSON (`{ type, version, nodes, edges }`), diff-friendly. Open with `Ctrl+O`, drag-and-drop or paste. Work is also autosaved in the browser |
| `.dsl` | Structurizr DSL import and export |
| `.excalidraw` | export with native shapes, bound labels and bound arrows |
| SVG · PNG · PDF | export (`Space e s` / `p` / `d`). PDFs are vector, with selectable text |

## How it's built

No framework and no runtime dependencies. TypeScript draws straight to a `<canvas>`, with Vite to
build. One pure display list feeds the canvas, SVG, PDF and Excalidraw outputs, so exports match the
screen.

Rendering is built to stay fast as diagrams grow. Off-screen elements are skipped. Each node's and
line's display list and parsed paths are cached until that element changes, so panning and zooming
redraw without recomputing. When zoomed out, labels, arrowheads and dash patterns too small to see
are not drawn. A 1,500-node diagram pans at 60 fps with everything on screen.

| File | Role |
| --- | --- |
| [`src/model.ts`](src/model.ts) | document types, C4 conventions, geometry → display list (pure, no DOM) |
| [`src/io.ts`](src/io.ts) | canvas painter, SVG / PNG / PDF / Excalidraw writers, `.fasdraw` parser |
| [`src/dsl.ts`](src/dsl.ts) | Structurizr DSL parser, auto-layout, exporter |
| [`src/main.ts`](src/main.ts) | editor state, keymap, input, UI chrome |
| [`brand/`](brand) | logo SVGs and the script that generates them |

## Known limitations

- PDFs use the fonts every PDF reader has built in (Helvetica), so they look slightly different from
  the screen. Diagrams with text outside Western European scripts export as a high-resolution image PDF
  instead. Use SVG to keep the exact on-screen fonts.
- `!include` works with local files opened together. Includes by URL are not fetched.
- Deployment groups are ignored, so every instance in an environment is connected as its model is.

## Contributing

Issues and PRs are welcome. Keep the core dependency-free where a few lines will do, and run
`npm test && npm run build` before opening a PR.

## License

[MIT](LICENSE)
