// The board on screen: two canvases (the drawing, and on top the line being drawn right now) and everything the pen,
// fingers, mouse and trackpad do to them.
//
// Pens and fingers: until a pen has been used here, a finger draws. Once one has, the pen draws and fingers move
// the board, and while the pen is down or close by, every touch is taken for a resting palm and ignored. Two fingers
// always move and zoom; a quick tap with two fingers is Undo, with three, Redo. A pen's eraser end, or its side
// button held down, erases whatever the tool is.
//
// Shapes: the shapes tool drags one out, corner to corner. And any line drawn by hand snaps to a clean straight line,
// triangle, rectangle or ellipse if the pen is held still at the end of it for half a second (moving on afterwards
// carries on drawing as before).
import { makeStroke, nextT, SIZES, shade } from './board.js';
import { outline, weight, toPath2D, touches, bounds, drawBackground, drawBoard, drawStroke, inkLayer, layerFor, laydown, markerMode, fitView } from './ink.js';
import { recognize, dragShape } from './shapes.js';

const MIN_Z = 0.1, MAX_Z = 10;
const clampZ = z => Math.min(MAX_Z, Math.max(MIN_Z, z));
const PALM_AFTER_PEN = 600; // ms a touch is taken for a palm after the pen was last seen
const PALM_SIZE = 48; // CSS px across
const HAND_MS = 1000; // a touch that moved the board this soon before the pen came down (or turned out a palm) was the hand
const TAP_MS = 320, TAP_MOVE = 14, TWO_MOVE = 8; // a tap is quick, and its fingers (and two fingers' spread and middle) stay put
const HOLD_MS = 500, HOLD_MOVE = 5; // holding the pen still this long, within this many CSS px, snaps a shape
const flatten = pts => pts.flatMap(([x, y]) => [x, y, 0.5]);
const pairs = flat => { const out = []; for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1]]); return out; };

export function createSurface(host, opts) {
  const { board, settings, onStroke, onErase, onView, onUndo, onRedo, onPenSeen, onBegin, onEnd, onFingerPan } = opts;
  const main = document.createElement('canvas');
  const live = document.createElement('canvas');
  main.className = 'main';
  live.className = 'live';
  host.append(main, live);
  const mctx = main.getContext('2d', { alpha: false });
  const lctx = live.getContext('2d');

  let w = 0, h = 0, dpr = 1;
  let view = { x: 0, y: 0, z: 1 };
  let act = null;       // what's happening now: { kind: 'draw' | 'erase' | 'pan' | 'pinch', … }
  let hover = null;     // where the eraser circle shows when nothing is pressed
  let lastPen = -Infinity;
  let space = false;
  let tap = null;       // a possible two- or three-finger tap
  const fingers = new Map(); // touch pointers that are down: id -> { x, y, x0, y0 }
  let gesture = null;   // since the first of them landed: { t0, v0 } (when, and the view then)
  let frame = 0, needMain = true, needLive = true;
  let layer = null, snapLayer = null, workLayer = null; // the ink layer, and two more for a rub-out in progress
  let holdTimer = 0;

  const now = () => performance.now();
  const inking = () => act?.kind === 'draw' || act?.kind === 'erase' || act?.kind === 'shape';
  const fingersDraw = () => settings.fingers === 'draw' || (settings.fingers === 'auto' && !settings.penSeen);
  const toBoard = (x, y) => ({ x: view.x + x / view.z, y: view.y + y / view.z });
  function local(e) { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---------- drawing ----------
  function request(mainToo = true) {
    if (mainToo) needMain = true;
    needLive = true;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function paint() {
    frame = 0;
    const b = board();
    if (!b) return;
    if (needMain) {
      needMain = false;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (act?.kind === 'draw' && act.tool === 'rub') paintRub(b);
      else {
        const hidden = act?.kind === 'erase' ? act.gone : null;
        layer = drawBoard(mctx, b, view, w, h, dpr, hidden?.size ? b.strokes.filter(s => !hidden.has(s.id)) : b.strokes, layer);
      }
    }
    if (needLive) { needLive = false; paintLive(b); }
  }
  // A rub-out as it goes: the ink as it was when it started (drawn once), with the rub-out so far cut out of it. After
  // the first frame only the part of the screen where the rub-out's outline changed is drawn again, and exactly as a
  // whole new frame would draw it there.
  function paintRub(b) {
    const poly = act.pts.length ? outline({ tool: 'rub', size: act.size, pts: act.pts }, false) : [];
    const key = [view.x, view.y, view.z, w, h, dpr].join();
    let r = null; // [x, y, w, h] in device pixels, or null for the whole screen
    if (!act.snap || act.snapKey !== key) {
      act.snap = inkLayer(snapLayer = layerFor(main, snapLayer), b.strokes, b.bg, view, w, h, dpr);
      act.snapKey = key;
    } else {
      r = changed(act.poly, poly);
      if (!r) return;
    }
    act.poly = poly;
    workLayer = layerFor(main, workLayer);
    const wc = workLayer.getContext('2d');
    wc.save();
    wc.setTransform(1, 0, 0, 1, 0, 0);
    wc.globalCompositeOperation = 'source-over';
    if (r) {
      wc.clearRect(...r);
      wc.drawImage(act.snap, ...r, ...r);
      wc.beginPath();
      wc.rect(...r);
      wc.clip();
    } else {
      wc.globalCompositeOperation = 'copy';
      wc.drawImage(act.snap, 0, 0);
    }
    if (poly.length) {
      wc.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
      wc.globalCompositeOperation = 'destination-out';
      wc.fill(toPath2D(poly));
    }
    wc.restore();
    mctx.save();
    if (r) { mctx.beginPath(); mctx.rect(r[0] / dpr, r[1] / dpr, r[2] / dpr, r[3] / dpr); mctx.clip(); }
    drawBackground(mctx, b, view, w, h);
    laydown(mctx, workLayer, b.bg, r);
    mctx.restore();
  }
  // Where a rub-out's outline has changed since the last frame, in whole device pixels: its points between the part at
  // the start that's the same and the part at the end that's the same (one more on each side, for the curves through
  // them), last frame's and this one's, and a little room. Null if nothing changed.
  function changed(prev, poly) {
    const n = Math.min(prev.length, poly.length), same = (a, c) => a[0] === c[0] && a[1] === c[1];
    let p = 0, q = 0;
    while (p < n && same(prev[p], poly[p])) p++;
    if (p === prev.length && p === poly.length) return null;
    while (q < n - p && same(prev[prev.length - 1 - q], poly[poly.length - 1 - q])) q++;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const list of [prev, poly]) {
      for (let i = p - 1; i <= list.length - q; i++) {
        const [x, y] = list[(i + list.length) % list.length] || [];
        if (x === undefined) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x0 === Infinity) return null;
    const k = view.z * dpr, W = main.width, H = main.height;
    const ax = Math.max(0, Math.floor((x0 - view.x) * k) - 2), ay = Math.max(0, Math.floor((y0 - view.y) * k) - 2);
    const bx = Math.min(W, Math.ceil((x1 - view.x) * k) + 2), by = Math.min(H, Math.ceil((y1 - view.y) * k) + 2);
    return bx > ax && by > ay ? [ax, ay, bx - ax, by - ay] : null;
  }
  function paintLive(b) {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
    const preview = act?.kind === 'shape' ? shapeOf(act) : act?.snapped ? snappedOf(act) : null;
    if (preview) {
      lctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
      drawStroke(lctx, preview, b.bg);
      lctx.globalCompositeOperation = 'source-over';
      lctx.globalAlpha = 1;
    } else if (act?.kind === 'draw' && act.tool !== 'rub' && act.pts.length) {
      const pts = act.predicted?.length ? act.pts.concat(act.predicted) : act.pts;
      const s = { tool: act.tool, color: act.color, size: act.size, sim: act.sim, pts };
      lctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
      lctx.globalAlpha = act.tool === 'marker' ? markerMode(b.bg).alpha : 1;
      lctx.fillStyle = shade(s, b.bg);
      lctx.fill(toPath2D(outline(s, false)));
      lctx.globalAlpha = 1;
    }
    // (A hover's circle shows only with the eraser in hand, or a pen's eraser, and at the eraser's size now.)
    const ring = act?.kind === 'erase' || act?.tool === 'rub' ? act.at : hover && (settings.tool === 'eraser' || hover.pen) ? hover : null;
    if (ring) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.beginPath();
      lctx.arc(ring.x, ring.y, eraserRadius(ring.size), 0, Math.PI * 2);
      lctx.fillStyle = 'rgba(128, 128, 128, 0.12)';
      lctx.fill();
      lctx.lineWidth = 1.5;
      lctx.strokeStyle = 'rgba(110, 110, 110, 0.75)';
      lctx.stroke();
    }
  }
  const eraserRadius = size => SIZES.eraser[size ?? settings.eraser.size] / 2;

  function resize() {
    const r = host.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const nd = Math.min(3, window.devicePixelRatio || 1);
    if (nw === w && nh === h && nd === dpr) return;
    // Keep the middle of the board in the middle when the screen turns (or the keyboard or split screen resizes it). A
    // line being drawn ends where it had got to, since the rest of it would land somewhere else on the board, and that
    // pen or finger draws nothing more until it lifts. A shape being dragged out is dropped.
    const shift = !!(w && h) && (nw !== w || nh !== h);
    if (shift) {
      if (act?.kind === 'shape') dropInk(); else if (inking()) finishInk();
      view = { x: view.x + (w - nw) / 2 / view.z, y: view.y + (h - nh) / 2 / view.z, z: view.z };
    }
    w = nw; h = nh; dpr = nd;
    for (const c of [main, live]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    request();
    if (shift) onView?.(view, true); // (kept for next time, without showing the zoom)
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // A shape being dragged out with the shapes tool, and a hand-drawn line that has snapped, as strokes to draw.
  function shapeOf(a) {
    const r = dragShape(a.shape, a.a.x, a.a.y, a.b.x, a.b.y);
    return { tool: 'pen', color: a.color, size: a.size, sim: 0, pts: flatten(r.pts), shape: r.shape, fill: a.fill && r.shape === 'closed' ? 1 : 0 };
  }
  function snappedOf(a) {
    return { tool: a.tool, color: a.color, size: weight(a), sim: 0, pts: flatten(a.snapped.pts), shape: a.snapped.shape };
  }

  // ---------- the pen, a finger or the mouse, drawing or erasing ----------
  function startInk(e, erasing) {
    const p = local(e);
    try { host.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    onBegin?.();
    const base = { id: e.pointerId, type: e.pointerType, t0: now(), cx: e.clientX };
    if (erasing && settings.eraser.mode === 'lines') {
      act = { ...base, kind: 'erase', gone: new Set(), last: toBoard(p.x, p.y), at: { ...p, size: settings.eraser.size } };
      eraseTo(p);
    } else if (erasing) {
      // A rub-out is a line too, one that clears what's under it.
      act = { ...base, kind: 'draw', tool: 'rub', sim: 0, color: '', size: SIZES.eraser[settings.eraser.size] / view.z, pts: [], at: { ...p, size: settings.eraser.size } };
      addPoint(e);
      request(true);
    } else if (settings.tool === 'shape') {
      const q = toBoard(p.x, p.y);
      act = { ...base, kind: 'shape', a: q, b: q, shape: settings.shape.kind, fill: settings.shape.fill, color: settings.pen.color, size: SIZES.pen[settings.pen.size] / view.z };
    } else {
      const tool = settings.tool === 'marker' ? 'marker' : 'pen';
      const sim = e.pointerType !== 'pen';
      act = {
        ...base, kind: 'draw', tool, sim, hold: p, snapped: null,
        color: settings[tool].color, size: SIZES[tool][settings[tool].size] / view.z, pts: [], predicted: null,
      };
      addPoint(e);
      armHold();
    }
    hover = null;
    request(false);
  }
  // Held still: if the line so far looks like a shape, it becomes that shape (until the pen moves on).
  function armHold() { clearTimeout(holdTimer); holdTimer = setTimeout(trySnap, HOLD_MS); }
  function trySnap() {
    if (act?.kind !== 'draw' || act.tool === 'rub' || act.snapped) return;
    const r = recognize(pairs(act.pts), 24 / view.z);
    if (!r) return;
    act.snapped = r;
    try { navigator.vibrate?.(8); } catch { /* not on this device */ }
    request(false);
  }
  // A pen's pressure 0 while it's down is its lightest touch, not a missing value: a pen with no pressure reports 0.5
  // while pressed (W3C Pointer Events Level 2, 5.1, the pressure attribute). A stroke that starts at 0 takes the first
  // pressure above it for those first points, so a light line starts as light as it goes on.
  function addPoint(e) {
    const p = local(e), q = toBoard(p.x, p.y);
    let pr = 0.5;
    if (!act.sim && act.tool !== 'rub') {
      pr = Math.max(0.05, Math.min(1, e.pressure || 0));
      if (!(e.pressure > 0) && (!act.pts.length || act.lead)) act.lead = true;
      else if (act.lead) { act.lead = false; for (let i = 2; i < act.pts.length; i += 3) act.pts[i] = pr; }
    }
    const n = act.pts.length;
    if (n >= 3 && Math.abs(act.pts[n - 3] - q.x) < 0.05 / view.z && Math.abs(act.pts[n - 2] - q.y) < 0.05 / view.z) return;
    act.pts.push(q.x, q.y, pr);
  }
  function eraseTo(p) {
    const b = board();
    const q = toBoard(p.x, p.y), r = eraserRadius() / view.z, l = act.last;
    // The rub-outs where the eraser is: a line is taken only where some of it still shows, not for ink they cleared.
    const x0 = Math.min(l.x, q.x) - r, x1 = Math.max(l.x, q.x) + r, y0 = Math.min(l.y, q.y) - r, y1 = Math.max(l.y, q.y) + r;
    const rubs = b.strokes.filter(s => { if (s.tool !== 'rub') return false; const o = bounds(s); return o.x1 >= x0 && o.x0 <= x1 && o.y1 >= y0 && o.y0 <= y1; });
    let hit = false;
    for (const s of b.strokes) {
      if (s.tool === 'rub' || act.gone.has(s.id)) continue; // a rub-out isn't a line to take away
      if (touches(s, l.x, l.y, q.x, q.y, r, rubs)) { act.gone.add(s.id); hit = true; }
    }
    act.last = q;
    act.at = { ...p, size: settings.eraser.size };
    request(hit);
  }
  function finishInk() {
    const a = act;
    act = null;
    clearTimeout(holdTimer);
    // (Each new line goes on top of everything on its board: see nextT in board.js.)
    if (a.kind === 'draw' && a.snapped) onStroke(makeStroke(snappedOf(a), nextT(board())));
    else if (a.kind === 'draw' && a.pts.length && (a.tool !== 'rub' || rubbed(a))) onStroke(makeStroke(a, nextT(board())));
    else if (a.kind === 'erase' && a.gone.size) onErase([...a.gone]);
    else if (a.kind === 'shape' && Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * view.z >= 4) onStroke(makeStroke(shapeOf(a), nextT(board())));
    request(true);
    onEnd?.();
  }
  // Did a rub-out go over any ink that shows? One that didn't is let go: kept, it would be an Undo step that changes
  // nothing on screen, and the board would no longer count as empty.
  function rubbed(a) {
    const b = board(), p = a.pts, r = a.size / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    const near = s => { const o = bounds(s); return o.x1 >= x0 - r && o.x0 <= x1 + r && o.y1 >= y0 - r && o.y0 <= y1 + r; };
    const rubs = b.strokes.filter(s => s.tool === 'rub' && near(s));
    for (const s of b.strokes) {
      if (s.tool === 'rub' || !near(s)) continue;
      if (p.length === 3 && touches(s, p[0], p[1], p[0], p[1], r, rubs)) return true;
      for (let i = 3; i < p.length; i += 3) if (touches(s, p[i - 3], p[i - 2], p[i], p[i + 1], r, rubs)) return true;
    }
    return false;
  }
  function dropInk() { act = null; clearTimeout(holdTimer); request(true); onEnd?.(); }

  // ---------- moving and zooming ----------
  // A line being drawn when the board moves under it (the wheel, a zoom key, Show it all) ends where it had got to, as
  // when the screen turns (see resize()): the rest of it would land somewhere else on the board. (Opening a board moves
  // it quietly, and stops what was going on first.)
  function setView(v, quiet) {
    const next = { x: v.x, y: v.y, z: clampZ(v.z) };
    if (!quiet && inking() && (next.x !== view.x || next.y !== view.y || next.z !== view.z)) {
      if (act.kind === 'shape') dropInk(); else finishInk();
    }
    view = next;
    request();
    if (!quiet) onView?.(view);
  }
  function zoomAt(px, py, z) {
    const q = toBoard(px, py), nz = clampZ(z);
    setView({ x: q.x - px / nz, y: q.y - py / nz, z: nz });
  }
  function startPan(e, p = local(e)) {
    try { host.setPointerCapture(e.pointerId); } catch { /* fine */ }
    act = { kind: 'pan', id: e.pointerId, type: e.pointerType, sx: p.x, sy: p.y, v0: { ...view }, moved: false };
  }
  // How far apart two fingers are and where their middle is: the first two down, or the two given (if still down).
  function spread(ids = [...fingers.keys()].slice(0, 2)) {
    const [a, b] = ids.map(id => fingers.get(id));
    if (!a || !b) return null;
    return { ids, d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function startPinch() {
    const [a, b] = [...fingers.values()];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    act = { kind: 'pinch', m0: m, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), v0: { ...view } };
  }
  function pinchMove() {
    const [a, b] = [...fingers.values()];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const { v0, m0, d0 } = act;
    const z = clampZ(v0.z * d / d0);
    const qx = v0.x + m0.x / v0.z, qy = v0.y + m0.y / v0.z;
    setView({ x: qx - m.x / z, y: qy - m.y / z, z });
    // Pinched past the closest or the farthest zoom: the pinch starts again from here, so pinching back zooms back at
    // once, not only once the fingers are back where the limit was reached.
    if (z !== v0.z * d / d0) act = { ...act, m0: m, d0: d, v0: { ...view } };
  }

  // Fingers moving the board, begun under a second ago.
  const handMoved = () => (act?.kind === 'pinch' || (act?.kind === 'pan' && act.type === 'touch')) && gesture && now() - gesture.t0 < HAND_MS;
  // A touch that turned out to be a palm: forgotten, and the board it was moving goes back (if it only just started).
  function palm(id) {
    if (handMoved() && (act.kind === 'pinch' || act.id === id)) setView(gesture.v0);
    if (act?.kind === 'pinch' || act?.id === id) act = null;
    fingers.delete(id);
    tap = null;
    if (!fingers.size) gesture = null;
  }

  // ---------- pointer events ----------
  // The pen coming down: it draws (or rubs out), and the touches there were are the hand.
  function penDown(e, erasing) {
    if (inking()) dropInk(); // a palm got there first
    // A touch that was moving the board just before the pen came down was the hand: the board goes back.
    else if (handMoved()) setView(gesture.v0);
    // (After a palm's line is dropped, so that line ending doesn't say a pen was found while the pen is still down.)
    if (!settings.penSeen) { settings.penSeen = true; onPenSeen?.(); }
    act = null;
    fingers.clear();
    tap = null;
    gesture = null;
    startInk(e, erasing);
    // (A rub-out made with the side button held ends when the tip lifts, though the button stays down: see move().)
    if (act && e.buttons & 2) act.barrel = true;
  }
  function down(e) {
    const p = local(e);
    if (e.pointerType === 'pen') {
      lastPen = now();
      // The same pen coming down again while its last line is still going: that line's lift was missed, so it ends here.
      if (act && act.type === 'pen' && act.id === e.pointerId && inking()) finishInk();
      if (act && act.type === 'pen') return;
      // The side button pressed with the pen in the air: a pen's pointerdown comes for that too (W3C Pointer Events
      // Level 3, 4.2.3, "The pointerdown event"), but nothing has touched the board. It's a hover, with the eraser's
      // circle where it would rub; the rub-out starts when the tip touches (see move()).
      if (e.buttons === 2 && !(e.pressure > 0)) { move(e); return; }
      penDown(e, !!(settings.tool === 'eraser' || (e.buttons & 32) || e.button === 5 || (e.buttons & 2)));
      return;
    }
    if (e.pointerType === 'touch') {
      if (act?.type === 'pen' || now() - lastPen < PALM_AFTER_PEN) return;
      // Once there's a pen, a touch far bigger than a fingertip is the side of a hand.
      if (settings.penSeen && settings.fingers !== 'draw' && Math.max(e.width || 0, e.height || 0) > PALM_SIZE) return;
      fingers.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y });
      if (fingers.size === 1) {
        gesture = { t0: now(), v0: { ...view } };
        tap = { n: 1, t0: now(), moved: false };
        if (fingersDraw()) startInk(e, settings.tool === 'eraser'); else startPan(e, p);
      } else {
        if (tap) tap.n = now() - tap.t0 < 250 ? Math.max(tap.n, fingers.size) : 0;
        if (tap && fingers.size === 2) tap.two = spread();
        if (inking()) {
          // A second finger soon after the first: it was the start of a pinch, not a line.
          if (now() - act.t0 < 300) dropInk(); else finishInk();
        }
        if (fingers.size === 2 || act?.kind !== 'pinch') startPinch();
      }
      return;
    }
    // A mouse: the left button draws, the middle or right button (or Space held down) moves the board.
    if (act) return;
    if (e.button === 1 || e.button === 2 || space) { e.preventDefault(); startPan(e, p); }
    else if (e.button === 0) startInk(e, settings.tool === 'eraser');
  }

  function move(e) {
    const p = local(e);
    if (e.pointerType === 'pen') {
      lastPen = now();
      // The pen close by (hovering, or down) while fingers move the board: they're the hand, ignored from here on as
      // touches are while the pen is close, and a board they only just started moving goes back.
      if (act?.kind === 'pinch' || (act?.kind === 'pan' && act.type === 'touch')) {
        if (handMoved()) setView(gesture.v0);
        act = null;
        fingers.clear();
        tap = null;
        gesture = null;
      }
      const tip = !!(e.buttons & 1) || e.pressure > 0;
      // The tip touching with the side button already held (a move, since a button was down already): a rub-out.
      if (tip && e.buttons & 2 && act?.type !== 'pen') { penDown(e, true); return; }
      // The tip lifting with the side button still held: the rub-out ends there, as at a lift.
      if (!tip && act?.barrel && act.id === e.pointerId && inking()) finishInk();
    }
    // Where each finger is, kept up to date even while it draws, so a pinch that starts after a line starts from where
    // the fingers really are.
    const f = e.pointerType === 'touch' && fingers.get(e.pointerId);
    if (f) {
      f.x = p.x; f.y = p.y;
      if (tap && Math.hypot(f.x - f.x0, f.y - f.y0) > TAP_MOVE) tap.moved = true;
      // Two fingers that have visibly zoomed or moved the board weren't tapping, however little each one moved.
      const two = tap?.two, now2 = two && spread(two.ids);
      if (now2 && (Math.abs(now2.d - two.d) > TWO_MOVE || Math.hypot(now2.m.x - two.m.x, now2.m.y - two.m.y) > TWO_MOVE)) tap.moved = true;
    }
    if (act && act.id === e.pointerId && inking()) {
      const events = e.getCoalescedEvents?.() || [];
      const list = events.length ? events : [e];
      if (act.kind === 'shape') {
        act.b = toBoard(p.x, p.y);
        request(false);
      } else if (act.kind === 'draw') {
        for (const ce of list) addPoint(ce);
        if (act.tool === 'rub') { act.at = { ...p, size: settings.eraser.size }; request(true); return; }
        const pred = e.getPredictedEvents?.() || [];
        act.predicted = pred.length && !act.snapped ? pred.slice(0, 2).flatMap(pe => { const q = local(pe), b = toBoard(q.x, q.y); return [b.x, b.y, act.pts[act.pts.length - 1]]; }) : null;
        // Moving: not holding still. A snapped shape lets go once the pen moves on properly.
        const moved = Math.hypot(p.x - act.hold.x, p.y - act.hold.y);
        if (moved > (act.snapped ? HOLD_MOVE * 3 : HOLD_MOVE)) { act.snapped = null; act.hold = p; armHold(); }
        request(false);
      } else {
        for (const ce of list) eraseTo(local(ce));
      }
      return;
    }
    if (f) {
      // A touch that spreads out past a fingertip, once there's a pen, was the side of a hand after all.
      if (settings.penSeen && settings.fingers !== 'draw' && Math.max(e.width || 0, e.height || 0) > PALM_SIZE) { palm(e.pointerId); return; }
      if (act?.kind === 'pinch' && fingers.size >= 2) pinchMove();
      else if (act?.kind === 'pan' && act.id === e.pointerId) {
        setView({ x: act.v0.x - (p.x - act.sx) / view.z, y: act.v0.y - (p.y - act.sy) / view.z, z: view.z });
        if (act.moved === false && Math.hypot(p.x - act.sx, p.y - act.sy) > TAP_MOVE) act.moved = true;
      }
      return;
    }
    if (act?.kind === 'pan' && act.id === e.pointerId) {
      setView({ x: act.v0.x - (p.x - act.sx) / view.z, y: act.v0.y - (p.y - act.sy) / view.z, z: view.z });
      return;
    }
    // Hovering: the eraser shows where it would rub.
    const penEraser = e.pointerType === 'pen' && !!(e.buttons & (32 | 2)); // (its eraser end, or its side button)
    // (the ring is the eraser's size, rubbing out or taking whole lines)
    if (!act && e.pointerType !== 'touch' && (settings.tool === 'eraser' || penEraser)) { hover = { ...p, pen: penEraser }; request(false); }
    else if (hover) { hover = null; request(false); }
  }

  // A finger line the system took away (pointercancel) that was a slip: one only just begun, or begun at the screen's
  // side, where Android's Back gesture starts (how wide that edge is depends on its Back sensitivity setting) and a
  // Back follows. Any other is kept: Android takes touches for other things too (a notification pulled down, say), and
  // a line kept by mistake can be undone, while one dropped can't be got back.
  const slip = a => now() - a.t0 < 300 || a.cx < 40 || a.cx > innerWidth - 40;
  function up(e, cancelled) {
    if (act && act.id === e.pointerId && inking()) {
      if (e.pointerType === 'pen') lastPen = now();
      if (cancelled && e.pointerType === 'touch' && slip(act)) dropInk(); else finishInk();
    } else if (act?.kind === 'pan' && act.id === e.pointerId && e.pointerType !== 'touch') {
      act = null;
    }
    if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
    fingers.delete(e.pointerId);
    if (act?.kind === 'pinch' && fingers.size === 1) {
      // Back to one finger: carry on moving the board with it, from where it is now.
      const [[id, f]] = [...fingers.entries()];
      act = { kind: 'pan', id, type: 'touch', sx: f.x, sy: f.y, v0: { ...view } };
    } else if (act?.kind === 'pinch' && fingers.size >= 2) {
      startPinch();
    }
    if (!fingers.size) {
      gesture = null;
      // One finger on its own moved the board (and it stayed moved): the page may want to say why a finger didn't draw.
      if (act?.kind === 'pan' && act.moved) onFingerPan?.();
      if (act?.kind === 'pan' || act?.kind === 'pinch') act = null;
      if (tap && !tap.moved && !cancelled && now() - tap.t0 < TAP_MS) {
        if (tap.n === 2) onUndo?.(); else if (tap.n === 3) onRedo?.();
      }
      tap = null;
    }
  }

  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', e => up(e, false));
  host.addEventListener('pointercancel', e => up(e, true));
  // A pen or the mouse that loses its hold on the board (its lift may never come here) ends what it was doing.
  host.addEventListener('lostpointercapture', e => { if (e.pointerType !== 'touch' && act && act.id === e.pointerId) up(e, false); });
  host.addEventListener('pointerleave', e => { if (hover && e.pointerType !== 'touch') { hover = null; request(false); } });
  host.addEventListener('contextmenu', e => e.preventDefault());
  // Safari's own pinch-zoom of the page, which would zoom the toolbar along with the board.
  for (const g of ['gesturestart', 'gesturechange']) document.addEventListener(g, e => e.preventDefault(), { passive: false });

  // A trackpad or a mouse wheel: scroll moves the board; pinching the trackpad (or Ctrl + wheel) zooms.
  host.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1;
    const p = local(e);
    // (A mouse wheel's notch is about 100 px, so each step is capped at about 1.28 times, like Ctrl + = and Ctrl + −;
    // a trackpad pinch sends small steps, which are as they were.)
    if (e.ctrlKey || e.metaKey) zoomAt(p.x, p.y, view.z * Math.exp(-Math.max(-25, Math.min(25, e.deltaY * k)) * 0.01));
    else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      setView({ x: view.x + dx * k / view.z, y: view.y + dy * k / view.z, z: view.z });
    }
  }, { passive: false });

  return {
    canvas: main,
    get view() { return { ...view }; },
    get busy() { return !!act; },
    get inking() { return inking(); },
    get size() { return { w, h }; },
    setSpace(on) { space = on; },
    setView,
    redraw() { if (act?.snap) act.snap = null; request(true); }, // (all of it, a rub-out in progress included)
    // Back to 100%, keeping the middle of the screen where it is.
    zoomTo(z) { zoomAt(w / 2, h / 2, z); },
    zoomBy(k) { zoomAt(w / 2, h / 2, view.z * k); },
    fit() { const b = board(); setView(b.strokes.length ? fitView(b, w, h, Math.min(w, h) * 0.08, 2) : { x: 0, y: 0, z: 1 }); },
    // Stop whatever's in progress, without keeping it (opening another board, say).
    cancel() { act = null; clearTimeout(holdTimer); fingers.clear(); tap = null; gesture = null; request(true); },
  };
}
