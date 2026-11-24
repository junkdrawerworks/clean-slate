// A board and everything that changes it, with no page in sight (so test/unit.test.mjs can run it in Node).
//
// A board is a list of strokes. Each stroke has an id and the time it was started, and strokes are drawn in the
// order they were started. Taking a stroke away (the eraser, undo, Clear) leaves a marker under its id in `gone`, so
// when two copies of the same board meet (two tabs, or this device and Google Drive) they merge stroke by stroke:
// every stroke either side has, minus every stroke either side took away, and a line either side put back with undo
// kept once (see oneEach). The name, the colour and the lines each carry the time they were last set, and the later
// one wins.

export const BACKGROUNDS = {
  white: { name: 'White', bg: '#ffffff', line: 'rgba(40, 70, 130, 0.13)', dot: 'rgba(40, 60, 100, 0.30)', dark: false },
  paper: { name: 'Paper', bg: '#fbf5e4', line: 'rgba(130, 95, 40, 0.17)', dot: 'rgba(110, 80, 40, 0.32)', dark: false },
  slate: { name: 'Slate', bg: '#2a3236', line: 'rgba(255, 255, 255, 0.09)', dot: 'rgba(255, 255, 255, 0.22)', dark: true },
};
export const PATTERNS = { blank: 'Blank', grid: 'Grid', lines: 'Lines', dots: 'Dots' };
export const SPACING = 32; // world units between grid lines, ruled lines and dots

// Each colour has a shade for the light boards and one for the slate, so a drawing stays readable when the board
// changes colour. Strokes keep the colour's name, not its shade.
export const INKS = {
  ink: { name: 'Black', light: '#1d1d1f', dark: '#f3f2ec' },
  blue: { name: 'Blue', light: '#1f5ed6', dark: '#8db7ff' },
  red: { name: 'Red', light: '#d3302f', dark: '#ff8f85' },
  green: { name: 'Green', light: '#16804a', dark: '#7fdc9c' },
  orange: { name: 'Orange', light: '#df7400', dark: '#ffc164' },
  purple: { name: 'Purple', light: '#7a3cc4', dark: '#cca6ff' },
};
// Highlighters multiply on the light boards (so ink under them stays black) and screen on the slate (so chalk under
// them stays white).
export const MARKERS = {
  yellow: { name: 'Yellow', light: '#ffe838', dark: '#fff176' },
  green: { name: 'Green', light: '#a6f0a0', dark: '#8cf08a' },
  blue: { name: 'Blue', light: '#a5d8ff', dark: '#8fd0ff' },
  pink: { name: 'Pink', light: '#ffb0dc', dark: '#ff9fd6' },
  orange: { name: 'Orange', light: '#ffc98a', dark: '#ffb870' },
};
export const SIZES = { pen: [2, 4, 8], marker: [12, 20, 32], eraser: [14, 30, 64] };
// The largest size a stroke from outside is held to. Sizes are in board units, so the Large eraser (64) at the
// smallest zoom (10%) is 640.
export const MAX_SIZE = 1000;
// Stroke kinds: a pen line, a highlighter line, or a rub-out (an eraser line, which clears whatever was drawn before
// it where it passes), or a photo. A pen or highlighter line can also be a shape: `shape` is 'line', 'arrow', 'double' (an arrow
// with a head at each end) or 'closed' (a rectangle, ellipse or triangle, as its corners or as many points around it),
// and a closed one can be `fill`ed.
export const SHAPES = ['line', 'arrow', 'double', 'closed'];
// A photo (a worksheet, a floor plan, a screenshot) is a stroke too, so it undoes, syncs, moves and rubs out like one:
// tool 'photo', its points the top-left and bottom-right corners of where it goes ([x, y, 1, x, y, 1]), and `src` the
// key of its picture in the board's `photos` (key -> a data: URL, a JPEG or a PNG), kept once however many strokes show
// it. Photos go under all the ink, in the order they were put there; a rub-out drawn after one clears it too.
export const PHOTO_TYPES = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_PHOTO = 8 * 1024 * 1024; // the longest data: URL a board keeps (a photo is made far smaller than this)
// A picture's key: the same picture always gets the same one, so two devices that put in the same one agree.
export function photoKey(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `p${(h >>> 0).toString(36)}${data.length.toString(36)}`;
}
// The photos the strokes show (or that `also` names): what goes with a board into a file, or a copy of it.
export function photosFor(b, strokes = b.strokes, also = []) {
  if (!b.photos) return null;
  const out = {};
  for (const s of strokes) if (s.tool === 'photo' && b.photos[s.src]) out[s.src] = b.photos[s.src];
  for (const k of also) if (b.photos[k]) out[k] = b.photos[k];
  return Object.keys(out).length ? out : null;
}
// Lines picked up with the lasso and moved (or copied) go on top under a new `grp`, a group of their own, and take the
// rub-outs that cleared them along, as copies in that group. A rub-out in a group clears only the lines in it drawn
// before it, so it goes on clearing what it cleared before, wherever the group goes, and nothing it lands on. A rub-out
// with no group clears everything drawn before it, as it always has.
export const clears = (u, s) => u.tool === 'rub' && u.t > s.t && (!u.grp || u.grp === s.grp);

export const shade = (stroke, bg) => {
  if (stroke.tool === 'rub') return BACKGROUNDS[bg]?.bg || '#fff';
  const set = stroke.tool === 'marker' ? MARKERS : INKS;
  const c = set[stroke.color] || Object.values(set)[0];
  return BACKGROUNDS[bg]?.dark ? c.dark : c.light;
};

const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
export const newId = prefix => prefix + Date.now().toString(36) + rand();

let lastT = 0;
// Start times are unique on this device, so strokes started in the same millisecond keep their order.
export const stamp = () => (lastT = Math.max(Date.now(), lastT + 1));
// A new stroke's start time on a board: after every stroke already on it, so it goes on top of everything this device
// can see, even strokes from a device whose clock is ahead (a rub-out or a filled box from it would otherwise cover the
// new line). This device's own clock isn't moved on by the other device's.
export const nextT = b => Math.max(stamp(), (b?.strokes[b.strokes.length - 1]?.t || 0) + 1);
// n start times in a row for n new strokes on board b, all on top: the first of them (the rest follow it, one apart).
export function nextTs(b, n) {
  const t0 = nextT(b);
  lastT = Math.max(lastT, t0 + n - 1);
  return t0;
}
// The time to set a name, colour or lines at: after the one it replaces, so the change made here wins (see later()).
export const laterThan = at => Math.max(Date.now(), (at || 0) + 1);

export function makeBoard(name = 'Board', now = Date.now()) {
  return {
    id: newId('b'), name, nameAt: 0, bg: 'white', bgAt: 0, pattern: 'grid', patternAt: 0,
    created: now, changed: now, rev: 0, strokes: [], gone: {},
  };
}

// A stroke as it's kept: points flattened to [x, y, pressure, x, y, pressure, …], rounded so a board stays small.
export function makeStroke({ tool, color, size, pts, sim, shape, fill }, t = stamp()) {
  const flat = [];
  for (let i = 0; i < pts.length; i += 3) flat.push(round(pts[i], 10), round(pts[i + 1], 10), round(pts[i + 2], 100));
  const s = { id: newId('s'), t, tool, color: tool === 'rub' ? '' : color, size: round(size, 100), sim: sim ? 1 : 0, pts: flat };
  if (shape && tool !== 'rub') { s.shape = shape; if (fill && shape === 'closed') s.fill = 1; }
  return s;
}
const round = (v, k) => Math.round(v * k) / k;

const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The same stroke again under a new id, for undoing a removal: the old id stays taken away everywhere, and the copy
// keeps its start time, so it goes back to the same place in the drawing order.
export const again = s => ({ ...s, id: newId('s') });

// What a stroke draws, whatever its id. Two strokes that draw the same are copies of one stroke, each put back by undo
// (start times are never the same twice on one device, so nothing drawn twice by hand is the same).
export const drawing = s => `${s.t}|${s.tool}|${s.color}|${s.size}|${s.sim ? 1 : 0}|${s.shape || ''}|${s.fill ? 1 : 0}|${s.grp || ''}|${s.src || ''}|${s.pts.join(',')}`;
// The stroke on board b that draws the same as s under another id, or null.
export function twin(b, s) {
  let k = null;
  for (const x of b.strokes) if (x.t === s.t && x.id !== s.id && (k ??= drawing(s)) === drawing(x)) return x;
  return null;
}
// One stroke for each drawing. Two devices that each undo the same erase (or Clear) put the line back as two copies
// under two new ids, and merged both would stay, drawn twice: a highlighter twice as strong, and twice the data. The
// copy with the lower id is kept, so every device keeps the same one whichever way round they merge, and the other
// copy's id goes into `gone` (at its start time, which is the same on every device), so that once the kept one is
// erased, an older copy of the board that still has the other (a backup, a Drive file) can't bring the line back.
// (Only strokes started at the same moment can be copies, so only those are compared.)
function oneEach(strokes, gone) {
  const at = new Map();
  for (const s of strokes) at.set(s.t, (at.get(s.t) || 0) + 1);
  const out = [], kept = new Map();
  for (const s of strokes) {
    if (at.get(s.t) === 1) { out.push(s); continue; }
    const k = drawing(s), had = kept.get(k);
    if (!had) { kept.set(k, s); continue; }
    const [keep, drop] = s.id < had.id ? [s, had] : [had, s];
    kept.set(k, keep);
    gone[drop.id] = drop.t || 1;
  }
  return out.concat([...kept.values()]);
}

export function addStrokes(board, strokes) {
  const have = new Set(board.strokes.map(s => s.id));
  let late = false;
  for (const s of strokes) {
    if (have.has(s.id) || board.gone[s.id]) continue;
    if (board.strokes.length && byTime(s, board.strokes[board.strokes.length - 1]) < 0) late = true;
    board.strokes.push(s);
  }
  if (late) board.strokes.sort(byTime);
  return board;
}

export function removeStrokes(board, ids, now = Date.now()) {
  const out = new Set(ids);
  if (!out.size) return board;
  for (const id of out) board.gone[id] = now;
  board.strokes = board.strokes.filter(s => !out.has(s.id));
  return board;
}

// How much of the stroke as it was made a copy of it holds. (A copy from a version that didn't know groups has lost its
// group, and one from a version that didn't know photos has a photo as a plain pen line.)
const richness = s => (s.tool === 'rub' || s.shape || s.tool === 'photo' ? 2 : 0) + (s.grp ? 1 : 0);

// Which of two settings wins: the one set later; on a tie, the same one on every device.
function later(a, b, key) {
  const at = key + 'At';
  if ((a[at] || 0) !== (b[at] || 0)) return (a[at] || 0) > (b[at] || 0) ? a : b;
  return String(a[key]) >= String(b[key]) ? a : b;
}

// Both copies of one board, as one. Neither copy is changed. `rev` and `view` are this device's own and come from a.
export function mergeBoards(a, b) {
  const gone = { ...a.gone };
  for (const [id, t] of Object.entries(b.gone || {})) gone[id] = Math.max(gone[id] || 0, t);
  const seen = new Map();
  for (const s of [...a.strokes, ...b.strokes]) {
    if (gone[s.id]) continue;
    const had = seen.get(s.id);
    // The first version of Clean Slate didn't know rub-outs or shapes and kept them as plain pen lines, and versions
    // before the lasso dropped a stroke's group. If one of those copies comes back, the stroke as it was made wins.
    if (!had || richness(s) > richness(had)) seen.set(s.id, s);
  }
  const n = later(a, b, 'name'), g = later(a, b, 'bg'), p = later(a, b, 'pattern');
  // (Every copy of a photo is the same picture under the same key, so the two sets simply go together.)
  const photos = a.photos || b.photos ? { ...b.photos, ...a.photos } : null;
  return {
    ...a,
    ...(photos && { photos }),
    name: n.name, nameAt: n.nameAt || 0,
    bg: g.bg, bgAt: g.bgAt || 0,
    pattern: p.pattern, patternAt: p.patternAt || 0,
    created: Math.min(a.created || Infinity, b.created || Infinity),
    changed: Math.max(a.changed || 0, b.changed || 0),
    strokes: oneEach([...seen.values()], gone).sort(byTime),
    gone,
  };
}

// A short string that's the same for two copies with the same drawing, name and settings.
export function contentKey(b) {
  let h = 0x811c9dc5;
  const mix = str => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
  mix(`${b.name}|${b.nameAt}|${b.bg}|${b.bgAt}|${b.pattern}|${b.patternAt}|`);
  for (const s of b.strokes) mix(s.id + ',');
  mix('|');
  for (const id of Object.keys(b.gone).sort()) mix(id + ',');
  return `${b.strokes.length}.${Object.keys(b.gone).length}.${(h >>> 0).toString(36)}`;
}

// A board that has never been drawn on or set up: there's no point keeping a copy of it anywhere else.
export const untouched = b => !b.strokes.length && !Object.keys(b.gone).length && !b.nameAt && !b.bgAt && !b.patternAt;

// Whether board b holds nothing that another copy of it doesn't: every line on b, and every line taken away from it, is
// in the other copy (drawn there or taken away there), and b's name, colour and lines were set no later than its.
export function nothingBeyond(b, other) {
  const known = new Set([...other.strokes.map(s => s.id), ...Object.keys(other.gone)]);
  return b.strokes.every(s => known.has(s.id)) && Object.keys(b.gone).every(id => other.gone[id])
    && ['nameAt', 'bgAt', 'patternAt'].every(k => (b[k] || 0) <= (other[k] || 0));
}

// A board's name as it's kept: anything that isn't text (a control character pasted from a terminal, a PDF or a
// spreadsheet) made a space, trimmed, and at most n characters, cut between characters (never through an emoji). ''
// when nothing is left.
export const cleanName = (name, n = 80) => Array.from(String(name).replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, ' ').replace(/\p{Cs}/gu, '').trim()).slice(0, n).join('').trim();

// A board that came from outside this page (Drive, a backup file), checked and tidied, or null if it isn't one.
export function cleanBoard(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !/^[\w-]{1,64}$/.test(o.id)) return null;
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const strokes = [];
  for (const s of Array.isArray(o.strokes) ? o.strokes : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.pts) || !s.pts.length || s.pts.length % 3) continue;
    if (s.tool === 'photo') {
      const p = s.pts.map(v => num(v));
      if (p.length !== 6 || typeof s.src !== 'string' || !/^p[\w-]{1,40}$/.test(s.src) || !(p[3] > p[0]) || !(p[4] > p[1])) continue;
      const c = { id: s.id.slice(0, 64), t: num(s.t), tool: 'photo', color: '', size: 1, sim: 0, pts: [p[0], p[1], 1, p[3], p[4], 1], src: s.src };
      if (typeof s.grp === 'string' && /^[\w-]{1,64}$/.test(s.grp)) c.grp = s.grp;
      strokes.push(c);
      continue;
    }
    const tool = s.tool === 'marker' || s.tool === 'rub' ? s.tool : 'pen';
    const set = tool === 'marker' ? MARKERS : INKS;
    const pts = s.pts.map(v => num(v));
    const c = { id: s.id.slice(0, 64), t: num(s.t), tool, color: tool === 'rub' ? '' : set[s.color] ? s.color : Object.keys(set)[0], size: Math.max(0.1, Math.min(MAX_SIZE, num(s.size, 4))), sim: s.sim ? 1 : 0, pts };
    if (tool !== 'rub' && SHAPES.includes(s.shape)) { c.shape = s.shape; if (s.fill && s.shape === 'closed') c.fill = 1; }
    if (typeof s.grp === 'string' && /^[\w-]{1,64}$/.test(s.grp)) c.grp = s.grp;
    strokes.push(c);
  }
  const gone = {};
  if (o.gone && typeof o.gone === 'object') for (const [id, t] of Object.entries(o.gone)) gone[id.slice(0, 64)] = num(t, 1);
  const photos = {};
  if (o.photos && typeof o.photos === 'object') {
    for (const [k, v] of Object.entries(o.photos)) if (/^p[\w-]{1,40}$/.test(k) && typeof v === 'string' && v.length <= MAX_PHOTO && PHOTO_TYPES.test(v)) photos[k] = v;
  }
  return {
    ...(Object.keys(photos).length && { photos }),
    id: o.id,
    name: (typeof o.name === 'string' && cleanName(o.name)) || 'Board',
    nameAt: num(o.nameAt), bg: BACKGROUNDS[o.bg] ? o.bg : 'white', bgAt: num(o.bgAt),
    pattern: PATTERNS[o.pattern] ? o.pattern : 'grid', patternAt: num(o.patternAt),
    created: num(o.created, Date.now()), changed: num(o.changed, num(o.created, Date.now())),
    rev: 0, strokes: oneEach([...new Map(strokes.filter(s => !gone[s.id]).map(s => [s.id, s])).values()], gone).sort(byTime), gone,
  };
}

// A board from a file (a backup or an SVG) meeting this device's copy of it. When this copy has taken away strokes the
// file still has (Clear, the eraser, undo), a merge would leave them out, and the file would bring back nothing. So
// then the file's board comes in beside this one, as a board of its own: a new id, '(backup)' after its name, all of
// its strokes and nothing taken away. Otherwise the two merge as usual (asNew false: the caller merges `board`). A
// stroke taken away and then put back by undo is here as a copy under a new id (see again()), so it isn't missing.
export function importBoard(here, incoming, now = Date.now()) {
  const same = s => `${s.t}|${s.tool}|${s.pts.join(',')}`;
  const have = here && new Set(here.strokes.map(same));
  if (!here || !incoming.strokes.some(s => here.gone[s.id] && !have.has(same(s)))) return { board: incoming, asNew: false };
  return {
    board: { ...incoming, id: newId('b'), name: `${cleanName(incoming.name, 71)} (backup)`, nameAt: now, changed: now, gone: {} },
    asNew: true,
  };
}

// A copy of board b, as a board of its own, to draw on without changing b (a planner or a worksheet drawn once and copied
// each time): the same drawing, colour and lines under a new id, named "<name> copy", or "<name> copy 2" and on when
// that's taken among `boards`. Its strokes get new ids, keeping their start times so they draw in the same order, and
// nothing taken away from b comes with it, nor b's undo.
export function copyBoard(b, boards, now = Date.now()) {
  const used = new Set(boards.map(x => x.name)), first = `${cleanName(b.name, 70)} copy`;
  let name = first;
  for (let i = 2; used.has(name); i++) name = `${first} ${i}`;
  const photos = photosFor(b);
  return { ...makeBoard(name, now), nameAt: now, bg: b.bg, bgAt: b.bgAt || 0, pattern: b.pattern, patternAt: b.patternAt || 0, strokes: b.strokes.map(again), ...(photos && { photos }) };
}

// What goes into a file: the board without this device's own bits, and only the photos it shows.
export function shareable(b) {
  const photos = photosFor(b);
  return {
    id: b.id, name: b.name, nameAt: b.nameAt, bg: b.bg, bgAt: b.bgAt, pattern: b.pattern, patternAt: b.patternAt,
    created: b.created, changed: b.changed, strokes: b.strokes, gone: b.gone, ...(photos && { photos }),
  };
}

// The next "Board 3"-style name: one past the highest there is (so two "Board 1"s don't make the next "Board 3"), or
// with none, one past the number of boards (a new board beside "Kitchen plan" is "Board 2").
export function nextName(boards) {
  return freeName(new Set(boards.map(b => b.name)), boards.length);
}
function freeName(used, count) {
  const top = Math.max(0, ...[...used].map(n => +(/^Board (\d+)$/.exec(n)?.[1] || 0)));
  for (let i = top ? top + 1 : count + 1; ; i++) if (!used.has(`Board ${i}`)) return `Board ${i}`;
}

// Two devices each start a board, and each calls it "Board 1": when a sync brings one in beside another with the same
// name, neither named by the person (nameAt 0), the one made later (or, made at the same moment, the one with the
// greater id) takes the next free "Board N". Every device applies the same rule, so they agree. The name stays unset by
// the person (nameAt 0), so a name chosen on any device always wins over it. `brought`: the ids this sync brought in.
// Returns [id, new name] for each board to rename.
export function sameNames(boards, brought) {
  const used = new Set(boards.map(b => b.name)), groups = new Map(), out = [];
  for (const b of boards) if (!b.nameAt) (groups.get(b.name) || groups.set(b.name, []).get(b.name)).push(b);
  for (const g of groups.values()) {
    if (g.length < 2 || !g.some(b => brought.has(b.id))) continue;
    g.sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1));
    for (const b of g.slice(1)) {
      const name = freeName(used, used.size);
      used.add(name);
      out.push([b.id, name]);
    }
  }
  return out;
}
