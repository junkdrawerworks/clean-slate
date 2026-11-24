// The parts that don't need a page: boards merging, the SVG file, undo, and what the eraser touches.  node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoard, makeStroke, addStrokes, removeStrokes, mergeBoards, contentKey, cleanBoard, importBoard, untouched, nothingBeyond, again, nextName, sameNames, nextT, laterThan, shareable, shade, INKS, MARKERS, SIZES, MAX_SIZE, BACKGROUNDS, PATTERNS } from '../js/board.js';
import { toSVG, fromSVG } from '../js/svg.js';
import { makeHistory, STEPS } from '../js/history.js';
import { touches, contentBounds, visibleBounds, frame, outline, pathData, weight, headLength, shapeLines, bounds } from '../js/ink.js';
import { recognize, dragShape } from '../js/shapes.js';

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
  assert.equal(laterThan(Date.now() + 60000), Date.now() + 60001);
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
  b.bg = 'slate';
  const rub = x => makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [x, 0, 0.5, x + 5, 5, 0.5] });
  const a = stroke(0, 0), r0 = rub(5), b1 = stroke(30, 0), r1 = rub(35), r1b = rub(40), c = stroke(60, 0), r2 = rub(65), d = stroke(90, 0);
  addStrokes(b, [a, r0, b1, r1, r1b, c, r2, d]);
  const ink = s => `<path d="${pathData(outline(s))}" fill="${shade(s, 'slate')}"/>`;
  const svg = toSVG(b);
  assert.equal((svg.match(/<mask /g) || []).length, 3, 'one mask per run of rub-outs');
  assert.ok(svg.endsWith(`\n<g mask="url(#r2)"><g mask="url(#r1)"><g mask="url(#r0)">${ink(a)}</g>${ink(b1)}</g>${ink(c)}</g>\n${ink(d)}\n</svg>`), svg.slice(svg.lastIndexOf('</defs>')));
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
  assert.doesNotMatch(toSVG(b), /<g style=/, 'the slate stays as it was');
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
  const t0 = performance.now();
  toSVG(big(2000, true));
  assert.ok(performance.now() - t0 < 300, `2,000 strokes with rub-outs took ${Math.round(performance.now() - t0)} ms`);
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
  const time = b => { const t = performance.now(); const out = toSVG(b); return [performance.now() - t, out]; };
  const [took, first] = time(big);
  const [, second] = time(big);
  assert.equal(second, first, 'the same file');
  assert.equal(toSVG(fresh()), first, 'and the same as one traced afresh');
  const again = Math.min(time(big)[0], time(big)[0], time(big)[0]); // (the least of three, past a pause for garbage)
  assert.ok(again < took / 10, `a second SVG of an unchanged board takes under a tenth of the first: ${took.toFixed(1)} ms, then ${again.toFixed(1)} ms`);
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

// ---------- random boards: merging and files ----------
// A random board as a person might make one, from a seeded random number. (Sizes as drawn at any zoom from 10% up, so
// up to the Large eraser at 10%.)
function randomBoards(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const NAMES = ['Board', 'Garden plan', 'Fish & <chips>', 'Ünïcødé 🐟', '"quoted" \'single\'', 'a]]>b', '</metadata>', 'x'.repeat(80), 'tab\there', 'é'];
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
    const want = new Set([...a.strokes, ...b.strokes].filter(s => !a.gone[s.id] && !b.gone[s.id]).map(s => s.id));
    assert.deepEqual(new Set(ids(ab)), want, `board ${i}: every stroke either side has, minus what either took away`);
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
    const back = fromSVG(toSVG(b));
    assert.ok(back, `board ${i}: the SVG opens`);
    assert.equal(filed(back), filed(b), `board ${i}: through an SVG`);
    const saved = JSON.stringify({ cleanSlate: 1, saved: new Date().toISOString(), boards: [b].map(shareable) });
    assert.equal(filed(JSON.parse(saved).boards.map(cleanBoard)[0]), filed(b), `board ${i}: through a backup`);
  }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
