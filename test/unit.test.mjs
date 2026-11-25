// The parts that don't need a page: boards merging, the SVG file, undo, and what the eraser touches.  node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoard, makeStroke, addStrokes, clears, nextTs, photoKey, photosFor, removeStrokes, mergeBoards, contentKey, cleanBoard, importBoard, untouched, nothingBeyond, again, twin, drawing, cleanName, nextName, sameNames, copyBoard, nextT, laterThan, shareable, shade, INKS, MARKERS, SIZES, MAX_SIZE, BACKGROUNDS, PATTERNS } from '../js/board.js';
import { toSVG, fromSVG } from '../js/svg.js';
import { makeHistory, STEPS, KEPT } from '../js/history.js';
import { touches, contentBounds, visibleBounds, frame, outline, pathData, weight, headLength, shapeLines, bounds, outlinesTraced, covered } from '../js/ink.js';
import { pick, placeStep, recolourStep, deleteStep, pickedBounds, pickedStrokes, inLoop, tapPick } from '../js/lasso.js';
import { recognize, dragShape } from '../js/shapes.js';
import { createHash } from 'node:crypto';

const stroke = (x, y, more = {}, t) => makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [x, y, 0.5, x + 10, y + 5, 0.6, x + 20, y, 0.5], ...more }, t);
const line = (x0, y0, x1, y1, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, 0.5]).flat();
const clone = b => JSON.parse(JSON.stringify(b));
const ids = b => b.strokes.map(s => s.id);

test('a new line goes on top of everything on its board, even one from a device whose clock is ahead', () => {
  const b = makeBoard('A');
  const ahead = stroke(0, 0);
  ahead.t = Date.now() + 120000; // a rub-out from a device two minutes ahead
  addStrokes(b, [ahead]);
  const mine = stroke(10, 10, {}, nextT(b));
  addStrokes(b, [mine]);
  assert.deepEqual(ids(b), [ahead.id, mine.id], 'the new line sorts last');
  const again2 = stroke(20, 20, {}, nextT(b));
  assert.ok(again2.t > mine.t, 'and the next one after it');
  // On a board with nothing ahead, it's the clock (and never the same time twice on this device).
  const t1 = nextT(makeBoard('B')), t2 = nextT(makeBoard('B'));
  assert.ok(t2 > t1 && Math.abs(t1 - Date.now()) < 1000);
  // A name, colour or lines set here always wins over the one it replaces, whatever the other device's clock said.
  const later = Date.now() + 60000; // (read once: the clock can tick between two readings)
  assert.equal(laterThan(later), later + 1);
  assert.ok(Math.abs(laterThan(0) - Date.now()) < 1000);
});

test('strokes keep the order they were started in', () => {
  const b = makeBoard('A');
  const s1 = stroke(0, 0), s2 = stroke(10, 10), s3 = stroke(20, 20);
  addStrokes(b, [s1, s3]);
  addStrokes(b, [s2]);
  assert.deepEqual(ids(b), [s1.id, s2.id, s3.id]);
  addStrokes(b, [s2]);
  assert.equal(b.strokes.length, 3, 'the same stroke twice is kept once');
});

test('a stroke taken away stays away, and its copy comes back in its old place', () => {
  const b = makeBoard('A');
  const s1 = stroke(0, 0), s2 = stroke(10, 10), s3 = stroke(20, 20);
  addStrokes(b, [s1, s2, s3]);
  removeStrokes(b, [s2.id]);
  assert.deepEqual(ids(b), [s1.id, s3.id]);
  addStrokes(b, [s2]);
  assert.deepEqual(ids(b), [s1.id, s3.id], 'a removed id is never added back');
  const copy = again(s2);
  addStrokes(b, [copy]);
  assert.deepEqual(ids(b), [s1.id, copy.id, s3.id]);
});

test('two copies merge stroke by stroke', () => {
  const base = makeBoard('Shared');
  const s1 = stroke(0, 0), s2 = stroke(50, 50);
  addStrokes(base, [s1, s2]);
  const a = clone(base), b = clone(base);
  const sa = stroke(100, 0), sb = stroke(0, 100);
  addStrokes(a, [sa]);
  addStrokes(b, [sb]);
  removeStrokes(b, [s1.id]);
  const m1 = mergeBoards(a, b), m2 = mergeBoards(b, a);
  assert.deepEqual(new Set(ids(m1)), new Set([s2.id, sa.id, sb.id]));
  assert.equal(contentKey(m1), contentKey(m2), 'merging is the same either way round');
  assert.equal(contentKey(mergeBoards(m1, a)), contentKey(m1), 'merging again changes nothing');
  assert.ok(m1.gone[s1.id]);
});

test('the later name, colour and lines win', () => {
  const a = makeBoard('Old'), b = clone(a);
  b.name = 'New'; b.nameAt = 2000;
  a.bg = 'slate'; a.bgAt = 3000;
  b.pattern = 'dots'; b.patternAt = 1000;
  const m = mergeBoards(a, b);
  assert.equal(m.name, 'New');
  assert.equal(m.bg, 'slate');
  assert.equal(m.pattern, 'dots');
  assert.equal(contentKey(m), contentKey(mergeBoards(b, a)));
});

test('a board from outside is checked', () => {
  assert.equal(cleanBoard(null), null);
  assert.equal(cleanBoard({ id: 'bad id with spaces' }), null);
  const c = cleanBoard({ id: 'b1', name: '  Notes  ', bg: 'neon', pattern: 'zigzag', strokes: [{ id: 's1', t: 1, tool: 'pen', color: 'mauve', size: 4, pts: [1, 2, 0.5] }, { id: 's2', pts: [1, 2] }, { id: 's3', t: 2, pts: [0, 0, 1] }], gone: { s3: 5 } });
  assert.equal(c.name, 'Notes');
  assert.equal(c.bg, 'white');
  assert.equal(c.pattern, 'grid');
  assert.deepEqual(c.strokes.map(s => s.id), ['s1'], 'broken and removed strokes are dropped');
  assert.equal(c.strokes[0].color, 'ink');
});

test('a board holds nothing beyond another copy only if every line, rub-out, erasure and setting is in it', () => {
  // The copy binned in Drive when another device deleted the board, and this device's copy of it.
  const file = makeBoard('Shed');
  const a = stroke(0, 0), b = stroke(10, 10), c = stroke(20, 20);
  addStrokes(file, [a, b, c]);
  removeStrokes(file, [c.id]);
  file.nameAt = 50;
  const here = () => ({ ...clone(file), strokes: clone(file).strokes.slice(0, 1) }); // a line behind, never a line ahead
  assert.equal(nothingBeyond(clone(file), file), true, 'the same copy');
  assert.equal(nothingBeyond(here(), file), true, 'a copy that lacks a line the file has');
  assert.equal(nothingBeyond({ ...here(), strokes: [...here().strokes, c] }, file), true, 'a line the file has taken away');
  const drawn = here();
  addStrokes(drawn, [stroke(30, 30)]);
  assert.equal(nothingBeyond(drawn, file), false, 'a line drawn since');
  const erased = clone(file);
  removeStrokes(erased, [a.id]);
  assert.equal(nothingBeyond(erased, file), false, 'a line taken away since');
  for (const k of ['nameAt', 'bgAt', 'patternAt']) assert.equal(nothingBeyond({ ...clone(file), [k]: (file[k] || 0) + 1 }, file), false, k + ' set since');
  assert.equal(nothingBeyond({ ...clone(file), nameAt: 10 }, file), true, 'a name set before the file’s');
});

test('a fresh board is untouched until something happens to it', () => {
  const b = makeBoard('Board 1');
  assert.ok(untouched(b));
  addStrokes(b, [stroke(0, 0)]);
  assert.ok(!untouched(b));
  assert.equal(nextName([b]), 'Board 2');
  assert.equal(nextName([makeBoard('Board 2')]), 'Board 3');
  assert.equal(nextName([makeBoard('Board 1'), makeBoard('Board 1')]), 'Board 2', 'one past the highest, not the count');
  assert.equal(nextName([makeBoard('Garden'), makeBoard('Board 4')]), 'Board 5');
  assert.equal(nextName([makeBoard('Kitchen plan')]), 'Board 2', 'with none numbered, by how many there are');
});

test('a copy of a board has its drawing, colour and lines under new ids, and a name of its own', () => {
  const b = makeBoard('Garden plan');
  Object.assign(b, { bg: 'slate', bgAt: 5, pattern: 'dots', patternAt: 6 });
  addStrokes(b, [stroke(0, 0), stroke(50, 0), stroke(100, 0)]);
  removeStrokes(b, [b.strokes[1].id]);
  b.undo = { undo: [{ add: [b.strokes[0]] }], redo: [] };
  const c = copyBoard(b, [b], 1000);
  assert.equal(c.name, 'Garden plan copy');
  assert.ok(c.nameAt > 0 && !untouched(c), 'named, so a sync never renames it');
  assert.deepEqual([c.bg, c.pattern], ['slate', 'dots']);
  assert.notEqual(c.id, b.id);
  assert.deepEqual(c.strokes.map(drawing), b.strokes.map(drawing), 'the same drawing, in the same order');
  assert.ok(c.strokes.every(s => !ids(b).includes(s.id)), 'under new ids');
  assert.deepEqual([c.gone, c.undo], [{}, undefined], 'with nothing taken away, and no undo');
  assert.equal(copyBoard(b, [b, c]).name, 'Garden plan copy 2');
  assert.equal(copyBoard(b, [b, c, { name: 'Garden plan copy 2' }]).name, 'Garden plan copy 3');
  assert.ok(copyBoard(makeBoard('x'.repeat(80)), []).name.length <= 80, 'and never longer than a name can be');
  assert.equal(b.strokes.length, 2, 'the board copied is left as it was');
});

test('boards made on two devices with the same name settle on different names, whichever device syncs first', () => {
  // Two devices and a Drive, each a map of boards by id. A sync brings in every board from Drive (merged), renames as
  // sameNames says, and puts every board here back in Drive (merged).
  const sync = (device, drive) => {
    const brought = new Set();
    for (const [id, b] of drive) {
      if (!device.has(id)) brought.add(id);
      device.set(id, device.has(id) ? mergeBoards(device.get(id), b) : clone(b));
    }
    for (const [id, name] of sameNames([...device.values()], brought)) device.get(id).name = name;
    for (const [id, b] of device) drive.set(id, drive.has(id) ? mergeBoards(drive.get(id), b) : clone(b));
  };
  const named = m => [...m.values()].map(b => b.name).sort();
  for (const order of [['A', 'B'], ['B', 'A']]) for (const sameTime of [false, true]) {
    const a = makeBoard('Board 1'), b = makeBoard('Board 1');
    addStrokes(a, [stroke(0, 0)]);
    addStrokes(b, [stroke(5, 5)]);
    a.created = 1000;
    b.created = sameTime ? 1000 : 2000;
    const devices = { A: new Map([[a.id, a]]), B: new Map([[b.id, b]]) }, drive = new Map();
    for (let i = 0; i < 3; i++) for (const d of order) sync(devices[d], drive);
    assert.deepEqual(named(devices.A), ['Board 1', 'Board 2'], `${order} ${sameTime}`);
    assert.deepEqual(named(devices.B), ['Board 1', 'Board 2']);
    assert.deepEqual([...devices.A.values()].map(x => [x.id, x.name]).sort(), [...devices.B.values()].map(x => [x.id, x.name]).sort(), 'the same board has the same name on both');
    assert.ok([...devices.A.values()].every(x => x.nameAt === 0), 'and neither counts as named by the person');
  }
  // A name the person chose isn't touched.
  const mine = { ...makeBoard('Board 1'), nameAt: 5, created: 3000 }, other = makeBoard('Board 1');
  other.created = 1;
  assert.deepEqual(sameNames([mine, other], new Set([other.id])), []);
});

test('the SVG file is a picture with the board inside', () => {
  const b = makeBoard('Fish & <chips>');
  b.pattern = 'lines'; b.patternAt = 5;
  addStrokes(b, [stroke(0, 0), stroke(40, 40, { tool: 'marker', color: 'yellow', size: 20 })]);
  const svg = toSVG(b);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="/);
  assert.match(svg, /<title>Fish &amp; &lt;chips&gt;<\/title>/);
  assert.equal((svg.match(/<path d="M[^"]*Q/g) || []).length, 2, 'one path per stroke');
  assert.match(svg, /mix-blend-mode:multiply/);
  assert.doesNotMatch(svg.split('<metadata')[1].split('</metadata>')[0], /[<&]/, 'nothing in the board reads as markup');
  const back = fromSVG(svg);
  assert.equal(back.name, 'Fish & <chips>');
  assert.equal(contentKey(back), contentKey(b));
  assert.deepEqual(back.strokes[1].pts, b.strokes[1].pts);
  assert.equal(fromSVG('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null, 'any other SVG is not a board');
  assert.equal(fromSVG(JSON.stringify({ cleanSlate: 1, board: shareable(b) })).id, b.id, 'a plain board file opens too');
});

// Anything outside XML 1.0's Char production (XML 1.0 Fifth Edition, section 2.2).
const notXML = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;

test('a name with a pasted control character is kept clean, and its SVG is still XML', () => {
  assert.equal(cleanName('  Plan\u0007 B\u0001 \ufffe '), 'Plan  B');
  assert.equal(cleanName('\u000b\u001b'), '', 'nothing left: the name there was stays');
  assert.equal(cleanBoard({ id: 'b1', name: 'Shed\u000bplan' }).name, 'Shed plan');
  assert.equal(cleanBoard({ id: 'b1', name: '\u0007' }).name, 'Board');
  // A board named so before names were cleaned (or by a page that doesn't clean them) still makes a file XML can read.
  const b = makeBoard('Plan\u0007 B\ufffe\ud83d');
  addStrokes(b, [stroke(0, 0)]);
  const svg = toSVG(b);
  assert.doesNotMatch(svg, notXML);
  assert.match(svg, /<title>Plan B<\/title>/);
  assert.equal(fromSVG(svg).name, 'Plan  B', 'and opens again with the name cleaned');
});

test('a long name is cut between characters, never through an emoji', () => {
  const fish = '🐟'.repeat(40); // 80 UTF-16 units, 40 characters
  const lone = /\p{Cs}/u;
  const here = makeBoard('x');
  addStrokes(here, [stroke(0, 0)]);
  const file = cleanBoard(shareable(clone(here)));
  removeStrokes(here, ids(here));
  const { board, asNew } = importBoard(here, { ...file, name: fish });
  assert.equal(asNew, true);
  assert.doesNotMatch(board.name, lone, 'the backup’s name has no half emoji');
  assert.equal(board.name, `${fish} (backup)`, 'and 40 fish are short enough to keep whole');
  const long = importBoard(here, { ...file, name: '🐟'.repeat(80) }).board.name;
  assert.equal(long, `${'🐟'.repeat(71)} (backup)`);
  assert.equal(cleanBoard({ id: 'b1', name: 'a' + '🐟'.repeat(90) }).name, 'a' + '🐟'.repeat(79));
  assert.doesNotMatch(cleanBoard({ id: 'b1', name: 'a' + fish }).name, lone);
  assert.equal(cleanName('🐟\ud83d (backup)'), '🐟 (backup)', 'a half emoji left by an older cut comes out');
});

test('a file opens beside a board that has taken away strokes since, and merges into one that hasn’t', () => {
  const here = makeBoard('Garden plan');
  addStrokes(here, [stroke(0, 0), stroke(10, 10), stroke(20, 20)]);
  const file = cleanBoard(shareable(clone(here)));
  // Unchanged here, or only drawn on since: the file merges in.
  assert.deepEqual(importBoard(clone(here), file), { board: file, asNew: false });
  const more = clone(here);
  addStrokes(more, [stroke(30, 30)]);
  assert.equal(importBoard(more, file).asNew, false);
  assert.equal(importBoard(null, file).asNew, false, 'a board that isn’t here comes in as it is');
  const undone = clone(here);
  removeStrokes(undone, ids(undone));
  addStrokes(undone, here.strokes.map(again));
  assert.equal(importBoard(undone, file).asNew, false, 'Clear and then undo leaves nothing missing');
  // Cleared after the backup was saved: a merge would bring back nothing, so the backup is a second board.
  const cleared = clone(here);
  removeStrokes(cleared, ids(cleared), 5000);
  assert.equal(mergeBoards(cleared, file).strokes.length, 0, 'a merge would bring nothing back');
  const { board, asNew } = importBoard(cleared, file, 9000);
  assert.equal(asNew, true);
  assert.notEqual(board.id, here.id);
  assert.equal(board.name, 'Garden plan (backup)');
  assert.equal(board.nameAt, 9000);
  assert.deepEqual(ids(board), ids(here), 'with every stroke the backup has');
  assert.deepEqual(board.gone, {});
  assert.equal(cleanBoard(board).name, 'Garden plan (backup)');
  // One line rubbed out with Whole lines is enough, and a long name still fits.
  const erased = clone(here);
  removeStrokes(erased, [here.strokes[1].id]);
  const long = { ...file, name: 'x'.repeat(80) };
  const two = importBoard(erased, long).board;
  assert.equal(two.name.length, 80);
  assert.ok(two.name.endsWith(' (backup)'));
});

test('the eraser touches a line it crosses, even on a quick swipe', () => {
  const s = makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [0, 0, 0.5, 100, 0, 0.5] });
  assert.ok(touches(s, 50, 5, 50, 5, 6), 'resting on it');
  assert.ok(!touches(s, 50, 40, 50, 40, 6), 'well clear of it');
  assert.ok(touches(s, 50, -80, 50, 80, 4), 'swiping across it between two events');
  const dot = makeStroke({ tool: 'pen', color: 'ink', size: 6, sim: 0, pts: [10, 10, 0.5] });
  assert.ok(touches(dot, 14, 10, 14, 10, 3), 'a single dot');
  assert.ok(outline(dot).length > 4, 'a dot still has an outline');
});

test('the eraser meets a pen line at the edge it’s drawn with: wider pressed firmly, narrower pressed lightly', () => {
  // A size-8 pen line drawn at 400% (2 board units), and the small eraser at 400% (radius 1.75).
  const r = SIZES.eraser[0] / 2 / 4;
  for (const [pressure, how] of [[1, 'firm'], [0.15, 'light']]) {
    const pts = []; for (let x = 0; x <= 100; x += 5) pts.push(x, 0, pressure);
    const s = makeStroke({ tool: 'pen', color: 'ink', size: 2, sim: 0, pts });
    const edge = Math.max(...outline(s).filter(([x]) => x > 40 && x < 60).map(([, y]) => y));
    assert.ok(touches(s, 50, edge + r - 0.25, 50, edge + r - 0.25, r), `${how}: a dab just over the drawn edge (${edge.toFixed(2)}) takes it`);
    assert.ok(!touches(s, 50, edge + r + 0.25, 50, edge + r + 0.25, r), `${how}: a dab just clear of the drawn edge leaves it`);
  }
});

test('the eraser passes over the part of a line a later rub-out has cleared', () => {
  const s = makeStroke({ tool: 'pen', color: 'ink', size: 2, sim: 0, pts: line(0, 0, 200, 0) }, 1);
  const rub = makeStroke({ tool: 'rub', size: 16, sim: 0, pts: line(100, 0, 220, 0) }, 2);
  assert.ok(!touches(s, 160, 0, 160, 0, 4, [rub]), 'a dab where it was rubbed out leaves it');
  assert.ok(!touches(s, 150, -30, 150, 30, 4, [rub]), 'and so does a swipe across there');
  assert.ok(touches(s, 50, 0, 50, 0, 4, [rub]), 'a dab on the part that shows takes it');
  assert.ok(touches(s, 160, 0, 60, 0, 4, [rub]), 'and so does a swipe along it from there onto that part');
  assert.ok(touches(s, 160, 0, 160, 0, 4), 'without the rub-out, the dab takes it');
  const before = makeStroke({ tool: 'rub', size: 16, sim: 0, pts: line(100, 0, 220, 0) }, 0);
  assert.ok(touches(s, 160, 0, 160, 0, 4, [before]), 'a rub-out from before the line doesn’t clear it');
  const box = makeStroke({ tool: 'pen', color: 'ink', size: 2, sim: 0, pts: [100, -5, 0.5, 140, -5, 0.5, 140, 5, 0.5, 100, 5, 0.5], shape: 'closed', fill: true }, 1);
  assert.ok(!touches(box, 120, 0, 120, 0, 3, [rub]), 'a filled box rubbed out where the eraser is');
  assert.ok(touches(box, 120, 0, 120, 0, 3, []), 'is there without the rub-out');
});

test('the drawing’s bounds include every stroke and its width', () => {
  const b = makeBoard('A');
  addStrokes(b, [stroke(0, 0), stroke(200, 100)]);
  const c = contentBounds(b.strokes);
  assert.ok(c.x0 < 0 && c.y0 < 0 && c.x1 > 220 && c.y1 > 100);
  assert.equal(contentBounds([]), null);
});

// ---------- shapes and rub-outs ----------
let seed = 5;
const wob = k => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * k; };
const traced = (corners, per = 20, k = 2.5) => {
  const out = [], all = [...corners, corners[0]];
  for (let i = 0; i < corners.length; i++) for (let j = 0; j < per; j++) { const [a, b] = [all[i], all[i + 1]], t = j / per; out.push([a[0] + (b[0] - a[0]) * t + wob(k), a[1] + (b[1] - a[1]) * t + wob(k)]); }
  out.push([corners[0][0] + 3, corners[0][1] + 1]);
  return out;
};
const round = (cx, cy, rx, ry) => Array.from({ length: 80 }, (_, i) => { const t = i / 79 * Math.PI * 2.07; return [cx + Math.cos(t) * rx + wob(3), cy + Math.sin(t) * ry + wob(3)]; });

test('a hand-drawn line, box, triangle or circle is recognised', () => {
  const ln = recognize(Array.from({ length: 30 }, (_, i) => [10 + i * 10 + wob(1), 100 + i * 0.3 + wob(2)]));
  assert.equal(ln.shape, 'line');
  assert.equal(ln.pts[0][1], ln.pts[1][1], 'a nearly level line is made level');
  const box = recognize(traced([[0, 0], [300, 0], [300, 160], [0, 160]]));
  assert.equal(box.shape, 'closed');
  assert.equal(box.pts.length, 4);
  assert.ok(Math.abs(box.pts[1][0] - box.pts[0][0] - 300) < 8 && Math.abs(box.pts[2][1] - box.pts[1][1] - 160) < 8, `the box is the size drawn: ${JSON.stringify(box.pts)}`);
  assert.equal(box.pts[0][1], box.pts[1][1], 'and square to the board');
  assert.equal(recognize(traced([[0, 200], [120, 0], [240, 200]], 25)).pts.length, 3, 'a triangle');
  const circle = recognize(round(200, 200, 100, 96));
  assert.equal(circle.pts.length, 72, 'a circle');
  const r = circle.pts.map(([x, y]) => Math.hypot(x - 200, y - 200));
  assert.ok(Math.max(...r) - Math.min(...r) < 0.5, 'nearly round is made round');
  assert.equal(recognize(round(200, 200, 160, 70)).pts.length, 72, 'an ellipse');
});

test('a short line snaps however much the pen trembles while it’s held still at the end', () => {
  for (const [len, n, k] of [[40, 120, 0.3], [80, 40, 1]]) {
    const xy = Array.from({ length: 20 }, (_, i) => [100 + len * i / 19 + wob(0.3), 100 + wob(0.3)]);
    for (let i = 0; i < n; i++) xy.push([100 + len + wob(k), 100 + wob(k)]);
    assert.equal(recognize(xy, 24)?.shape, 'line', `a ${len}-unit line held with ${n} points of tremor`);
  }
});

test('a pentagon, a hexagon and a speech bubble are left as drawn, not made circles or ellipses', () => {
  const poly = n => Array.from({ length: n }, (_, i) => [200 + Math.cos(i * 2 * Math.PI / n) * 120, 200 + Math.sin(i * 2 * Math.PI / n) * 120]);
  assert.equal(recognize(traced(poly(5))), null, 'a pentagon');
  assert.equal(recognize(traced(poly(6), 20, 0)), null, 'a hexagon');
  const bubble = Array.from({ length: 60 }, (_, i) => { const t = 2 + i / 59 * 5.6; return [300 + Math.cos(t) * 150 + wob(1), 200 + Math.sin(t) * 100 + wob(1)]; });
  bubble.push([180, 340], [300 + Math.cos(2) * 150, 200 + Math.sin(2) * 100]);
  assert.equal(recognize(bubble), null, 'a speech bubble');
});

test('a thin box round a word snaps to a box', () => {
  for (const [w, hh] of [[300, 50], [300, 36], [400, 45]]) {
    const box = recognize(traced([[0, 0], [w, 0], [w, hh], [0, hh]], 20, 1.5));
    assert.equal(box?.pts.length, 4, `a ${w} x ${hh} box snaps`);
    assert.ok(Math.abs(box.pts[1][0] - box.pts[0][0] - w) < 8 && Math.abs(box.pts[2][1] - box.pts[1][1] - hh) < 6, `to the size drawn: ${JSON.stringify(box.pts)}`);
    assert.equal(box.pts[0][1], box.pts[1][1], 'square to the board');
  }
});

test('a skinny loop, like a written l or k, is left as drawn, not made a triangle or a four-sided shape', () => {
  assert.equal(recognize(traced([[0, 0], [20, -150], [40, 0]], 20, 1)), null, 'a tall thin loop');
  assert.equal(recognize(traced([[0, 0], [60, -10], [30, -200], [10, -10]], 20, 1)), null, 'a skinny four-cornered loop');
});

test('scribbles, curves and tiny marks are left as drawn', () => {
  assert.equal(recognize(Array.from({ length: 30 }, (_, i) => [10 + i * 10, 100 + Math.sin(i / 5) * 40])), null, 'a curve');
  assert.equal(recognize(Array.from({ length: 60 }, (_, i) => [Math.sin(i * 1.7) * 80 + i * 3, Math.cos(i * 2.3) * 60])), null, 'a scribble');
  assert.equal(recognize(round(10, 10, 3, 3)), null, 'a tiny loop');
});

test('a shape snapped from a pen line is as heavy as the line was drawn, pressed firmly or lightly', () => {
  const area = poly => Math.abs(poly.reduce((sum, [x, y], i) => { const [x1, y1] = poly[(i + 1) % poly.length]; return sum + x * y1 - x1 * y; }, 0)) / 2;
  for (const pressure of [0.9, 0.5, 0.2]) {
    const pts = []; for (let x = 0; x <= 400; x += 4) pts.push(x, 0, pressure);
    const s = makeStroke({ tool: 'pen', color: 'ink', size: 8, sim: 0, pts });
    const drawn = area(outline(s)) / 400; // its average width
    assert.ok(Math.abs(weight(s) / drawn - 1) < 0.15, `pressure ${pressure}: the shape's width ${weight(s).toFixed(2)} against the line's ${drawn.toFixed(2)}`);
  }
  const finger = makeStroke({ tool: 'pen', color: 'ink', size: 8, sim: 1, pts: line(0, 0, 400, 0) });
  assert.equal(weight(finger), 8, 'a finger’s line keeps its size');
  assert.equal(weight(makeStroke({ tool: 'marker', color: 'yellow', size: 20, sim: 0, pts: line(0, 0, 400, 0) })), 20, 'and so does a highlighter’s');
});

test('the shapes tool makes exact shapes', () => {
  assert.deepEqual(dragShape('rect', 10, 20, 110, 70).pts, [[10, 20], [110, 20], [110, 70], [10, 70]]);
  assert.equal(dragShape('ellipse', 0, 0, 100, 50).pts.length, 72);
  const arrow = dragShape('arrow', 0, 0, 100, 4);
  assert.equal(arrow.shape, 'arrow');
  assert.deepEqual(arrow.pts[1], [100.1, 0], 'nearly level is level');
});

test('the shapes tool makes a box or an ellipse within about 8% of square square or round, and Shift always', () => {
  assert.deepEqual(dragShape('rect', 10, 20, 110, 113).pts, [[10, 20], [110, 20], [110, 120], [10, 120]], '7% off: square');
  assert.deepEqual(dragShape('rect', 10, 20, 110, 110).pts, [[10, 20], [110, 20], [110, 110], [10, 110]], '10% off: as dragged');
  assert.deepEqual(dragShape('rect', 0, 0, -94, -100).pts, [[0, 0], [-100, 0], [-100, -100], [0, -100]], 'dragged up and to the left, from the corner it started at');
  const radii = e => { const xs = e.pts.map(p => p[0]), ys = e.pts.map(p => p[1]); return [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2]; };
  const [rx, ry] = radii(dragShape('ellipse', 0, 0, 100, 93));
  assert.ok(Math.abs(rx - 50) < 0.2 && Math.abs(ry - 50) < 0.2, `nearly round is round: ${rx}, ${ry}`);
  assert.ok(Math.abs(radii(dragShape('ellipse', 0, 0, 100, 80))[1] - 40) < 0.2, '20% off stays an ellipse');
  assert.deepEqual(dragShape('rect', 0, 0, 100, 40, true).pts, [[0, 0], [100, 0], [100, 100], [0, 100]], 'Shift makes it square however far off');
  const [sx, sy] = radii(dragShape('ellipse', 0, 0, 30, 100, true));
  assert.ok(Math.abs(sx - 50) < 0.2 && Math.abs(sy - 50) < 0.2, `and round: ${sx}, ${sy}`);
  assert.deepEqual(dragShape('line', 0, 0, 100, 40, true).pts, [[0, 0], [100, 40]], 'a line is left as it is');
});

test('an arrow’s head is the same on screen at whatever zoom it was drawn, and never more than 0.4 of the shaft', () => {
  const head = s => { const [, [h0, tip]] = shapeLines(s); return Math.hypot(tip[0] - h0[0], tip[1] - h0[1]); };
  for (const z of [0.25, 1, 4]) {
    // A 300 px arrow with the 4 px pen, dragged out at zoom z, in board units.
    const s = makeStroke({ tool: 'pen', color: 'ink', size: 4 / z, sim: 0, pts: [0, 0, 0.5, 300 / z, 0, 0.5], shape: 'arrow' });
    assert.ok(Math.abs(head(s) * z - 20) < 0.01, `at ${z * 100}%: a ${head(s) * z} px head`);
    assert.ok(bounds(s).y1 >= Math.sin(0.45) * head(s), 'and the bounds hold it');
    const short = makeStroke({ tool: 'pen', color: 'ink', size: 8 / z, sim: 0, pts: [0, 0, 0.5, 40 / z, 0, 0.5], shape: 'arrow' });
    assert.ok(headLength(short) <= 0.4 * 40 / z + 1e-9, `a short arrow’s head is shorter than its shaft at ${z * 100}%`);
  }
});

test('a double arrow has a head at each end, the same size, and keeps them through an SVG, a backup and the eraser', () => {
  const d = dragShape('double', 0, 0, 200, 5);
  assert.equal(d.shape, 'double');
  assert.deepEqual(d.pts[1], [200.1, 0], 'nearly level is level');
  const s = makeStroke({ tool: 'pen', color: 'red', size: 3, sim: 0, pts: [0, 0, 0.5, 200, 0, 0.5], shape: 'double' });
  const lines = shapeLines(s);
  assert.equal(lines.length, 3, 'the shaft and two heads');
  const [, end, start] = lines;
  assert.deepEqual(end[1], [200, 0], 'one head at the end');
  assert.deepEqual(start[1], [0, 0], 'and one at the start');
  const len = h => Math.hypot(h[1][0] - h[0][0], h[1][1] - h[0][1]);
  assert.ok(Math.abs(len(start) - len(end)) < 1e-9 && Math.abs(len(start) - headLength(s)) < 1e-9, 'the same size');
  assert.ok(start[0][0] > 0 && end[0][0] < 200, 'each pointing outwards');
  const box = bounds(s);
  assert.ok(box.y0 <= -Math.sin(0.45) * len(start) && box.y1 >= Math.sin(0.45) * len(start), 'the bounds hold both heads');
  assert.equal(touches(s, 10, 6, 10, 6, 1, []), true, 'the eraser finds the head at the start');
  const b = makeBoard('Bed');
  addStrokes(b, [s]);
  const svg = toSVG(b);
  assert.match(svg, /<path d="M0 0L200 0M[^"]+M[^"]+" fill="none" stroke="#d3302f"/, 'two heads in the SVG');
  assert.equal(fromSVG(svg).strokes[0].shape, 'double', 'and back out');
  assert.equal(cleanBoard(JSON.parse(JSON.stringify(b))).strokes[0].shape, 'double', 'and through a backup or Drive');
  assert.equal(contentKey(fromSVG(svg)), contentKey(b));
});

test('rub-outs and shapes go into the SVG and come back out', () => {
  const b = makeBoard('Blob');
  const fat = stroke(0, 0, { size: 40 });
  const rub = makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [10, 4, 0.5, 12, 5, 0.5] });
  const box = makeStroke({ tool: 'pen', color: 'blue', size: 3, sim: 0, pts: [0, 50, 0.5, 80, 50, 0.5, 80, 90, 0.5, 0, 90, 0.5], shape: 'closed', fill: true });
  const arrow = makeStroke({ tool: 'pen', color: 'red', size: 3, sim: 0, pts: [100, 0, 0.5, 200, 0, 0.5], shape: 'arrow' });
  addStrokes(b, [fat, rub, box, arrow]);
  assert.equal(rub.color, '');
  const svg = toSVG(b);
  assert.match(svg, /<mask id="r0"/, 'a rub-out is a mask');
  assert.match(svg, /<g mask="url\(#r0\)"><path d="M[^"]*Q[^"]*" fill="#1d1d1f"\/><\/g>/, 'over what was drawn before it, and nothing after');
  assert.match(svg, /fill="#1f5ed6" stroke="#1f5ed6" stroke-width="3"/, 'a filled box');
  assert.match(svg, /<path d="M100 0L200 0M[^"]+" fill="none" stroke="#d3302f"/, 'an arrow with its head');
  const back = fromSVG(svg);
  assert.equal(back.strokes[1].tool, 'rub');
  assert.equal(back.strokes[2].shape, 'closed');
  assert.equal(back.strokes[2].fill, 1);
  assert.equal(back.strokes[3].shape, 'arrow');
  assert.equal(contentKey(back), contentKey(b));
});

test('a Large rub-out made at the smallest zoom keeps its size through an SVG, a backup and storage', () => {
  const size = Math.max(...SIZES.eraser) / 0.1;
  assert.equal(size, 640);
  assert.ok(MAX_SIZE >= size);
  const b = makeBoard('Zoomed out');
  addStrokes(b, [stroke(0, 0, { tool: 'marker', color: 'yellow', size: 320 }), makeStroke({ tool: 'rub', size, sim: 0, pts: [0, 0, 0.5, 900, 300, 0.5] })]);
  assert.equal(fromSVG(toSVG(b)).strokes[1].size, 640, 'through an SVG');
  assert.equal(cleanBoard(JSON.parse(JSON.stringify(shareable(b)))).strokes[1].size, 640, 'through a backup or storage');
  assert.equal(cleanBoard({ ...shareable(b), strokes: [{ ...b.strokes[1], size: 1e6 }] }).strokes[0].size, MAX_SIZE, 'and a silly size is still held in');
});

test('runs of rub-outs nest as masks, the last outermost, each over all the ink before it', () => {
  const b = makeBoard('Masks');
  const rub = x => makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [x, 0, 0.5, x + 5, 5, 0.5] });
  const a = stroke(0, 0), r0 = rub(5), b1 = stroke(30, 0), r1 = rub(35), r1b = rub(40), c = stroke(60, 0), r2 = rub(65), d = stroke(90, 0);
  addStrokes(b, [a, r0, b1, r1, r1b, c, r2, d]);
  const ink = s => `<path d="${pathData(outline(s))}" fill="${shade(s, 'white')}"/>`;
  const svg = toSVG(b);
  assert.equal((svg.match(/<mask /g) || []).length, 3, 'one mask per run of rub-outs');
  assert.ok(svg.endsWith(`\n<g mask="url(#r2)"><g mask="url(#r1)"><g mask="url(#r0)">${ink(a)}</g>${ink(b1)}</g>${ink(c)}</g>\n${ink(d)}\n</g>\n</svg>`), svg.slice(svg.lastIndexOf('</defs>')));
});

test('on the slate a highlighter screens onto whatever is under it, and a run of rub-outs paints the board back', () => {
  const b = makeBoard('Slate');
  b.bg = 'slate';
  const rub = x => makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [x, 0, 0.5, x + 5, 5, 0.5] });
  const a = stroke(0, 0), r0 = rub(5), r0b = rub(8), m = stroke(0, 0, { tool: 'marker', color: 'yellow', size: 20 });
  addStrokes(b, [a, r0, r0b, m]);
  const svg = toSVG(b), d = s => pathData(outline(s)), rect = /<rect (x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*") fill="#2a3236"\/>/.exec(svg)[1];
  assert.doesNotMatch(svg, /<mask|opacity=/, 'no masks, and no see-through highlighter');
  assert.ok(svg.endsWith(`\n<path d="${d(a)}" fill="${shade(a, 'slate')}"/>\n<clipPath id="r0" clipPathUnits="userSpaceOnUse"><path d="${d(r0)}"/><path d="${d(r0b)}"/></clipPath><rect ${rect} fill="#2a3236" clip-path="url(#r0)"/><rect ${rect} fill="url(#p)" clip-path="url(#r0)"/>\n<path d="${d(m)}" fill="${shade(m, 'slate')}" style="mix-blend-mode:screen"/>\n</svg>`), svg.slice(svg.indexOf('</defs>')));
  b.pattern = 'blank';
  assert.doesNotMatch(toSVG(b), /url\(#p\)/, 'a blank board paints back just its colour');
  assert.equal(contentKey(fromSVG(svg)), contentKey({ ...b, pattern: 'grid' }), 'and the board inside reads back the same');
});

test('on a light board all the ink multiplies into the board as one layer, so a highlighter stays see-through after a rub-out', () => {
  const b = makeBoard('Layer');
  b.bg = 'paper';
  addStrokes(b, [stroke(0, 0, { tool: 'marker', color: 'blue', size: 20 })]);
  addStrokes(b, [makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [5, 0, 0.5, 8, 2, 0.5] })]);
  addStrokes(b, [stroke(0, 30)]);
  const svg = toSVG(b);
  assert.match(svg, /<\/defs>\n<g style="mix-blend-mode:multiply">\n<g mask="url\(#r0\)"><path [^>]*style="mix-blend-mode:multiply"\/><\/g>\n<path [^>]*fill="#1d1d1f"\/>\n<\/g>\n<\/svg>$/, 'the mask group and what comes after it, in one multiplying layer');
  assert.equal(contentKey(fromSVG(svg)), contentKey(b));
  b.bg = 'slate';
  assert.doesNotMatch(toSVG(b), /<g style=/, 'the slate has no multiplying layer');
  assert.doesNotMatch(toSVG({ ...makeBoard('Empty'), bg: 'paper' }), /<g style=/, 'and an empty board has no layer');
});

test('a board with many rub-outs takes no longer to write as an SVG than one without', () => {
  const big = (n, rubs) => {
    const b = makeBoard('Big');
    b.bg = 'slate';
    addStrokes(b, Array.from({ length: n }, (_, j) => makeStroke({ tool: rubs && j % 10 === 9 ? 'rub' : 'pen', color: 'ink', size: 4, sim: 0, pts: Array.from({ length: 12 }, (_, q) => [j % 100 * 10 + q * 3, Math.floor(j / 100) * 10 + q, 0.5]).flat() })));
    return b;
  };
  // (Each time on a copy as new objects: toSVG keeps each stroke's path, and this is about writing them.)
  const time = b => { const c = cleanBoard(clone(b)); const t = performance.now(); toSVG(c); return performance.now() - t; };
  const plain = big(3000, false), rubbed = big(3000, true);
  time(plain); time(rubbed);
  const tp = Math.min(time(plain), time(plain)), tr = Math.min(time(rubbed), time(rubbed));
  // (Copying the drawing again for each run of rub-outs took four times as long here, and 9 s for 10,000 strokes.)
  assert.ok(tr < tp * 2, `with a rub-out every tenth stroke: ${Math.round(tr)} ms; without: ${Math.round(tp)} ms`);
  // Writing 10,000 strokes with a rub-out every tenth, their paths kept from a first SVG so only the writing is timed:
  // about 180 ms here, and 3.9 s when each run of rub-outs copied the drawing again. The limit leaves room for a busy
  // machine without letting that back in.
  const huge = big(10000, true);
  toSVG(huge);
  const tw = Math.min(...[0, 1, 2].map(() => { const t = performance.now(); toSVG(huge); return performance.now() - t; }));
  assert.ok(tw < 1500, `writing 10,000 strokes with rub-outs took ${Math.round(tw)} ms`);
});

test('a second SVG of an unchanged big board traces nothing again, and comes out the same', () => {
  // 1,000 handwriting-sized lines (30 points each), with rub-outs and shapes among them.
  const big = makeBoard('Big');
  const wobble = (x0, y0) => Array.from({ length: 30 }, (_, i) => [x0 + i * 3, y0 + Math.sin(i / 3) * 6, 0.3 + (i % 7) / 10]).flat();
  const all = [];
  for (let i = 0; i < 1000; i++) {
    const x = (i % 25) * 100, y = Math.floor(i / 25) * 30;
    all.push(i % 97 === 5 ? stroke(x, y, { tool: 'rub', size: 30, pts: wobble(x, y) }) : i % 89 === 7 ? stroke(x, y, { shape: 'closed', pts: [x, y, 0.5, x + 60, y, 0.5, x + 60, y + 20, 0.5, x, y + 20, 0.5] }) : stroke(x, y, { pts: wobble(x, y) }));
  }
  addStrokes(big, all);
  const fresh = () => cleanBoard(clone(big)); // the same board as new objects, so nothing is kept for it yet
  // (Counted, not timed: ink.js counts each outline it traces.)
  const tracing = b => { const n = outlinesTraced.n; const out = toSVG(b); return [outlinesTraced.n - n, out]; };
  const [took, first] = tracing(big);
  assert.ok(took >= all.length, `the first SVG traces every line: ${took} for ${all.length}`);
  const [again, second] = tracing(big);
  assert.equal(again, 0, 'the second traces none');
  assert.equal(second, first, 'the same file');
  const [afresh, copy] = tracing(fresh());
  assert.equal(afresh, took, 'a copy as new objects is traced afresh');
  assert.equal(copy, first, 'and the same as one traced afresh');
  addStrokes(big, [stroke(0, 1000, { pts: wobble(0, 1000) })]);
  assert.equal(tracing(big)[0], 1, 'one line drawn since: only it is traced');
});

test('a rub-out or a shape that came back as a plain line from the first version stays what it was', () => {
  const b = makeBoard('A');
  const rub = makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [1, 1, 0.5] });
  const box = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts: [0, 0, 0.5, 9, 0, 0.5, 9, 9, 0.5], shape: 'closed' });
  addStrokes(b, [rub, box]);
  const old = clone(b);
  old.strokes = old.strokes.map(s => { const { shape, ...rest } = s; return { ...rest, tool: 'pen', color: 'ink' }; });
  for (const m of [mergeBoards(b, old), mergeBoards(old, b)]) {
    assert.equal(m.strokes[0].tool, 'rub');
    assert.equal(m.strokes[1].shape, 'closed');
  }
});

test('lines rubbed out completely don’t make the picture of a board any bigger', () => {
  const b = makeBoard('Leftovers');
  const pen = (pts, more = {}) => makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts, ...more }, nextT(b));
  const rub = pts => makeStroke({ tool: 'rub', size: 64, sim: 0, pts }, nextT(b));
  addStrokes(b, [pen(line(0, 0, 1200, 0)), pen(line(0, 600, 1200, 600)), pen([0, 300, 0.5, 300, 300, 0.5], { shape: 'line' })]);
  addStrokes(b, [rub(line(-20, 0, 1220, 0, 60)), rub(line(-20, 600, 1220, 600, 60)), rub(line(-20, 300, 320, 300, 20))]);
  addStrokes(b, [pen(line(400, 800, 600, 820))]); // "Call Sam at 3"
  const c = visibleBounds(b.strokes);
  assert.ok(c.x0 > 390 && c.x1 < 610 && c.y0 > 790 && c.y1 < 830, `only the note: ${JSON.stringify(c)}`);
  const [vx, vy, vw, vh] = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(toSVG(b)).slice(1).map(Number);
  assert.ok(vx > 350 && vy > 750 && vx + vw < 650 && vy + vh < 870, `and the SVG frames just the note: ${[vx, vy, vw, vh]}`);
  addStrokes(b, [pen(line(0, 1000, 600, 1000))]);
  addStrokes(b, [rub(line(300, 1000, 620, 1000, 30))]);
  assert.ok(visibleBounds(b.strokes).y1 > 1000 && visibleBounds(b.strokes).x0 < 0, 'a line rubbed out partly counts whole');
  assert.deepEqual(contentBounds([rub(line(0, 0, 10, 0))]), null);
});

test('a picture of something small is big enough to read, with a margin to suit it', () => {
  // A signature drawn at 400%: about 160 x 60 board units.
  const sig = frame({ x0: 0, y0: 0, x1: 160, y1: 60 });
  assert.ok(Math.round(sig.w * sig.k) >= 1400 && sig.k === 8, `at eight pixels a unit it comes out ${Math.round(sig.w * sig.k)} px wide`);
  assert.ok(sig.x === -12 && sig.y === -12, 'with a margin less than its height');
  const plan = frame({ x0: 0, y0: 0, x1: 1000, y1: 700 });
  assert.equal(plan.k, 2, 'a drawing the size of a screen or bigger is as before');
  assert.equal(plan.x, -40);
  const huge = frame({ x0: 0, y0: 0, x1: 5000, y1: 9000 });
  assert.ok(huge.h * huge.k <= 4096 + 1e-6, 'and nothing is ever more than 4096 px on a side');
  const svg = toSVG(Object.assign(makeBoard('Sig'), { strokes: [makeStroke({ tool: 'pen', color: 'ink', size: 2, sim: 0, pts: line(0, 0, 160, 60) })] }));
  assert.match(svg, /viewBox="-1[3-5] -1[3-5] /, 'the SVG has the same margin');
});

test('the eraser touches a filled shape anywhere inside it, and an outline only on its edge', () => {
  const pts = [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5, 0, 100, 0.5];
  const filled = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts, shape: 'closed', fill: true });
  const outlined = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts, shape: 'closed' });
  assert.ok(touches(filled, 50, 50, 50, 50, 4));
  assert.ok(!touches(outlined, 50, 50, 50, 50, 4));
  assert.ok(touches(outlined, 2, 50, 2, 50, 4), 'the side closing it back to the start counts');
});

// ---------- undo and redo ----------
// What a person sees on the board: every stroke, in order, but not the ids (undoing a removal puts back a copy).
const look = b => JSON.stringify(b.strokes.map(({ id, ...rest }) => rest));
let k = 0;
const next = () => { k++; return stroke(k * 30, k * 7); };
// A board with its history, the way js/app.js keeps them, and a record of what the board looked like after each action
// still remembered, to check every undo and redo against.
function session() {
  const board = makeBoard('U');
  const h = makeHistory({ add: s => addStrokes(board, s), remove: ids => removeStrokes(board, ids) });
  const snaps = [look(board)];
  let pos = 0;
  const did = step => {
    h.remember(step);
    snaps.length = pos + 1;
    snaps.push(look(board));
    pos++;
    if (snaps.length > STEPS + 1) { snaps.shift(); pos--; }
  };
  return {
    board, h,
    draw() { const s = next(); addStrokes(board, [s]); did({ add: [s] }); return true; },
    erase(pick = list => list.slice(-1)) { const gone = pick(board.strokes); if (!gone.length) return false; removeStrokes(board, gone.map(s => s.id)); did({ remove: gone }); return true; },
    clear() { const gone = [...board.strokes]; if (!gone.length) return false; removeStrokes(board, gone.map(s => s.id)); did({ remove: gone }); return true; },
    undo() { if (!h.undo()) return false; pos--; return true; },
    redo() { if (!h.redo()) return false; pos++; return true; },
    want: () => snaps[pos],
    can: () => [pos > 0, pos < snaps.length - 1],
    oldest: () => snaps[0],
  };
}

test('every short run of drawing, erasing, Clear, undo and redo puts back exactly what was there', () => {
  const OPS = ['draw', 'erase', 'clear', 'undo', 'redo'];
  let runs = 0;
  for (let n = 1; n <= 5; n++) {
    for (let c = 0; c < OPS.length ** n; c++) {
      const s = session(), done = [];
      for (let j = 0, x = c; j < n; j++, x = Math.floor(x / OPS.length)) {
        const op = OPS[x % OPS.length];
        if (!s[op]()) continue;
        done.push(op);
        assert.equal(look(s.board), s.want(), `after ${done.join(' > ')}`);
        assert.deepEqual([s.h.canUndo(), s.h.canRedo()], s.can(), `Undo and Redo after ${done.join(' > ')}`);
      }
      runs++;
    }
  }
  assert.equal(runs, 3905);
  // The two that went wrong: the line came back, and the second undo left it there with Undo greyed out.
  for (const op of ['erase', 'clear']) {
    const s = session();
    s.draw(); s[op](); s.undo(); s.undo();
    assert.equal(s.board.strokes.length, 0, `draw > ${op} > undo > undo`);
    assert.equal(s.h.canUndo(), false);
    s.redo(); s.redo();
    assert.equal(s.board.strokes.length, 0, 'redo twice takes it away again, with no second copy');
    s.undo();
    assert.equal(s.board.strokes.length, 1);
  }
});

// A seeded random number, so a failure comes back the same every time.
const prng = n => () => { n = (n * 16807) % 2147483647; return n / 2147483647; };

test('long random sessions of undo and redo always land on what was there', () => {
  const rnd = prng(11);
  for (let i = 0; i < 200; i++) {
    const s = session(), done = [];
    const steps = 5 + Math.floor(rnd() * 76);
    for (let j = 0; j < steps; j++) {
      const r = rnd();
      const op = r < 0.4 ? 'draw' : r < 0.55 ? 'erase' : r < 0.6 ? 'clear' : r < 0.82 ? 'undo' : 'redo';
      const ok = op === 'erase' ? s.erase(list => list.filter(() => rnd() < 0.3)) : s[op]();
      if (!ok) continue;
      done.push(op);
      assert.equal(look(s.board), s.want(), `session ${i}: ${done.join(' > ')}`);
    }
    // Undo all the way back, then redo all the way forward.
    while (s.undo()) assert.equal(look(s.board), s.want(), `session ${i}, undoing all of it`);
    assert.equal(look(s.board), s.oldest());
    while (s.redo()) assert.equal(look(s.board), s.want(), `session ${i}, redoing all of it`);
  }
});

test('undo goes back 300 steps and stops at the oldest one remembered', () => {
  const s = session();
  for (let i = 0; i < 340; i++) {
    if (i % 7 === 3) s.erase(); else if (i % 50 === 49) s.clear(); else s.draw();
    if (i % 11 === 5) { s.undo(); s.redo(); }
  }
  let n = 0;
  while (s.undo()) n++;
  assert.equal(n, STEPS);
  assert.equal(look(s.board), s.oldest(), 'the oldest remembered state, exactly');
  assert.equal(s.h.canUndo(), false);
  assert.equal(s.h.canRedo(), true);
});

test('the last 50 undo and redo steps carry on after a reload, as they’re kept with the board', () => {
  const s = session();
  for (let i = 0; i < 70; i++) { if (i % 9 === 4) s.erase(); else if (i === 40) s.clear(); else s.draw(); }
  s.undo(); s.undo(); s.undo();
  // Kept with the board on the device (IndexedDB copies it, as JSON does here), then read back after a reload.
  const kept = clone(s.h.saved()), board = clone(s.board);
  assert.equal(kept.undo.length, KEPT);
  assert.equal(kept.redo.length, 3);
  const h = makeHistory({ add: x => addStrokes(board, x), remove: x => removeStrokes(board, x) }, kept);
  assert.deepEqual([h.canUndo(), h.canRedo()], [true, true]);
  for (let i = 0; i < 3; i++) { assert.equal(h.redo(), true); s.redo(); assert.equal(look(board), look(s.board), `redo ${i + 1} after the reload`); }
  assert.equal(h.canRedo(), false);
  let n = 0;
  while (h.undo()) { n++; s.undo(); assert.equal(look(board), look(s.board), `undo ${n} after the reload`); }
  assert.equal(n, KEPT + 3, 'and Undo goes back over the three redone and the 50 kept, then stops');
  // Anything kept that isn't a step of strokes is left out.
  const odd = makeHistory({ add() {}, remove() {} }, { undo: [null, 3, { add: [{ id: 'x' }] }, { remove: 'no' }], redo: 'no' });
  assert.deepEqual([odd.canUndo(), odd.canRedo()], [false, false]);
});

test('undo passes over a line another device already erased, so every press does something', () => {
  const board = makeBoard('U');
  const on = ids => ids.some(id => board.strokes.some(s => s.id === id));
  const h = makeHistory({ add: s => addStrokes(board, s), remove: ids => removeStrokes(board, ids), has: on });
  const s1 = next(), s2 = next();
  addStrokes(board, [s1]); h.remember({ add: [s1] });
  addStrokes(board, [s2]); h.remember({ add: [s2] });
  // A merge from another device takes s2 away (it was erased there).
  removeStrokes(board, [s2.id]);
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), true);
  assert.equal(board.strokes.length, 0, 'the first Undo takes away the line still on the board');
  assert.equal(h.canUndo(), false, 'and there is nothing left to undo');
  assert.equal(h.undo(), false);
  // Redo is as it was: it puts back this device's own lines, newest undone first.
  h.redo();
  assert.deepEqual(board.strokes.map(s => s.t), [s1.t]);
  h.redo();
  assert.deepEqual(board.strokes.map(s => s.t), [s1.t, s2.t]);
  // A step whose line is gone, and nothing else to undo: Undo is greyed out and does nothing.
  const b2 = makeBoard('V');
  const h2 = makeHistory({ add: s => addStrokes(b2, s), remove: ids => removeStrokes(b2, ids), has: ids => ids.some(id => b2.strokes.some(s => s.id === id)) });
  const s3 = next();
  addStrokes(b2, [s3]); h2.remember({ add: [s3] });
  removeStrokes(b2, [s3.id]);
  assert.equal(h2.canUndo(), false);
  assert.equal(h2.undo(), false);
});

// ---------- undo on two devices ----------
// One device's copy of a board and its undo, changed the way js/app.js changes them, and a sync between two of them as
// Drive does it (each takes the other's copy and merges it in).
function device(start) {
  const d = { board: clone(start) };
  d.h = makeHistory({
    add: s => addStrokes(d.board, s),
    remove: ids => removeStrokes(d.board, ids),
    has: ids => ids.some(id => d.board.strokes.some(s => s.id === id)),
    find: s => twin(d.board, s),
  });
  const did = step => d.h.remember(step);
  d.draw = (s = next()) => { s.t = nextT(d.board); addStrokes(d.board, [s]); did({ add: [s] }); return true; };
  d.erase = (pick = list => list.slice(-1)) => { const gone = pick(d.board.strokes); if (!gone.length) return false; removeStrokes(d.board, gone.map(s => s.id)); did({ remove: gone }); return true; };
  d.clear = () => d.erase(list => [...list]);
  d.undo = () => d.h.undo();
  d.redo = () => d.h.redo();
  return d;
}
const sync = (a, b) => { const x = a.board, y = b.board; a.board = mergeBoards(x, y); b.board = mergeBoards(y, x); };

test('a line erased on two devices and put back by Undo on both is on the board once', () => {
  // Both devices start with one line. The phone erases it and undoes (the line is back as a copy); the tablet, not yet
  // synced, erases the original; after a sync the tablet presses Undo.
  const start = makeBoard('D');
  addStrokes(start, [next()]);
  const tab = device(start), phone = device(start);
  phone.erase(); phone.undo(); tab.erase();
  sync(tab, phone);
  tab.undo();
  assert.equal(tab.board.strokes.length, 1, 'the tablet’s Undo doesn’t put the line back beside the phone’s');
  sync(tab, phone);
  assert.equal(phone.board.strokes.length, 1, 'nor does the next sync on the phone');
  assert.equal(look(tab.board), look(start));
  assert.equal(look(phone.board), look(start));
});

test('the same drawing put back on two devices is kept once, and once erased no older copy of the board brings it back', () => {
  // Clear and Undo on each device before they sync: each has the whole drawing back under ids of its own.
  const start = makeBoard('D');
  addStrokes(start, [next(), next(), next()]);
  const tab = device(start), phone = device(start);
  tab.clear(); tab.undo(); phone.clear(); phone.undo();
  const tabBefore = clone(tab.board), phoneBefore = clone(phone.board);
  sync(tab, phone);
  for (const d of [tab, phone]) assert.equal(look(d.board), look(start), 'each line once, on both devices');
  assert.deepEqual(ids(tab.board), ids(phone.board), 'the same copies kept on both');
  assert.equal(look(mergeBoards(tabBefore, phoneBefore)), look(mergeBoards(phoneBefore, tabBefore)), 'whichever way round');
  // The tablet's Redo clears it again, taking the copies the merge kept, whichever device made them.
  assert.equal(tab.redo(), true);
  assert.equal(tab.board.strokes.length, 0);
  // A backup or Drive file from before the sync still has the other device's copies: they stay away.
  for (const old of [phoneBefore, tabBefore]) {
    assert.equal(mergeBoards(tab.board, old).strokes.length, 0, 'an older copy of the board doesn’t bring the drawing back');
    assert.equal(mergeBoards(old, tab.board).strokes.length, 0);
  }
  sync(tab, phone);
  assert.equal(phone.board.strokes.length, 0);
  assert.deepEqual([phone.h.canUndo(), phone.h.canRedo()], [false, false], 'the phone’s Clear has nothing left to redo');
  assert.equal(phone.redo(), false);
  assert.equal(phone.board.strokes.length, 0);
});

test('Redo after another device erased the line is greyed out, and the next Undo doesn’t bring that line back', () => {
  // Both devices start with one line. The tablet erases it and undoes (the line is back as a copy); after a sync the
  // phone erases the copy, and after another sync the tablet's Redo would take away a line that's already gone.
  const start = makeBoard('R');
  addStrokes(start, [next()]);
  const tab = device(start), phone = device(start);
  tab.erase(); tab.undo(); sync(tab, phone);
  phone.erase(); sync(tab, phone);
  assert.equal(tab.board.strokes.length, 0);
  assert.equal(tab.h.canRedo(), false, 'Redo is greyed out');
  assert.equal(tab.redo(), false, 'and does nothing');
  tab.undo();
  assert.equal(tab.board.strokes.length, 0, 'Undo doesn’t bring back the line the phone erased');
  // With a step of its own under it, Redo passes over the one with nothing to do and redoes that.
  const t2 = device(start), p2 = device(start);
  t2.erase(); t2.draw(); t2.undo(); t2.undo();
  sync(t2, p2); p2.erase(list => list.slice(0, 1)); sync(t2, p2);
  assert.equal(t2.board.strokes.length, 0);
  assert.equal(t2.h.canRedo(), true);
  assert.equal(t2.redo(), true);
  assert.equal(t2.board.strokes.length, 1, 'the line drawn comes back');
  assert.equal(t2.h.canRedo(), false, 'and the erase of the line the phone took is dropped, not done');
});

// ---------- random boards: merging and files ----------
// A random board as a person might make one, from a seeded random number. (Sizes as drawn at any zoom from 10% up, so
// up to the Large eraser at 10%.)
function randomBoards(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const NAMES = ['Board', 'Garden plan', 'Fish & <chips>', 'Ünïcødé 🐟', '"quoted" \'single\'', 'a]]>b', '</metadata>', 'x'.repeat(80), 'tab\there', 'é', 'pasted\u000bfrom a PDF'];
  const anyStroke = () => {
    const tool = pick(['pen', 'pen', 'pen', 'marker', 'rub']);
    let x = rnd() * 2000 - 1000, y = rnd() * 2000 - 1000;
    const pts = [];
    for (let i = int(1, 40); i--;) { x += rnd() * 40 - 20; y += rnd() * 40 - 20; pts.push(x, y, 0.05 + rnd() * 0.95); }
    const o = { tool, color: pick(Object.keys(tool === 'marker' ? MARKERS : INKS)), size: pick(SIZES[tool === 'rub' ? 'eraser' : tool]) / pick([0.1, 0.5, 1, 3]), sim: rnd() < 0.5, pts };
    if (tool !== 'rub' && rnd() < 0.3) {
      const d = dragShape(pick(['rect', 'ellipse', 'line', 'arrow']), x, y, x + rnd() * 300 - 150, y + rnd() * 300 - 150);
      Object.assign(o, { pts: d.pts.flatMap(([a, b]) => [a, b, 0.5]), shape: d.shape, fill: rnd() < 0.5 });
    }
    return makeStroke(o);
  };
  const board = () => {
    const b = makeBoard(pick(NAMES), 1700000000000 + int(0, 1e6));
    if (rnd() < 0.5) { b.bg = pick(Object.keys(BACKGROUNDS)); b.bgAt = int(1, 1e6); }
    if (rnd() < 0.5) { b.pattern = pick(Object.keys(PATTERNS)); b.patternAt = int(1, 1e6); }
    if (rnd() < 0.5) b.nameAt = int(1, 1e6);
    addStrokes(b, Array.from({ length: int(0, 30) }, anyStroke));
    if (b.strokes.length && rnd() < 0.5) removeStrokes(b, b.strokes.filter(() => rnd() < 0.2).map(s => s.id), int(1, 1e9));
    return b;
  };
  // One device's change to its copy: a line, the eraser, an undone removal (a copy), a new name, colour or lines.
  const change = b => {
    const r = rnd();
    if (r < 0.45) addStrokes(b, [anyStroke()]);
    else if (r < 0.65 && b.strokes.length) removeStrokes(b, [pick(b.strokes).id], int(1, 1e9));
    else if (r < 0.75 && b.strokes.length) { const s = pick(b.strokes); removeStrokes(b, [s.id], int(1, 1e9)); addStrokes(b, [again(s)]); }
    else if (r < 0.83) { b.name = pick(NAMES); b.nameAt = int(1, 1e6); }
    else if (r < 0.91) { b.bg = pick(Object.keys(BACKGROUNDS)); b.bgAt = int(1, 1e6); }
    else { b.pattern = pick(Object.keys(PATTERNS)); b.patternAt = int(1, 1e6); }
    b.changed = int(1700000000000, 1800000000000);
  };
  return { board, change, int };
}
// The board as a file holds it, through JSON so -0 and 0 read the same (and `gone` in id order, which a merge doesn't
// keep and nothing depends on).
const filed = b => JSON.stringify({ ...shareable(b), gone: Object.fromEntries(Object.entries(b.gone).sort(([x], [y]) => (x < y ? -1 : 1))) });

test('copies of random boards merge the same whichever way round, and keep every stroke in order', () => {
  const t0 = Date.now();
  const rnd = prng(29);
  const { board, change, int } = randomBoards(rnd);
  for (let i = 0; i < 300; i++) {
    const base = board();
    const [a, b, c] = [clone(base), clone(base), clone(base)];
    for (const x of [a, b, c]) for (let n = int(0, 12); n--;) change(x);
    const ab = mergeBoards(a, b);
    assert.equal(filed(ab), filed(mergeBoards(b, a)), `board ${i}: a with b is b with a`);
    assert.equal(filed(mergeBoards(ab, c)), filed(mergeBoards(a, mergeBoards(b, c))), `board ${i}: the order of three merges doesn't matter`);
    assert.equal(filed(mergeBoards(ab, ab)), filed(ab), `board ${i}: merging the same copy again changes nothing`);
    assert.equal(filed(mergeBoards(ab, a)), filed(ab), `board ${i}: merging an older copy changes nothing`);
    // (Both sides may have put back the same stroke, each as its own copy: the one with the lower id is kept.)
    const one = new Map();
    for (const s of [...a.strokes, ...b.strokes]) if (!a.gone[s.id] && !b.gone[s.id] && !(one.get(drawing(s))?.id <= s.id)) one.set(drawing(s), s);
    const want = new Set([...one.values()].map(s => s.id));
    assert.deepEqual(new Set(ids(ab)), want, `board ${i}: every stroke either side has, minus what either took away, minus a second copy of the same drawing`);
    for (let j = 1; j < ab.strokes.length; j++) assert.ok(ab.strokes[j - 1].t <= ab.strokes[j].t, `board ${i}: strokes in the order they were started`);
  }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('random boards come back from an SVG and from a backup exactly as they were', () => {
  const t0 = Date.now();
  const { board } = randomBoards(prng(47));
  for (let i = 0; i < 300; i++) {
    const b = board();
    b.rev = 7; b.view = { x: 1, y: 2, z: 1 };
    const svg = toSVG(b);
    assert.doesNotMatch(svg, notXML, `board ${i}: the SVG holds only characters XML allows`);
    const back = fromSVG(svg);
    assert.ok(back, `board ${i}: the SVG opens`);
    // (A name comes back cleaned: a control character in it becomes a space.)
    const want = filed({ ...b, name: cleanName(b.name) });
    assert.doesNotMatch(back.name, /[\u0000-\u001f\u007f]/, `board ${i}: the name has no control characters`);
    assert.equal(filed(back), want, `board ${i}: through an SVG`);
    const saved = JSON.stringify({ cleanSlate: 1, saved: new Date().toISOString(), boards: [b].map(shareable) });
    assert.equal(filed(JSON.parse(saved).boards.map(cleanBoard)[0]), want, `board ${i}: through a backup`);
  }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('two devices drawing, erasing, clearing, undoing and syncing never have a line twice, and undo and redo always undo each other', () => {
  const t0 = Date.now();
  const rnd = prng(101);
  const twice = b => { const seen = new Set(); return b.strokes.some(s => { const k = drawing(s); return seen.has(k) || !seen.add(k); }); };
  for (let i = 0; i < 300; i++) {
    const start = makeBoard('F');
    addStrokes(start, [next(), next()]);
    const devs = [device(start), device(start)];
    const olds = []; // each device's copy as it was at each sync: what a backup or a Drive file can still hold
    const done = [];
    const where = () => `session ${i}: ${done.join(' ')}`;
    for (let j = 0; j < 60; j++) {
      const di = rnd() < 0.55 ? 0 : 1, d = devs[di], r = rnd();
      let op = '-';
      if (r < 0.3) { d.draw(); op = 'draw'; }
      else if (r < 0.42) { if (d.erase(list => list.filter(() => rnd() < 0.3))) op = 'erase'; }
      else if (r < 0.46) { if (d.clear()) op = 'clear'; }
      else if (r < 0.62) {
        const before = look(d.board);
        if (d.undo()) {
          op = 'undo';
          const mid = look(d.board);
          assert.equal(d.redo(), true, `${where()} ${di}:undo, then Redo`);
          assert.equal(look(d.board), before, `${where()} ${di}:undo+redo gives back the board`);
          d.undo();
          assert.equal(look(d.board), mid, `${where()} ${di}:undo+redo+undo`);
        }
      } else if (r < 0.74) {
        const before = look(d.board);
        if (d.redo()) {
          op = 'redo';
          const mid = look(d.board);
          assert.equal(d.undo(), true, `${where()} ${di}:redo, then Undo`);
          assert.equal(look(d.board), before, `${where()} ${di}:redo+undo gives back the board`);
          d.redo();
          assert.equal(look(d.board), mid, `${where()} ${di}:redo+undo+redo`);
        }
      } else {
        const [a, b] = devs.map(x => x.board);
        if (olds.length) {
          const old = olds[Math.floor(rnd() * olds.length)];
          assert.equal(filed(mergeBoards(mergeBoards(a, b), old)), filed(mergeBoards(a, mergeBoards(b, old))), `${where()} sync: the order of three merges doesn't matter`);
        }
        olds.push(clone(a), clone(b));
        sync(devs[0], devs[1]);
        assert.equal(filed(devs[0].board), filed(devs[1].board), `${where()} sync: both devices the same after`);
        op = 'sync';
      }
      done.push(`${di}:${op}`);
      for (const x of devs) {
        assert.ok(!twice(x.board), `${where()}: a line on the board twice`);
        if (olds.length) assert.equal(look(mergeBoards(x.board, olds[Math.floor(rnd() * olds.length)])), look(x.board), `${where()}: an older copy of the board brings nothing back`);
      }
    }
    for (const x of devs) {
      let n = 0;
      while (x.undo()) assert.ok(++n < 400, `${where()}: undo stops`);
      assert.equal(x.h.canUndo(), false, `${where()}: Undo greyed out once it stops`);
    }
  }
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('the README and the menu list the same keys', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = f => readFile(new URL('../' + f, import.meta.url), 'utf8');
  const plain = t => t.replace(/<[^>]+>|\*\*/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const readme = (await read('README.md')).match(/^- \*\*Keys:\*\*([\s\S]*?)\n(?:\n|- )/m);
  const menu = (await read('index.html')).match(/<b>With a keyboard:<\/b>([\s\S]*?)<\/li>/);
  assert.ok(readme && menu, 'both lists are there');
  assert.equal(plain(readme[1]), plain(menu[1]));
  assert.match(plain(menu[1]), /^P pen, .* Ctrl \(⌘ on a Mac\) \+ Z undo, .* Esc closes the menu, the list of boards or a pop-up\.$/);
});

// ---------- the lasso ----------
const rubAt = (x, y0, y1, size = 14, more = {}) => makeStroke({ tool: 'rub', color: '', size, sim: 0, pts: line(x, y0, x, y1), ...more });
const pen = (x0, y0, x1, y1, more = {}) => makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: line(x0, y0, x1, y1), ...more });
const take = (board, step) => { removeStrokes(board, (step.remove || []).map(s => s.id)); addStrokes(board, step.add || []); };

test('a rub-out in a group clears only the lines in its group, drawn before it', () => {
  const a = { ...pen(0, 50, 100, 50), grp: 'g1' }, b = pen(0, 50, 100, 50);
  const u = { ...rubAt(50, 0, 100), grp: 'g1' }, plain = rubAt(50, 0, 100);
  assert.equal(clears(u, a), true);
  assert.equal(clears(u, b), false, 'a line in no group (or another) is left alone');
  assert.equal(clears(plain, a) && clears(plain, b), true, 'a rub-out in no group clears everything before it');
  assert.equal(clears({ ...u, t: a.t - 1 }, a), false, 'and nothing drawn after it');
  assert.equal(covered(a, 50, 50, [u]), true);
  assert.equal(covered(b, 50, 50, [u]), false);
  // The whole-lines eraser takes a line only where it still shows.
  assert.equal(touches(a, 50, 50, 50, 50, 3, [u]), false);
  assert.equal(touches(b, 50, 50, 50, 50, 3, [u]), true);
});

test('a loop picks up the lines with half their points inside it, never a rub-out, nor a line rubbed out completely', () => {
  const b = makeBoard('L');
  const inside = pen(10, 10, 90, 10), half = pen(40, 30, 140, 30), out = pen(10, 200, 90, 200), gone = pen(10, 60, 40, 60), u = rubAt(25, 0, 120, 60);
  addStrokes(b, [inside, half, out, gone, u]);
  const loop = [0, 0, 100, 0, 100, 100, 0, 100];
  assert.equal(inLoop(loop, 50, 50), true);
  assert.equal(inLoop(loop, 150, 50), false);
  assert.deepEqual(pick(b, loop).sort(), [inside.id, half.id].sort(), 'not the one outside, the rub-out, or the line it cleared');
  assert.deepEqual(pick(b, [0, 0, 10, 0]), [], 'a loop that encloses nothing');
});

test('lines moved with the lasso take their rub-outs along, and clear nothing where they land', () => {
  const b = makeBoard('M');
  const word = pen(0, 50, 100, 50), other = pen(0, 80, 100, 80), u = rubAt(50, 0, 100);
  const under = pen(400, 50, 600, 50); // already where the word is going, drawn before the rub-out
  addStrokes(b, [word, other, under]);
  addStrokes(b, [{ ...u, t: nextTs(b, 1) }]);
  const rub = b.strokes[b.strokes.length - 1];
  const r = placeStep(b, [word.id], { dx: 450 });
  assert.equal(r.step.add.length, 2, 'the word and a copy of its rub-out');
  assert.deepEqual(r.step.remove.map(s => s.id), [word.id], 'the rub-out still clears the line left behind, so it stays');
  take(b, r.step);
  const [moved, cut] = r.step.add;
  assert.deepEqual(r.ids, [moved.id]);
  assert.equal(moved.tool, 'pen');
  assert.equal(cut.tool, 'rub');
  assert.ok(moved.grp && moved.grp === cut.grp && cut.t > moved.t, 'in one new group, the rub-out after the line');
  assert.ok(moved.t > rub.t, 'on top of everything');
  assert.equal(moved.pts[0], 450);
  assert.equal(covered(moved, 500, 50, b.strokes.filter(s => s.tool === 'rub')), true, 'the gap moved with the word');
  assert.equal(covered(under, 500, 50, b.strokes.filter(s => s.tool === 'rub')), false, 'and doesn’t cut the line it landed on');
  assert.equal(covered(other, 50, 80, b.strokes.filter(s => s.tool === 'rub')), true, 'the line left behind keeps its gap');
  // Moved again: the copy in the group goes along again, into a group of its own, and the old one, now clearing
  // nothing, goes with the move.
  const r2 = placeStep(b, [moved.id], { dx: 0, dy: 300 });
  assert.deepEqual(r2.step.remove.map(s => s.id).sort(), [moved.id, cut.id].sort());
  take(b, r2.step);
  assert.equal(b.strokes.filter(s => s.tool === 'rub').length, 2, 'the original rub-out (still clearing the other line) and one copy');
});

test('a rub-out that cleared only the lines moved goes with them; one in two groups is copied into each', () => {
  const b = makeBoard('S');
  const word = pen(0, 50, 100, 50);
  addStrokes(b, [word]);
  const u = { ...rubAt(50, 0, 100), t: nextTs(b, 1) };
  addStrokes(b, [u]);
  const r = placeStep(b, [word.id], { dx: 300 });
  assert.deepEqual(r.step.remove.map(s => s.id), [word.id, u.id]);
  // Lines from two earlier moves, picked up together under one rub-out drawn over both: each keeps its gap.
  const c = makeBoard('T');
  const g1 = { ...pen(0, 50, 100, 50), grp: 'g1' }, g2 = { ...pen(0, 60, 100, 60), grp: 'g2' };
  addStrokes(c, [g1, g2]);
  const over = { ...rubAt(50, 0, 100), t: nextTs(c, 1) }, only1 = { ...rubAt(20, 0, 100), grp: 'g1', t: nextTs(c, 1) };
  addStrokes(c, [over, only1]);
  const r2 = placeStep(c, [g1.id, g2.id], { dx: 500 });
  const rubs = r2.step.add.filter(s => s.tool === 'rub');
  assert.equal(rubs.length, 3, 'the rub-out over both, once for each group, and the one in g1 once');
  const [n1, n2] = r2.step.add.filter(s => s.tool === 'pen');
  assert.notEqual(n1.grp, n2.grp);
  take(c, r2.step);
  const all = c.strokes.filter(s => s.tool === 'rub');
  assert.equal(covered(n1, 520, 50, all), true, 'g1’s own rub-out still clears it');
  assert.equal(covered(n2, 520, 60, all), false, 'and still not the other line');
  assert.equal(covered(n2, 550, 60, all), true, 'the rub-out over both still clears both');
});

test('a move, a resize, a copy, a new colour and a delete are each one undo step that gives the board back', () => {
  const b = makeBoard('U');
  const h = makeHistory({ add: s => addStrokes(b, s), remove: x => removeStrokes(b, x), find: s => twin(b, s), has: x => x.some(i => b.strokes.some(s => s.id === i)) });
  const word = pen(0, 50, 100, 50), mark = makeStroke({ tool: 'marker', color: 'yellow', size: 20, sim: 0, pts: line(0, 60, 100, 60) });
  addStrokes(b, [word, mark]);
  addStrokes(b, [{ ...rubAt(50, 0, 100), t: nextTs(b, 1) }]);
  const look = () => b.strokes.map(s => `${s.t}|${s.tool}|${s.color}|${s.size}|${s.pts.join(',')}`).join(';');
  const before = look();
  let sel = [word.id, mark.id];
  for (const make of [
    () => placeStep(b, sel, { dx: 40, dy: -20 }),
    () => placeStep(b, sel, { k: 2, ox: 0, oy: 0 }),
    () => placeStep(b, sel, { dx: 24, dy: 24 }, { copy: true }),
    () => recolourStep(b, sel, 'red'),
    () => deleteStep(b, sel),
  ]) {
    const was = look(), r = make();
    take(b, r.step);
    h.remember(r.step);
    const done = look();
    assert.notEqual(done, was);
    h.undo();
    assert.equal(look(), was, 'undone in one step');
    h.redo();
    assert.equal(look(), done, 'and redone');
    // (Redo puts the lines back under new ids: picked up again, as the page does after an undo.)
    const key = x => `${x.t}|${x.color}|${x.pts.join()}`, came = new Set((r.step.add || []).filter(x => x.tool !== 'rub').map(key));
    sel = b.strokes.filter(x => came.has(key(x))).map(x => x.id);
  }
  while (h.undo());
  assert.equal(look(), before, 'all of it undone');
});

test('resizing scales the lines and their widths about the corner held still', () => {
  const b = makeBoard('R');
  const s = pen(100, 100, 200, 100);
  addStrokes(b, [s]);
  const r = placeStep(b, [s.id], { k: 2, ox: 100, oy: 100 });
  const [n] = r.step.add;
  assert.deepEqual([n.pts[0], n.pts[1], n.pts[n.pts.length - 3], n.size], [100, 100, 300, 8]);
  const big = pickedBounds({ ...b, strokes: [n] }, [n.id]), small = pickedBounds(b, [s.id]);
  assert.ok(big.x1 - big.x0 > 1.9 * (small.x1 - small.x0));
});

test('a new colour keeps each pen line where it was in the drawing, and leaves highlighter alone', () => {
  const b = makeBoard('C');
  const a = { ...pen(0, 0, 100, 0), grp: 'g' }, m = makeStroke({ tool: 'marker', color: 'yellow', size: 20, sim: 0, pts: line(0, 10, 100, 10) });
  addStrokes(b, [a, m]);
  const r = recolourStep(b, [a.id, m.id], 'blue');
  assert.deepEqual(r.step.remove.map(s => s.id), [a.id]);
  const [n] = r.step.add;
  assert.deepEqual([n.color, n.t, n.grp], ['blue', a.t, 'g']);
  assert.deepEqual(r.ids, [n.id, m.id]);
  assert.equal(recolourStep(b, [m.id], 'blue'), null, 'nothing to recolour');
  assert.equal(recolourStep(b, [a.id], 'nonsense'), null);
});

test('two devices, one moving lines while the other draws, end up with the same board whichever way round they merge', () => {
  const start = makeBoard('Two');
  const word = pen(0, 50, 100, 50), other = pen(0, 80, 100, 80);
  addStrokes(start, [word, other]);
  addStrokes(start, [{ ...rubAt(50, 0, 100), t: nextTs(start, 1) }]);
  const a = clone(start), b = clone(start);
  const r = placeStep(a, [word.id], { dx: 300 });
  take(a, r.step);
  addStrokes(b, [pen(0, 300, 100, 300, {}, nextT(b))]);
  const ab = mergeBoards(a, b), ba = mergeBoards(b, a);
  assert.deepEqual(ids(ab), ids(ba));
  assert.equal(contentKey(ab), contentKey(ba));
  assert.equal(ab.strokes.length, 5, 'the line left, its rub-out, the word and its rub-out where it went, and B’s new line');
  assert.ok(!ab.strokes.some(s => s.id === word.id), 'the word isn’t left behind too');
  // A copy of the moved word from a version before the lasso (which dropped the group) loses to the one with it.
  const old = clone(ab);
  for (const s of old.strokes) delete s.grp;
  const back = mergeBoards(old, ab);
  assert.equal(back.strokes.filter(s => s.grp).length, 2, 'the moved word and its rub-out keep their group');
});

test('a group comes through a file, and a moved rub-out is a mask on the lines it clears', () => {
  const b = makeBoard('F');
  const word = pen(0, 50, 100, 50), other = pen(0, 80, 100, 80);
  addStrokes(b, [word, other]);
  addStrokes(b, [{ ...rubAt(50, 0, 100), t: nextTs(b, 1) }]);
  take(b, placeStep(b, [word.id], { dx: 300 }).step);
  for (const bg of ['white', 'slate']) {
    b.bg = bg;
    const svg = toSVG(b), back = fromSVG(svg);
    assert.deepEqual(back.strokes.map(s => s.grp || ''), b.strokes.map(s => s.grp || ''));
    assert.equal((svg.match(/mask="url\(#c0\)"/g) || []).length, 1, 'the moved word has a mask of its own');
    assert.equal(cleanBoard({ ...clone(b), strokes: [{ ...b.strokes[0], grp: 'not ok!' }] }).strokes[0].grp, undefined, 'a group that isn’t a name is dropped');
  }
  // Just those lines, for a picture of them: copies where they are, with their gap.
  const only = pickedStrokes(b, [b.strokes.find(s => s.grp && s.tool === 'pen').id]);
  assert.deepEqual(only.map(s => s.tool), ['pen', 'rub']);
  assert.equal(only[0].pts[0], 300);
});

test('a board from before the lasso makes the same SVG, byte for byte, and reads back the same', () => {
  // (The hashes were taken with the version before groups, so old boards, files and Drive copies are untouched.)
  const ln = (x0, y0, x1, y1, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, 0.3 + 0.4 * i / n]).flat();
  const strokes = [
    { id: 's1', t: 1, tool: 'pen', color: 'ink', size: 4, sim: 0, pts: ln(10, 10, 200, 60) },
    { id: 's2', t: 2, tool: 'marker', color: 'yellow', size: 20, sim: 0, pts: ln(10, 40, 220, 40) },
    { id: 's3', t: 3, tool: 'pen', color: 'blue', size: 4, sim: 0, pts: [50, 80, 0.5, 150, 80, 0.5, 150, 140, 0.5, 50, 140, 0.5], shape: 'closed', fill: 1 },
    { id: 's4', t: 4, tool: 'rub', color: '', size: 14, sim: 0, pts: ln(100, 20, 100, 150) },
    { id: 's5', t: 5, tool: 'pen', color: 'red', size: 2, sim: 1, pts: ln(0, 160, 240, 170), shape: 'arrow' },
    { id: 's6', t: 6, tool: 'rub', color: '', size: 30, sim: 0, pts: ln(180, 150, 200, 180) },
    { id: 's7', t: 7, tool: 'pen', color: 'green', size: 8, sim: 0, pts: ln(20, 190, 220, 200), shape: 'double' },
  ];
  const want = {
    'white grid': ['aa0a141cb838e904', 'ceed8d6d75084418'], 'white blank': ['ca46375f9735b996', '844b128ace81f0bf'],
    'paper grid': ['e59849f02fe6b598', 'cf72c4c4b1756d79'], 'paper blank': ['509baac58b138dc9', '0b2683c8cead8bba'],
    'slate grid': ['b647ee13c5d7133a', '0c31efe01d8c5e37'], 'slate blank': ['d2739624b6376800', '6d116ace36e11db3'],
  };
  const hash = t => createHash('sha1').update(t).digest('hex').slice(0, 16);
  for (const [k, [svgHash, backHash]] of Object.entries(want)) {
    const [bg, pattern] = k.split(' ');
    const b = cleanBoard({ id: 'bfix', name: 'Fixture', nameAt: 1, bg, bgAt: 1, pattern, patternAt: 1, created: 1, changed: 2, strokes, gone: { sx: 3 } });
    const svg = toSVG(b);
    assert.equal(hash(svg), svgHash, k);
    assert.equal(hash(JSON.stringify(fromSVG(svg))), backHash, k);
  }
});

// ---------- photos ----------
// (A tiny PNG and a tiny JPEG, as data: URLs.)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const photoOf = (data, x0, y0, x1, y1, t) => ({ id: newIdLike(), t: t ?? Date.now(), tool: 'photo', color: '', size: 1, sim: 0, pts: [x0, y0, 1, x1, y1, 1], src: photoKey(data) });
let photoN = 0;
const newIdLike = () => `sphoto${photoN++}`;
const withPhoto = (b, data, ...rest) => { const s = photoOf(data, ...rest); b.photos = { ...b.photos, [s.src]: data }; addStrokes(b, [s]); return s; };

test('a photo is kept with its board, once, whatever shows it, and comes through a backup and an SVG', () => {
  const b = makeBoard('Homework');
  const p1 = withPhoto(b, PNG, 0, 0, 400, 300, 1);
  const p2 = { ...p1, id: 'sphotocopy', t: 2, pts: [500, 0, 1, 900, 300, 1] }; // the same picture twice (Duplicate)
  addStrokes(b, [p2, stroke(10, 10, {}, 3)]);
  assert.equal(photoKey(PNG), photoKey(PNG), 'the same picture always has the same key');
  assert.notEqual(photoKey(PNG), photoKey(JPG));
  const back = cleanBoard(clone(shareable(b)));
  assert.deepEqual(back.photos, { [p1.src]: PNG });
  assert.deepEqual(back.strokes.map(s => s.tool), ['photo', 'photo', 'pen']);
  const svg = toSVG(b);
  assert.equal(svg.split(PNG).length - 1, 1, 'the picture is in the file once');
  assert.equal((svg.match(/<use xlink:href="#p/g) || []).length, 2, 'shown twice');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" xmlns:xlink="http:\/\/www.w3.org\/1999\/xlink"/);
  assert.ok(svg.indexOf('<g id="ph">') > 0 && svg.indexOf('<g id="ph">') < svg.indexOf('fill="#1d1d1f"'), 'photos go under the ink');
  const read = fromSVG(svg);
  assert.deepEqual(read.photos, { [p1.src]: PNG }, 'the board read back from the SVG has its picture');
  assert.deepEqual(read.strokes.map(s => s.id), b.strokes.map(s => s.id));
  // The slate paints the photos back where a rub-out goes over ink on them, as it paints back the board.
  b.bg = 'slate';
  addStrokes(b, [makeStroke({ tool: 'rub', color: '', size: 20, sim: 0, pts: line(50, 0, 50, 300) }, 4)]);
  assert.match(toSVG(b), /<g clip-path="url\(#r0\)" opacity="0.999"><rect [^>]*fill="#2a3236"\/><rect [^>]*fill="url\(#p\)"\/><use xlink:href="#ph"\/><\/g>/);
  assert.doesNotMatch(toSVG(b), /<g mask="url\(#m\d+\)"><use xlink:href="#p/, 'and a photo under a rub-out is left whole');
});

test('a photo whose picture isn’t a JPEG, a PNG or a WebP, or a photo stroke that isn’t whole, is left out', () => {
  const b = { ...makeBoard('Bad'), photos: { pok: PNG, pbad: 'data:text/html;base64,PHA+', pjs: 'javascript:alert(1)', 'not a key': PNG } };
  b.strokes = [
    { id: 'a', t: 1, tool: 'photo', pts: [0, 0, 1, 10, 10, 1], src: 'pok' },
    { id: 'b', t: 2, tool: 'photo', pts: [0, 0, 1], src: 'pok' },
    { id: 'c', t: 3, tool: 'photo', pts: [10, 10, 1, 0, 0, 1], src: 'pok' },
    { id: 'd', t: 4, tool: 'photo', pts: [0, 0, 1, 10, 10, 1], src: '<script>' },
  ];
  const c = cleanBoard(b);
  assert.deepEqual(Object.keys(c.photos), ['pok']);
  assert.deepEqual(c.strokes.map(s => s.id), ['a']);
  assert.equal(cleanBoard({ ...makeBoard('Plain') }).photos, undefined, 'a board with none has none');
});

test('two copies of a board with photos merge with every picture either has', () => {
  const a = makeBoard('P'), b = clone(a);
  withPhoto(a, PNG, 0, 0, 10, 10, 1);
  withPhoto(b, JPG, 20, 0, 30, 10, 2);
  const ab = mergeBoards(a, b), ba = mergeBoards(b, a);
  assert.deepEqual(Object.keys(ab.photos).sort(), Object.keys(ba.photos).sort());
  assert.equal(Object.keys(ab.photos).length, 2);
  assert.equal(contentKey(ab), contentKey(ba));
  // A photo turned into a pen line by a version that didn't know photos loses to the photo.
  const old = clone(ab);
  old.strokes = old.strokes.map(s => ({ ...s, tool: 'pen', src: undefined }));
  assert.deepEqual(mergeBoards(old, ab).strokes.map(s => s.tool), ['photo', 'photo']);
  // What goes into a file, or a copy of the board, is only the pictures it shows.
  removeStrokes(ab, [ab.strokes[0].id]);
  assert.deepEqual(Object.keys(shareable(ab).photos), [ab.strokes[0].src]);
  assert.deepEqual(Object.keys(copyBoard(ab, [ab]).photos), [ab.strokes[0].src]);
  assert.equal(photosFor({ ...ab, photos: undefined }), null);
});

test('the eraser touches a photo anywhere on it, a rub-out never clears it, and the lasso picks it up and resizes it', () => {
  const b = makeBoard('E');
  const p = withPhoto(b, PNG, 100, 100, 300, 250, 1);
  assert.equal(touches(p, 200, 170, 200, 170, 5), true, 'in the middle of it');
  assert.equal(touches(p, 400, 170, 400, 170, 5), false);
  const u = makeStroke({ tool: 'rub', color: '', size: 20, sim: 0, pts: line(200, 80, 200, 280) }, 2);
  assert.equal(clears(u, p), false, 'a rub-out after it leaves it: rubbing out a wrong answer keeps the question');
  assert.equal(clears({ ...u, grp: 'g1' }, { ...p, grp: 'g1' }), false, 'in a group too');
  assert.equal(covered(p, 200, 170, [u]), false);
  assert.equal(touches(p, 200, 170, 200, 170, 5, [u]), true, 'so Whole lines still takes it where a rub-out went over it');
  assert.deepEqual(pick(b, [90, 90, 310, 90, 310, 260, 90, 260]), [p.id], 'a loop round it');
  assert.deepEqual(pick(b, [150, 150, 180, 150, 180, 180, 150, 180]), [], 'a loop inside it is round no photo');
  const r = placeStep(b, [p.id], { k: 2, ox: 100, oy: 100 });
  assert.deepEqual(r.step.add[0].pts, [100, 100, 1, 500, 400, 1]);
  assert.equal(r.step.add[0].src, p.src);
  assert.equal(visibleBounds([p, u]).x0 < 101, true, 'a photo never counts as rubbed out completely');
});

test('a tap with the lasso picks up the photo under it, the top one where two overlap, and never a line', () => {
  const b = makeBoard('T');
  const under = withPhoto(b, PNG, 0, 0, 400, 300, 1), over = withPhoto(b, JPG, 300, 200, 700, 500, 2);
  addStrokes(b, [makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: line(900, 100, 1000, 100) }, 3)]);
  assert.deepEqual(tapPick(b, 100, 100), [under.id]);
  assert.deepEqual(tapPick(b, 350, 250), [over.id], 'the one put there last');
  assert.deepEqual(tapPick(b, 700, 500), [over.id], 'on its edge');
  assert.deepEqual(tapPick(b, 950, 100), [], 'a tap on a line picks up nothing');
  assert.deepEqual(tapPick(b, 800, 50), [], 'nor one on bare board');
  assert.deepEqual(tapPick(makeBoard('E'), 0, 0), []);
});

// ---------- Ask Claude (js/claude.js) ----------
import * as claude from '../js/claude.js';

// A board for Tidy it up: a rough box drawn as four sides, a rough arrow, a word of handwriting, a highlight, and a line
// with a rub-out over it. Short ids are given in drawing order to the pen lines Tidy may replace.
function tidyBoard() {
  const b = makeBoard('Tidy');
  const pen = (pts, more = {}) => makeStroke({ tool: 'pen', color: 'blue', size: 4, sim: 0, pts, ...more });
  const sides = [line(100, 100, 300, 104), line(301, 102, 298, 200), line(300, 202, 102, 198), line(99, 199, 101, 101)].map(p => pen(p));
  const arrow = pen(line(320, 150, 480, 155), { color: 'red' });
  const word = pen([500, 300, 0.5, 510, 280, 0.5, 520, 310, 0.5, 530, 285, 0.5, 540, 305, 0.5], { color: 'ink' });
  const hi = makeStroke({ tool: 'marker', color: 'yellow', size: 20, sim: 0, pts: line(500, 400, 600, 400) });
  const rubbed = pen(line(100, 500, 300, 500));
  addStrokes(b, [...sides, arrow, word, hi, rubbed]);
  const rub = makeStroke({ tool: 'rub', color: '', size: 30, sim: 0, pts: line(190, 490, 210, 510) });
  addStrokes(b, [rub]);
  return { b, sides, arrow, word, hi, rubbed, rub };
}
const fullShapes = { shapes: [
  { replaces: ['1', '2', '3', '4'], kind: 'rect', x0: 100, y0: 100, x1: 300, y1: 200 },
  { replaces: ['5'], kind: 'arrow', x0: 300, y0: 152, x1: 480, y1: 152 },
] };

test('Tidy it up lists the pen lines it may replace under short ids, with the picture’s mapping, and leaves out the rest', () => {
  const { b, sides, arrow, word, rubbed } = tidyBoard();
  const { text, fixed, ids } = claude.tidyList(b);
  assert.deepEqual([...ids.entries()], [...sides, arrow, word].map((s, i) => [String(i + 1), s.id]), 'the box’s sides, the arrow and the word, in drawing order');
  assert.ok(!ids.has('7') && ![...ids.values()].includes(rubbed.id), 'a line with a rub-out over it isn’t offered');
  assert.match(text, /^1 pen blue size 4 box 9\d,9\d to 30\d,10\d pts 100,100 300,104$/m, 'id, tool, colour, size, box and a few points, in board coordinates');
  assert.match(fixed, /highlighter yellow/);
  assert.match(fixed, /pen blue, partly rubbed out/);
  const { body, ids: sent } = claude.tidyRequest(b, { type: 'image/png', data: 'AAAA', w: 1600, h: 1000, x: 50, y: 60, k: 2.5 });
  assert.equal(sent.size, 6);
  const words = body.messages[0].content[1].text;
  assert.match(words, /the picture is 1600 × 1000 pixels\. Pixel \(px, py\) is board point \(50 \+ px \/ 2\.5, 60 \+ py \/ 2\.5\)/);
  assert.match(words, /^6 pen black /m);
  assert.deepEqual(body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: claude.TIDY_SCHEMA } });
  assert.equal(body.messages[0].content[0].type, 'image', 'the picture comes before the text');
  // The schema keeps to what structured outputs take: every object closed, every property required.
  const walk = o => { if (o?.type === 'object') { assert.equal(o.additionalProperties, false); assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort()); Object.values(o.properties).forEach(walk); } if (o?.items) walk(o.items); };
  walk(claude.TIDY_SCHEMA);
});

test('every request asks Claude Opus 5.5, with adaptive thinking, fallbacks on, and the headers a browser needs', () => {
  const image = { type: 'image/png', data: 'AAAA' };
  for (const [body, effort] of [[claude.typeRequest(image), 'low'], [claude.askRequest(image, '  What’s the total area?  '), 'medium']]) {
    assert.equal(body.model, 'claude-opus-5-5');
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.max_tokens, 16000);
    assert.deepEqual(body.output_config, { effort });
    assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    assert.equal('temperature' in body, false);
  }
  assert.equal(claude.askRequest(image, '  What’s the total area?  ').messages[0].content[1].text, 'What’s the total area?');
  assert.deepEqual(claude.headers('sk-ant-test'), {
    'content-type': 'application/json', 'x-api-key': 'sk-ant-test', 'anthropic-version': '2026-10-21',
    'anthropic-beta': 'server-side-fallback-2026-07-01', 'anthropic-dangerous-direct-browser-access': 'true',
  });
});

test('Tidy it up’s answer becomes one undo step: clean shapes in the colour and size of what they replace, nothing else touched', () => {
  const { b, sides, arrow, word, hi } = tidyBoard();
  const before = clone(b);
  const { ids } = claude.tidyList(b);
  const r = claude.tidyStep(b, fullShapes, ids);
  assert.equal(r.count, 2);
  assert.deepEqual(r.step.remove.map(s => s.id), [...sides, arrow].map(s => s.id), 'the four sides and the arrow go');
  const [box, arr] = r.step.add;
  assert.deepEqual([box.shape, box.color, box.size, box.pts], ['closed', 'blue', Math.round(weight(sides[0]) * 100) / 100, [100, 100, 0.5, 300, 100, 0.5, 300, 200, 0.5, 100, 200, 0.5]], 'a box, as the shapes tool makes one, at the line’s weight');
  assert.deepEqual([arr.shape, arr.color, arr.pts], ['arrow', 'red', [300, 152, 0.5, 480, 152, 0.5]]);
  assert.ok(arr.t > b.strokes[b.strokes.length - 1].t, 'on top of the drawing');
  // Applied and undone through the history, as the page does it.
  const h = makeHistory({ add: s => addStrokes(b, s), remove: i => removeStrokes(b, i), has: i => i.some(x => b.strokes.some(s => s.id === x)), find: s => twin(b, s) });
  removeStrokes(b, r.step.remove.map(s => s.id));
  addStrokes(b, r.step.add);
  h.remember(r.step);
  assert.ok(b.strokes.some(s => s.id === word.id) && b.strokes.some(s => s.id === hi.id), 'the writing and the highlight stay');
  assert.equal(b.strokes.length, before.strokes.length - 3);
  h.undo();
  assert.deepEqual(b.strokes.map(drawing), before.strokes.map(drawing), 'one undo gives the board back as it was');
  h.redo();
  assert.deepEqual(b.strokes.filter(s => s.shape).map(s => s.shape), ['closed', 'arrow']);
});

test('Tidy it up ignores ids it didn’t send, strokes it may not touch, and numbers that aren’t sensible', () => {
  const { b, sides, word } = tidyBoard();
  const { ids } = claude.tidyList(b);
  const none = answer => assert.deepEqual(claude.tidyStep(b, answer, ids), { count: 0 }, JSON.stringify(answer));
  none({ shapes: [] });
  none(null);
  none({ shapes: 'all of them' });
  none({ shapes: [{ replaces: ['99', 'abc', sides[0].id], kind: 'rect', x0: 100, y0: 100, x1: 300, y1: 200 }] }); // unknown ids, and a real stroke id it wasn't sent
  none({ shapes: [{ replaces: ['7'], kind: 'line', x0: 500, y0: 400, x1: 600, y1: 400 }] }); // (there's no 7: the highlight and the rubbed-out line weren't offered)
  none({ shapes: [{ replaces: ['1'], kind: 'triangle', x0: 100, y0: 100, x1: 300, y1: 200 }] });
  none({ shapes: [{ replaces: ['1'], kind: 'rect', x0: 100, y0: 100, x1: 1e12, y1: 200 }] });
  none({ shapes: [{ replaces: ['1'], kind: 'rect', x0: 100, y0: 100, x1: '300', y1: 200 }] });
  none({ shapes: [{ replaces: ['1'], kind: 'rect', x0: 100, y0: 100, x1: null, y1: 200 }] });
  none({ shapes: [{ replaces: ['1'], kind: 'rect', x0: 5000, y0: 5000, x1: 5200, y1: 5100 }] }); // far from the line it replaces
  none({ shapes: [{ replaces: ['1'], kind: 'rect', x0: 100, y0: 100, x1: 101, y1: 200 }] }); // too thin to see
  none({ shapes: [{ replaces: [], kind: 'rect', x0: 100, y0: 100, x1: 300, y1: 200 }] }); // adds nothing new
  none({ shapes: [{ replaces: '1', kind: 'rect', x0: 100, y0: 100, x1: 300, y1: 200 }] });
  none({ shapes: [null, 7, 'x', [], { kind: 'rect' }] });
  // A stroke named twice is replaced once; the second shape keeps only what's left to it.
  const r = claude.tidyStep(b, { shapes: [
    { replaces: ['1', '1', '2'], kind: 'line', x0: 100, y0: 100, x1: 300, y1: 100 },
    { replaces: ['2'], kind: 'line', x0: 300, y0: 100, x1: 300, y1: 200 },
    { replaces: ['6', '9'], kind: 'ellipse', x0: 495, y0: 275, x1: 545, y1: 315 },
  ] }, ids);
  assert.equal(r.count, 2);
  assert.deepEqual(r.step.remove.map(s => s.id), [sides[0].id, sides[1].id, word.id]);
  // A line that has gone from the board since (erased on another device) isn't touched.
  removeStrokes(b, [word.id]);
  assert.equal(claude.tidyStep(b, { shapes: [{ replaces: ['6'], kind: 'ellipse', x0: 495, y0: 275, x1: 545, y1: 315 }] }, ids).count, 0);
  // A clean shape given back as it was changes nothing.
  const c = makeBoard('C'), sq = makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [10, 10, 0.5, 90, 10, 0.5, 90, 60, 0.5, 10, 60, 0.5], shape: 'closed', fill: 1 });
  addStrokes(c, [sq]);
  const cids = claude.tidyList(c).ids;
  assert.equal(claude.tidyStep(c, { shapes: [{ replaces: ['1'], kind: 'rect', x0: 10, y0: 10, x1: 90, y1: 60 }] }, cids).count, 0);
  const moved = claude.tidyStep(c, { shapes: [{ replaces: ['1'], kind: 'rect', x0: 10, y0: 20, x1: 90, y1: 60 }] }, cids);
  assert.deepEqual([moved.step.add[0].fill, moved.step.add[0].size], [1, 4], 'a filled shape stays filled, at its own size');
  assert.equal(claude.parseTidy('not json'), null);
  assert.equal(claude.parseTidy('{"shapes": 3}'), null);
  assert.deepEqual(claude.parseTidy('{"shapes": []}'), { shapes: [] });
});

test('Ask Claude reads refusals, cut-off answers and fallbacks, works out the cost, and says what went wrong plainly', () => {
  assert.deepEqual(claude.readReply({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], stop_details: { category: 'cyber', explanation: 'No.' } }), { kind: 'refusal', explanation: 'No.', model: 'claude-opus-5-5', fallback: false });
  assert.deepEqual(claude.readReply({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Hi ' }] }), { kind: 'text', text: 'Hi', cut: false, model: 'claude-opus-5-5', fallback: false });
  const fell = { model: 'claude-opus-5', stop_reason: 'max_tokens', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: 'Half' }],
    usage: { input_tokens: 2000, output_tokens: 1000, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 0 }, { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 2000, output_tokens: 1000 }] } };
  assert.deepEqual(claude.readReply(fell), { kind: 'text', text: 'Half', cut: true, model: 'claude-opus-5', fallback: true });
  assert.equal(claude.modelName('claude-opus-5'), 'Claude Opus 5');
  // $4 / $20 per million on Opus 5.5; with a fallback, each attempt at its own model's prices.
  assert.equal(claude.cost({ model: 'claude-opus-5-5', usage: { input_tokens: 2500, output_tokens: 500 } }).toFixed(6), '0.020000');
  assert.equal(claude.cost(fell).toFixed(6), (0.008 + 0.01 + 0.025).toFixed(6));
  assert.equal(claude.cost({}), 0);
  assert.deepEqual([0.02, 0.0004, 0.00123, 1.5, 0].map(claude.costText), ['about 2¢', 'under 0.1¢', 'about 0.1¢', 'about $1.50', '']);
  assert.match(claude.problem(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }), /didn’t accept that API key/);
  assert.match(claude.problem(401, { error: { type: 'authentication_error', message: 'CORS requests are not allowed for this Organization because of its settings' } }), /won’t take requests from a browser/);
  assert.match(claude.problem(402, { error: { type: 'billing_error' } }), /billing/);
  assert.match(claude.problem(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), /credit has run out/);
  assert.match(claude.problem(400, { error: { type: 'invalid_request_error', message: 'max_tokens: too big' } }), /couldn’t take this request: max_tokens: too big/);
  assert.match(claude.problem(429, { error: { type: 'rate_limit_error' } }, 20), /Try again in 20 seconds/);
  assert.match(claude.problem(429, { error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }), /monthly spend limit/);
  assert.match(claude.problem(529, { error: { type: 'overloaded_error' } }), /overloaded/);
  assert.match(claude.problem(500, null), /went wrong at Anthropic/);
  assert.equal(claude.keyTrouble(' sk-ant-api03-abc '), '');
  assert.match(claude.keyTrouble('hello'), /start sk-ant-/);
  assert.match(claude.keyTrouble('sk-ant- abc'), /space/);
});
