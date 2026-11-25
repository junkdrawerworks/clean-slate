// The lasso, with no page in sight (so test/unit.test.mjs can run it in Node): which lines a loop picks up, and the
// changes that moving, resizing, copying, recolouring or deleting them make to a board, each as one undo step.
//
// Strokes never change once made, so a line moved is taken away and put back as a new stroke where it went, as the
// eraser and undo do: it syncs and merges like any other line, and two devices agree whichever order the changes reach
// them in. The moved lines go on top, under a new group (see clears in board.js), and each rub-out that cleared any of
// them comes along as a copy in that group, so what was rubbed out of them stays rubbed out wherever they go, and
// nothing they land on is rubbed out. A rub-out left with nothing to clear where it was goes with them.
import { newId, nextTs, clears, INKS, MAX_SIZE } from './board.js';
import { bounds, visibleBounds, shows } from './ink.js';

const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const meets = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
const round = (v, k) => Math.round(v * k) / k;

// Is (x, y) inside the loop ([x, y, x, y, …] on the board, closed back to its start)?
export function inLoop(loop, x, y) {
  let inside = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    const xi = loop[i], yi = loop[i + 1], xj = loop[j], yj = loop[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The ids of the lines (and photos) a loop drawn round them picks up: those with at least half their points inside it
// (a photo's corners and middle), and some of them still showing (a line rubbed out completely isn't there to pick).
export function pick(board, loop) {
  if (loop.length < 6) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < loop.length; i += 2) { x0 = Math.min(x0, loop[i]); x1 = Math.max(x1, loop[i]); y0 = Math.min(y0, loop[i + 1]); y1 = Math.max(y1, loop[i + 1]); }
  const box = { x0, y0, x1, y1 }, rubs = board.strokes.filter(s => s.tool === 'rub');
  const out = [];
  for (const s of board.strokes) {
    if (s.tool === 'rub' || !meets(bounds(s), box)) continue;
    const p = s.pts, pts = [];
    if (s.tool === 'photo') pts.push(p[0], p[1], p[3], p[1], p[3], p[4], p[0], p[4], (p[0] + p[3]) / 2, (p[1] + p[4]) / 2);
    else for (let i = 0; i < p.length; i += 3) pts.push(p[i], p[i + 1]);
    let n = 0;
    for (let i = 0; i < pts.length; i += 2) if (inLoop(loop, pts[i], pts[i + 1])) n++;
    if (n * 2 >= pts.length / 2 && shows(s, rubs)) out.push(s.id);
  }
  return out;
}

// The photo a tap at (x, y) picks up, as a list of its id: the top one there (they go in the order they were put
// there), or none. A loop has to go round most of a photo, which is hard once it's bigger than the screen; a tap on it
// picks up just the photo, to move or resize again.
export function tapPick(board, x, y) {
  for (let i = board.strokes.length - 1; i >= 0; i--) {
    const s = board.strokes[i];
    if (s.tool !== 'photo') continue;
    const [x0, y0, , x1, y1] = s.pts;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return [s.id];
  }
  return [];
}

// The lines with these ids, in drawing order (never a rub-out: those come along with the lines they cleared).
const picked = (board, ids) => { const want = new Set(ids); return board.strokes.filter(s => want.has(s.id) && s.tool !== 'rub'); };

// What shows of them: the box the dashed line goes round.
export function pickedBounds(board, ids) {
  const list = picked(board, ids);
  return list.length ? visibleBounds([...list, ...board.strokes.filter(s => s.tool === 'rub')]) : null;
}

// The rub-outs that clear any of `list` and would have nothing left to clear where they are once `list` is gone.
function stranded(board, list, used) {
  const going = new Set(list.map(s => s.id));
  return used.filter(u => !board.strokes.some(s => s.tool !== 'rub' && !going.has(s.id) && clears(u, s) && meets(bounds(u), bounds(s))));
}

// Picking up lines and putting them down somewhere else, bigger or smaller: tf moves each point (x, y) to
// (ox + (x - ox) * k + dx, oy + (y - oy) * k + dy), and makes each line k times as wide. With copy, the lines stay where
// they were too (Duplicate). Returns the undo step ({ add, remove }) and the ids of the lines as they are now, or null
// when there's nothing to move.
export function placeStep(board, ids, { dx = 0, dy = 0, k = 1, ox = 0, oy = 0 } = {}, { copy = false } = {}) {
  const list = picked(board, ids);
  if (!list.length) return null;
  // One new group for each group the lines were in (or none), so a rub-out that cleared lines in one of them still
  // clears only those.
  const key = s => s.grp || '', groups = new Map();
  for (const s of list) if (!groups.has(key(s))) groups.set(key(s), newId('g'));
  const items = list.map(s => ({ s, g: groups.get(key(s)) })), used = new Set();
  for (const u of board.strokes) {
    if (u.tool !== 'rub') continue;
    for (const [k0, g] of groups) {
      if (!list.some(s => key(s) === k0 && clears(u, s) && meets(bounds(u), bounds(s)))) continue;
      items.push({ s: u, g });
      used.add(u);
    }
  }
  items.sort((a, b) => byTime(a.s, b.s) || (a.g < b.g ? -1 : 1));
  const t0 = nextTs(board, items.length);
  const add = items.map(({ s, g }, i) => {
    const pts = s.pts.slice();
    for (let j = 0; j < pts.length; j += 3) { pts[j] = round(ox + (pts[j] - ox) * k + dx, 10); pts[j + 1] = round(oy + (pts[j + 1] - oy) * k + dy, 10); }
    return { ...s, id: newId('s'), t: t0 + i, grp: g, pts, size: s.tool === 'photo' ? s.size : Math.max(0.1, Math.min(MAX_SIZE, round(s.size * k, 100))) };
  });
  const remove = copy ? [] : [...list, ...stranded(board, list, [...used])].sort(byTime);
  return { step: remove.length ? { add, remove } : { add }, ids: add.filter(s => s.tool !== 'rub').map(s => s.id) };
}

// The pen lines and shapes among them in another ink (highlighter lines and photos keep theirs). Each keeps its start
// time and group, so it stays where it was in the drawing and every rub-out that cleared it still does.
export function recolourStep(board, ids, color) {
  if (!INKS[color]) return null;
  const list = picked(board, ids).filter(s => s.tool === 'pen' && s.color !== color);
  if (!list.length) return null;
  const add = list.map(s => ({ ...s, id: newId('s'), color }));
  const swap = new Map(list.map((s, i) => [s.id, add[i].id]));
  return { step: { add, remove: list }, ids: ids.map(id => swap.get(id) || id) };
}

// Taking them away, with any rub-out that cleared only them.
export function deleteStep(board, ids) {
  const list = picked(board, ids);
  if (!list.length) return null;
  const used = board.strokes.filter(u => u.tool === 'rub' && list.some(s => clears(u, s) && meets(bounds(u), bounds(s))));
  return { step: { remove: [...list, ...stranded(board, list, used)].sort(byTime) } };
}

// Just them, as strokes to draw on their own (a picture of part of a board): copies where they are, with what was
// rubbed out of them.
export function pickedStrokes(board, ids) {
  return placeStep(board, ids, {}, { copy: true })?.step.add || [];
}
