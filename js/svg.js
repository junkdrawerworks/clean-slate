// A board as an SVG file: a picture that opens anywhere (Google Drive shows it), with the board itself tucked inside
// so Clean Slate can open it again and carry on drawing. The same file is the Drive copy and the "Download SVG".
import { BACKGROUNDS, SPACING, shade, shareable, cleanBoard } from './board.js';
import { outline, pathData, visibleBounds, marginFor, markerOp, shapeLines, bounds, groupRubs } from './ink.js';

const MARK = 'clean-slate-board';
// Text for the file. Anything XML can't hold at all comes out (XML 1.0 Fifth Edition, section 2.2, Characters: Char is
// tab, line feed, carriage return, U+0020 to U+D7FF, U+E000 to U+FFFD and U+10000 to U+10FFFF), since one such
// character, a control character in a name say, leaves a file nothing but Clean Slate will open.
const xml = s => String(s).replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON with nothing XML would read as markup, so it can sit in the file as plain text. (JSON.stringify already writes
// control characters and lone surrogates as escapes; U+FFFE and U+FFFF it doesn't.)
const safeJSON = o => JSON.stringify(o).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/[\ufffe\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);

// Each stroke's path data, kept by the stroke (as ink.js keeps its Path2D: a stroke never changes once made, and merges
// keep the same objects), so saving a big board to Drive traces only the lines new since the last save. Tracing every
// outline again took most of the 0.5 s a 1,000-line board's save held up the page.
const paths = new WeakMap(), texts = new WeakMap();
// And each stroke as it's written in the board tucked inside the file.
function textOf(s) {
  let t = texts.get(s);
  if (t === undefined) texts.set(s, t = safeJSON(s));
  return t;
}
// The board inside the file: JSON.stringify's own text, with the strokes written from what's kept for each. Each
// photo's picture is in the file once, as the picture of it (see toSVG): the board inside names it, '#' and its key.
function boardJSON(board) {
  const b = shareable(board);
  if (b.photos) b.photos = Object.fromEntries(Object.keys(b.photos).map(k => [k, '#' + k]));
  const rest = safeJSON({ cleanSlate: 1, board: { ...b, strokes: [] } });
  return rest.replace('"strokes":[]', () => `"strokes":[${board.strokes.map(textOf).join(',')}]`);
}
function pathOf(s) {
  let d = paths.get(s);
  if (d === undefined) {
    d = s.shape && s.tool !== 'rub'
      ? shapeLines(s).map((line, i) => line.map(([px, py], j) => `${j ? 'L' : 'M'}${Math.round(px * 10) / 10} ${Math.round(py * 10) / 10}`).join('') + (i === 0 && s.shape === 'closed' ? 'Z' : '')).join('')
      : pathData(outline(s));
    paths.set(s, d);
  }
  return d;
}

export function toSVG(board, opts = {}) {
  const c = visibleBounds(board.strokes) || { x0: 0, y0: 0, x1: 800, y1: 600 }, margin = opts.margin ?? marginFor(c);
  const x = Math.floor(c.x0 - margin), y = Math.floor(c.y0 - margin);
  const w = Math.ceil(c.x1 + margin) - x, h = Math.ceil(c.y1 + margin) - y;
  const look = BACKGROUNDS[board.bg] || BACKGROUNDS.white;
  const photos = board.strokes.filter(s => s.tool === 'photo' && board.photos?.[s.src]);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg"${photos.length ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : ''} viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`,
    `<title>${xml(board.name)}</title>`,
    `<metadata id="${MARK}">${boardJSON(board)}</metadata>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${look.bg}"/>`,
  ];
  if (board.pattern !== 'blank') {
    const S = SPACING;
    const lines = board.pattern === 'grid' ? `M0 0H${S}M0 0V${S}` : `M0 0H${S}`;
    const mark = board.pattern === 'dots'
      ? `<circle cx="0" cy="0" r="1.3" fill="${look.dot}"/><circle cx="${S}" cy="0" r="1.3" fill="${look.dot}"/><circle cx="0" cy="${S}" r="1.3" fill="${look.dot}"/><circle cx="${S}" cy="${S}" r="1.3" fill="${look.dot}"/>`
      : `<path d="${lines}" stroke="${look.line}" stroke-width="1" fill="none"/>`;
    out.push(`<defs><pattern id="p" width="${S}" height="${S}" patternUnits="userSpaceOnUse">${mark}</pattern></defs>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#p)"/>`);
  }
  // The photos, under the ink: each picture once, 1 by 1 at the origin, and each photo of it stretched into place. A
  // rub-out never clears one (see clears in board.js). (xlink:href, which every SVG viewer reads.)
  if (photos.length) {
    const keys = [...new Set(photos.map(s => s.src))];
    const placed = photos.map(s => {
      const [px, py, , qx, qy] = s.pts, f = n => Math.round(n * 10) / 10;
      return `<use xlink:href="#${s.src}" transform="matrix(${f(qx - px)} 0 0 ${f(qy - py)} ${f(px)} ${f(py)})"/>`;
    });
    out.push(`<defs>${keys.map(k => `<image id="${k}" width="1" height="1" preserveAspectRatio="none" xlink:href="${board.photos[k]}"/>`).join('')}</defs>`,
      `<g id="ph">${placed.join('')}</g>`);
  }
  // On a light board, a run of rub-outs is a mask over everything drawn before it, so the ink so far goes in a group
  // under the mask and later strokes go on top. The groups nest, the last mask outermost; they're written in one go at
  // the end, as each mask's opening tag, then each run of ink followed by the closing tag of the mask that covers it,
  // so the drawing is never copied again as rub-outs pile up. On the slate, as on screen (ink.js inkLayer), a run of
  // rub-outs paints the board back where it went, and a highlighter screens onto whatever is under it, board or ink.
  //
  // A rub-out in a group clears only its group's lines (see clears in board.js), so it's no part of a run: each line it
  // clears has a mask of its own, of the group's rub-outs after it.
  const dark = !!look.dark, op = markerOp(board.bg), defs = [], runs = [], own = groupRubs(board.strokes), cuts = new Map();
  let ink = [], rubs = [];
  const cutOf = s => {
    const later = own && s.grp ? own.get(s.grp)?.filter(u => u.t > s.t && meets(bounds(u), bounds(s)) && pathOf(u)) : null;
    if (!later?.length) return '';
    const key = later.map(u => u.id).join();
    if (!cuts.has(key)) cuts.set(key, `<mask id="c${cuts.size}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>${later.map(u => `<path d="${pathOf(u)}" fill="#000"/>`).join('')}</mask>`);
    return ` mask="url(#c${[...cuts.keys()].indexOf(key)})"`;
  };
  const closeRubs = () => {
    if (!rubs.length) return;
    const id = 'r' + defs.length, rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}"`;
    if (dark) {
      defs.push(id);
      const clip = `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${rubs.join('')}</clipPath>`;
      // (With photos, the board and the photos on it are painted back as one group, clipped once, so no hairline of
      // board shows round the edge where the photo goes on again. A group with no effect of its own is clipped child
      // by child, hairline and all, so it has an opacity a hair under 1, which makes it one picture first.)
      if (photos.length) ink.push(`${clip}<g clip-path="url(#${id})" opacity="0.999">${rect} fill="${look.bg}"/>${board.pattern !== 'blank' ? `${rect} fill="url(#p)"/>` : ''}<use xlink:href="#ph"/></g>`);
      else ink.push(`${clip}${rect} fill="${look.bg}" clip-path="url(#${id})"/>${board.pattern !== 'blank' ? `${rect} fill="url(#p)" clip-path="url(#${id})"/>` : ''}`);
    } else {
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">${rect} fill="#fff"/>${rubs.join('')}</mask>`);
      runs.push(ink.join(''));
      ink = [];
    }
    rubs = [];
  };
  for (const s of board.strokes) {
    if ((s.tool === 'rub' && s.grp) || s.tool === 'photo') continue;
    if (s.tool === 'rub') { const d = pathOf(s); if (d) rubs.push(dark ? `<path d="${d}"/>` : `<path d="${d}" fill="#000"/>`); continue; }
    closeRubs();
    const blend = s.tool === 'marker' ? ` style="mix-blend-mode:${op}"` : '';
    const color = shade(s, board.bg), cut = cutOf(s);
    if (s.shape) {
      const d = pathOf(s);
      ink.push(`<path d="${d}" fill="${s.fill ? color : 'none'}" stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"${cut}${blend}/>`);
    } else {
      const d = pathOf(s);
      if (d) ink.push(`<path d="${d}" fill="${color}"${cut}${blend}/>`);
    }
  }
  closeRubs();
  if (runs.length) out.push(`<defs>${defs.join('')}</defs>`);
  if (cuts.size) out.push(`<defs>${[...cuts.values()].join('')}</defs>`);
  const masked = runs.length ? [defs.map((_, i) => `<g mask="url(#r${defs.length - 1 - i})">`).join('') + runs.map(r => r + '</g>').join('')] : [];
  // On a light board all the ink multiplies into the board as one layer, as on screen (ink.js laydown). A masked group
  // is drawn on its own, so without this a highlighter under a rub-out's mask would lose its see-through look.
  const layer = !dark && (masked.length || ink.length);
  out.push(...(layer ? ['<g style="mix-blend-mode:multiply">'] : []), ...masked, ...ink, ...(layer ? ['</g>'] : []), '</svg>');
  return out.join('\n');
}

const meets = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

// The board inside a Clean Slate SVG (or a plain board file), or null if the text isn't one.
export function fromSVG(text) {
  const m = new RegExp(`<metadata id="${MARK}">([\\s\\S]*?)</metadata>`).exec(String(text));
  let o = null;
  try { o = JSON.parse(m ? m[1] : text); } catch { return null; }
  if (!o?.cleanSlate) return null;
  // (Each photo's picture, from the picture of it in the file.)
  const photos = o.board?.photos;
  if (m && photos && typeof photos === 'object') {
    for (const [k, v] of Object.entries(photos)) {
      if (v !== '#' + k || !/^p[\w-]{1,40}$/.test(k)) continue;
      photos[k] = new RegExp(`<image id="${k}"[^>]*? xlink:href="(data:[^"]*)"`).exec(text)?.[1];
    }
  }
  return cleanBoard(o.board);
}
