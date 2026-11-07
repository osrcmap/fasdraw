"""Builds every fasdraw brand SVG from one definition: the pencil-rocket mark (drawn upright on a
128 grid, launched at 45°) and the "fasdraw" wordmark outlined from Space Grotesk Bold.
Usage: see brand/README.md."""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font_path, repo = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '.'

LIGHT = dict(flame='#f08c00', flame2='#ffc94d', dark='#3d39a0', body='#6965db', hi='#8a87ee',
             wood='#efcf9b', wood2='#f8e4c2', tip='#1e1e24', text='#1e1e24')
DARK = dict(LIGHT, tip='#d9d8e6', text='#ececf1')

# Upright geometry on a 128 grid, centred on (64, 64); rotate(45) launches it to the upper right.
# Flame, fins + nozzle, painted body with scalloped sharpening edge, wood cone, graphite tip.
def mark(c, porthole=False):
    hole = (f'<circle fill="{c["dark"]}" cx="64" cy="58" r="6.5"/><circle fill="{c["wood"]}" cx="64" cy="58" r="4"/>'
            if porthole else '')
    return (f'<g transform="rotate(45 64 64)">'
            f'<path fill="{c["flame"]}" d="M54 97C55 108 59 114 64 120C69 114 73 108 74 97Z"/>'
            f'<path fill="{c["flame2"]}" d="M58.5 97C59.5 104 61.5 108.5 64 112C66.5 108.5 68.5 104 69.5 97Z"/>'
            f'<path fill="{c["dark"]}" d="M52 62L37 92H52ZM76 62L91 92H76ZM55 90H73L75 97H53Z"/>'
            f'<path fill="{c["wood"]}" d="M52 41L64 10L76 41Z"/>'
            f'<path fill="{c["wood2"]}" d="M64 10L76 41H64Z"/>'
            f'<path fill="{c["tip"]}" d="M64 10L59.4 22H68.6Z"/>'
            f'<path fill="{c["body"]}" d="M52 90V41Q56 35 60 41Q64 35 68 41Q72 35 76 41V90Z"/>'
            f'<path fill="{c["hi"]}" d="M68 90V41Q72 35 76 41V90Z"/>'
            f'<rect fill="{c["dark"]}" x="52" y="84" width="24" height="6"/>'
            f'{hole}</g>')

# Single-colour stencil: same silhouette, parts separated by gaps instead of colours.
MONO = ('<g transform="rotate(45 64 64)" fill="currentColor">'
        '<path d="M54 99C55 109 59 114.5 64 120C69 114.5 73 109 74 99Z"/>'
        '<path d="M50 64L36 92H50ZM78 64L92 92H78ZM55 92H73L75 97H53Z"/>'
        '<path d="M64 10L59.4 22H68.6Z"/>'
        '<path d="M58.2 25H69.8L75.6 40H52.4Z"/>'
        '<path d="M52 89V43Q56 37 60 43Q64 37 68 43Q72 37 76 43V89Z"/>'
        '</g>')

def wordmark(size, x, baseline, tracking=-0.02):
    f = TTFont(font_path)
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f['hmtx']
    scale = size / f['head'].unitsPerEm
    paths, pen_x = [], x
    for ch in 'fasdraw':
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
        gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, pen_x, baseline)))
        paths.append(pen.getCommands())
        pen_x += hmtx[name][0] * scale + tracking * size
    x_height = f['OS/2'].sxHeight * scale
    return ''.join(paths), pen_x - tracking * size, x_height

def svg(view, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

def write(path, text):
    with open(f'{repo}/{path}', 'w') as fh:
        fh.write(text)

# Visual bounds of the rotated mark: x 24..103, y 25..103 → crop boxes with a little air.
write('brand/mark.svg', svg('0 0 128 128', mark(LIGHT), 'fasdraw'))
write('brand/mark-mono.svg', svg('0 0 128 128', MONO, 'fasdraw'))
write('public/favicon.svg', svg('20 20 88 88', mark(LIGHT), 'fasdraw'))
write('brand/icon.svg', svg('0 0 128 128', '<rect width="128" height="128" rx="28" fill="#18171f"/>'
                         '<g transform="translate(64 64) scale(.86) translate(-64 -64)">' + mark(DARK) + '</g>', 'fasdraw'))

size = 64
_, _, xh = wordmark(size, 0, 0)
d, end, xh = wordmark(size, 116, 64 + xh / 2)  # x-height centred on the mark
for name, c in (('logo', LIGHT), ('logo-dark', DARK)):
    write(f'brand/{name}.svg', svg(f'20 20 {end - 20 + 6:.0f} 88', mark(c) + f'<path fill="{c["text"]}" d="{d}"/>', 'fasdraw'))

print('wrote brand/*.svg and public/favicon.svg')
