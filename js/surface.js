// The board on screen: two canvases (the drawing, and on top the line being drawn right now) and everything the pen,
// fingers, mouse and trackpad do to them.
//
// Pens and fingers: until a pen has been used here, a finger draws. Once one has, the pen draws and fingers move
// the board, and while the pen is down or close by, every touch is taken for a resting palm and ignored. Two fingers
// always move and zoom; a quick tap with two fingers is Undo, with three, Redo. A pen's eraser end, or its side
// button held down, erases whatever the tool is. And once a pen has been used, a touch much bigger than a fingertip is
// the side of a hand, whatever Fingers is set to: it never draws or moves the board.
//
// Shapes: the shapes tool drags one out, corner to corner (a box or an ellipse nearly square comes out square or round,
// and Shift makes it so with a mouse). And any line drawn by hand snaps to a clean straight line,
// triangle, rectangle or ellipse if the pen is held still at the end of it for half a second (moving on afterwards
// carries on drawing as before).
//
// The lasso: what the pen (or a finger that draws, or the mouse) draws with it is a loop, and the lines inside it are
// picked up, in a dashed box. Dragged, the box moves them; dragged by its corner, it makes them bigger or smaller. While
// they move, the board is drawn without them and they go along on top, as they are, and they're put down (one change,
// made by the page: see onPlace) when the pen lifts. A tap outside the box puts them down where they are; with nothing
// picked up, a tap on a photo picks up just the photo.
//
// The pointer, for presenting: while it's on, what the pen (or a finger that draws, or the mouse) draws is a red trail
// that fades away a second after it lifts. It's never a stroke: never kept, synced or undone. A pen's eraser end, or
// its side button, still erases.
import { makeStroke, nextT, SIZES, shade, BACKGROUNDS } from './board.js';
import { outline, weight, toPath2D, touches, bounds, drawUnder, drawPhotos, drawBoard, drawStroke, drawStrokes, inkLayer, layerFor, laydown, fitView, onPhoto } from './ink.js';
import { recognize, dragShape } from './shapes.js';
import { pick, tapPick, pickedBounds, pickedStrokes } from './lasso.js';

const MIN_Z = 0.1, MAX_Z = 10;
const clampZ = z => Math.min(MAX_Z, Math.max(MIN_Z, z));
const PALM_AFTER_PEN = 600; // ms a touch is taken for a palm after the pen was last seen
const PALM_SIZE = 48; // CSS px across
const HAND_MS = 1000; // a touch that moved the board this soon before the pen came down (or turned out a palm) was the hand
const TAP_MS = 320, TAP_MOVE = 14, TWO_MOVE = 8; // a tap is quick, and its fingers (and two fingers' spread and middle) stay put
const HOLD_MS = 500, HOLD_MOVE = 5; // holding the pen still this long, within this many CSS px, snaps a shape
const TRAIL_HOLD = 400, TRAIL_FADE = 600; // ms a pointer's trail stays after the lift, then takes to fade away
const GRIP = 22, BOX_PAD = 10; // CSS px: how near the box's corner a touch takes it by the corner, and the box's margin
const MIN_K = 0.1, MAX_K = 10; // the smallest and biggest a resize makes them at once
const EASE_MS = 180; // Show it all, back to 100% and Ctrl + = and − ease into place over about a fifth of a second
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const flatten = pts => pts.flatMap(([x, y]) => [x, y, 0.5]);
const pairs = flat => { const out = []; for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1]]); return out; };

export function createSurface(host, opts) {
  const { board, settings, onStroke, onErase, onView, onUndo, onRedo, onPenSeen, onBegin, onEnd, onFingerPan, onPlace, onSelect } = opts;
  const main = document.createElement('canvas');
  const live = document.createElement('canvas');
  main.className = 'main';
  live.className = 'live';
  host.append(main, live);
  const mctx = main.getContext('2d', { alpha: false });
  // The line being drawn goes straight to the screen where the browser can (Chrome and Edge: Chrome for Developers,
  // 'Low-latency rendering with the desynchronized hint'), so the ink keeps closer behind the pen; elsewhere it's an
  // ordinary canvas. Clearing a canvas that goes straight to the screen can flicker, so there each frame is drawn on
  // another canvas first and copied on in one go (the same article, 'Avoiding flicker').
  const sctx = live.getContext('2d', { desynchronized: true });
  const buffered = !!sctx.getContextAttributes?.().desynchronized;
  let lctx = sctx, liveBuf = null;

  let w = 0, h = 0, dpr = 1;
  let view = { x: 0, y: 0, z: 1 };
  let act = null;       // what's happening now: { kind: 'draw' | 'erase' | 'pan' | 'pinch', … }
  let hover = null;     // where the eraser circle shows when nothing is pressed
  let lastPen = -Infinity;
  let space = false;
  let tap = null;       // a possible two- or three-finger tap
  const fingers = new Map(); // touch pointers that are down: id -> { x, y, x0, y0 }
  let gesture = null;   // since the first of them landed: { t0, v0 } (when, and the view then)
  let frame = 0, needMain = true, needLive = true, wholeMain = true;
  let layer = null, snapLayer = null, workLayer = null; // the ink layer, and two more for a rub-out in progress
  let shown = null;     // what the ink layer holds: { look: the board and its look, view, strokes: those drawn }
  let slid = false;     // the screen shows the ink layer slid to another view (see slide)
  let wheeling = false, wheelTimer = 0; // a trackpad or wheel is moving the board, and hasn't stopped for a moment
  let rubArea = null;   // where a rub-out as it goes has cut into the ink on screen, outside the layer: { x0, y0, x1, y1 }
  let holdTimer = 0;
  let pointing = false;  // the pointer is on
  let ease = null;       // the board easing into place: { from, to, t0, frame }
  const trails = [];     // its trails on screen: { pts: [x, y, …] on the board, end: when it lifted, or 0 }
  let sel = null;        // the lines the lasso has picked up: { ids, box: what shows of them on the board }
  let selShown = '';     // where the box was last said to be (see onSelect)

  const now = () => performance.now();
  const inking = () => act?.kind === 'draw' || act?.kind === 'erase' || act?.kind === 'shape' || act?.kind === 'point' || act?.kind === 'loop' || act?.kind === 'lift';
  const fingersDraw = () => settings.fingers === 'draw' || (settings.fingers === 'auto' && !settings.penSeen);
  const toBoard = (x, y) => ({ x: view.x + x / view.z, y: view.y + y / view.z });
  function local(e) { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---------- drawing ----------
  // (whole: draw all of the board again, not just what's new on it)
  function request(mainToo = true, whole = false) {
    if (mainToo) needMain = true;
    if (whole) wholeMain = true;
    needLive = true;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  // Fingers, the mouse, a trackpad or a wheel moving or zooming the board, or the board easing into place.
  const moving = () => act?.kind === 'pinch' || act?.kind === 'pan' || wheeling || !!ease;
  function paint() {
    frame = 0;
    const b = board();
    if (!b) return;
    if (slid && !moving()) needMain = true;
    if (needMain) {
      needMain = false;
      const whole = wholeMain;
      wholeMain = false;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (act?.kind === 'draw' && act.tool === 'rub') paintRub(b);
      else paintMain(b, whole);
    }
    if (needLive) { needLive = false; paintLive(b); }
    told();
  }
  // The board and its ink. When the board is as last drawn with only new strokes on top of it (the line the pen has
  // just drawn, or one from another device), and the view and look are the same, only the new strokes are drawn: on a
  // big board, drawing every line again at each lift kept the next line waiting. Otherwise the whole board.
  //
  // While the board is being moved or zoomed and nothing on it has changed, the ink as last drawn slides and scales
  // with it as a picture, over the board's colour and lines drawn afresh: what comes into view at the edges is blank
  // until the board stops, and then the whole board is drawn. Drawing every line at each step of a pinch made it
  // jerky on a big board.
  function paintMain(b, whole) {
    const look = [b.id, b.bg, b.pattern, w, h, dpr].join();
    const hidden = act?.kind === 'erase' && act.gone.size ? act.gone : act?.kind === 'lift' && act.moved && sel ? new Set(sel.ids) : null;
    const same = !whole && !hidden && shown?.look === look, more = same ? added(b.strokes) : null;
    const still = same && shown.view.x === view.x && shown.view.y === view.y && shown.view.z === view.z;
    if (more && !more.length && moving() && (slid || !still)) slide(b);
    // (On the slate a rub-out paints back the board, which is drawn only with the whole: see inkLayer in ink.js.)
    // (A photo goes under the ink, and a rub-out in a group cuts only its group's lines: both need the whole drawn.)
    else if (more && still && !slid && !more.some(s => s.tool === 'photo' || (s.tool === 'rub' && s.grp)) && !(BACKGROUNDS[b.bg]?.dark && more.some(s => s.tool === 'rub'))) addInk(b, more);
    else {
      layer = drawBoard(mctx, b, view, w, h, dpr, hidden ? b.strokes.filter(s => !hidden.has(s.id)) : b.strokes, layer);
      shown = hidden ? null : { look, view: { ...view }, strokes: b.strokes.slice() };
      slid = false;
    }
    rubArea = null;
  }
  function slide(b) {
    const v = shown.view, k = view.z / v.z;
    drawUnder(mctx, b, view, w, h, dpr);
    mctx.save();
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = BACKGROUNDS[b.bg]?.dark ? 'source-over' : 'multiply';
    mctx.drawImage(layer, (v.x - view.x) * view.z * dpr, (v.y - view.y) * view.z * dpr, layer.width * k, layer.height * k);
    mctx.restore();
    slid = true;
  }
  // The strokes after the ones drawn, if those are still the board's first strokes, in order (strokes never change once
  // made); otherwise null.
  function added(strokes) {
    const was = shown.strokes;
    if (strokes.length < was.length) return null;
    for (let i = 0; i < was.length; i++) if (strokes[i] !== was[i]) return null;
    return strokes.slice(was.length);
  }
  // New strokes on top: drawn into the ink layer after the rest, as a whole frame draws them, then the part of the
  // screen they cover laid down again (and where a rub-out as it went cut into the ink, whether it was kept or not), so
  // it comes out exactly as a whole frame would.
  function addInk(b, list) {
    shown.strokes.push(...list);
    let { x0, y0, x1, y1 } = rubArea || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const s of list) { const o = bounds(s); x0 = Math.min(x0, o.x0); y0 = Math.min(y0, o.y0); x1 = Math.max(x1, o.x1); y1 = Math.max(y1, o.y1); }
    const k = view.z * dpr;
    const ax = Math.max(0, Math.floor((x0 - view.x) * k) - 2), ay = Math.max(0, Math.floor((y0 - view.y) * k) - 2);
    const bx = Math.min(main.width, Math.ceil((x1 - view.x) * k) + 2), by = Math.min(main.height, Math.ceil((y1 - view.y) * k) + 2);
    if (bx <= ax || by <= ay) return; // (all of it off screen)
    if (list.length) drawStrokes(layer.getContext('2d'), list, b.bg, view, w, h, dpr);
    const r = [ax, ay, bx - ax, by - ay];
    mctx.save();
    mctx.beginPath();
    mctx.rect(r[0] / dpr, r[1] / dpr, r[2] / dpr, r[3] / dpr);
    mctx.clip();
    drawUnder(mctx, b, view, w, h, dpr);
    laydown(mctx, layer, b.bg, r);
    mctx.restore();
  }
  // A rub-out as it goes: the ink as it was when it started (drawn once), with the rub-out so far cut out of it. After
  // the first frame only the part of the screen where the rub-out's outline changed is drawn again, and exactly as a
  // whole new frame would draw it there.
  function paintRub(b) {
    const poly = act.pts.length ? outline({ tool: 'rub', size: act.size, pts: act.pts }, false) : [];
    const key = [view.x, view.y, view.z, w, h, dpr].join();
    let r = null; // [x, y, w, h] in device pixels, or null for the whole screen
    if (!act.snap || act.snapKey !== key) {
      // (On the slate the ink layer starts from the board: see inkLayer in ink.js.)
      const dark = BACKGROUNDS[b.bg]?.dark;
      if (dark) drawUnder(mctx, b, view, w, h, dpr);
      act.snap = inkLayer(snapLayer = layerFor(main, snapLayer), b.strokes, b.bg, view, w, h, dpr, dark ? main : null);
      act.snapKey = key;
    } else {
      r = changed(act.poly, poly);
      if (!r) return;
    }
    act.poly = poly;
    for (const [x, y] of poly) {
      rubArea ||= { x0: x, y0: y, x1: x, y1: y };
      if (x < rubArea.x0) rubArea.x0 = x; if (x > rubArea.x1) rubArea.x1 = x; if (y < rubArea.y0) rubArea.y0 = y; if (y > rubArea.y1) rubArea.y1 = y;
    }
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
    // (A rub-out clears only ink: the photos under it show through.)
    drawUnder(mctx, b, view, w, h, dpr);
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
    if (buffered) lctx = (liveBuf = layerFor(live, liveBuf)).getContext('2d');
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
      // (A highlighter is multiplied or screened onto the board below as it goes: see .live in css/app.css.)
      lctx.fillStyle = shade(s, b.bg);
      lctx.fill(toPath2D(outline(s, false)));
    }
    paintLasso(b);
    // (A hover's circle shows only with the eraser in hand, or a pen's eraser, and at the eraser's size now.)
    paintTrails(b);
    const ring = act?.kind === 'erase' || act?.tool === 'rub' ? act.at : hover && ((settings.tool === 'eraser' && !pointing) || hover.pen) ? hover : null;
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
    if (buffered) {
      sctx.globalCompositeOperation = 'copy';
      sctx.drawImage(liveBuf, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
    }
  }
  // The pointer's trails: a red line, the same width on screen at any zoom, with a soft glow round it. One that has
  // lifted stays a moment, then fades, and is gone a second after the lift.
  function paintTrails(b) {
    const t = now();
    for (let i = trails.length - 1; i >= 0; i--) if (trails[i].end && t - trails[i].end >= TRAIL_HOLD + TRAIL_FADE) trails.splice(i, 1);
    if (!trails.length) return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';
    const red = shade({ tool: 'pen', color: 'red' }, b.bg);
    for (const tr of trails) {
      const a = tr.end ? Math.max(0, Math.min(1, 1 - (t - tr.end - TRAIL_HOLD) / TRAIL_FADE)) : 1;
      if (!a || !tr.pts.length) continue;
      const line = new Path2D();
      for (let i = 0; i < tr.pts.length; i += 2) {
        const x = (tr.pts[i] - view.x) * view.z, y = (tr.pts[i + 1] - view.y) * view.z;
        if (i) line.lineTo(x, y); else { line.moveTo(x, y); line.lineTo(x + 0.01, y); }
      }
      lctx.strokeStyle = red;
      lctx.globalAlpha = a * 0.25;
      lctx.lineWidth = 11;
      lctx.stroke(line);
      lctx.globalAlpha = a;
      lctx.lineWidth = 4;
      lctx.stroke(line);
    }
    lctx.globalAlpha = 1;
    if (trails.some(tr => tr.end)) request(false); // (fading: the next frame too)
  }
  const eraserRadius = size => SIZES.eraser[size ?? settings.eraser.size] / 2;

  // ---------- the lasso ----------
  // The loop as it's drawn, a dashed line closing back to its start; the box round what's picked up, with its corner to
  // resize by; and while they move, the lines themselves, moved or resized (drawn as they are, through a view that does
  // the moving: see lifted).
  function paintLasso(b) {
    const ink = BACKGROUNDS[b.bg]?.dark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(30, 40, 50, 0.8)';
    const accent = BACKGROUNDS[b.bg]?.dark ? '#84b3ff' : '#2160d4';
    if (act?.kind === 'loop' && act.pts.length >= 4) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
      lctx.beginPath();
      for (let i = 0; i < act.pts.length; i += 2) {
        const x = (act.pts[i] - view.x) * view.z, y = (act.pts[i + 1] - view.y) * view.z;
        if (i) lctx.lineTo(x, y); else lctx.moveTo(x, y);
      }
      lctx.closePath();
      lctx.fillStyle = BACKGROUNDS[b.bg]?.dark ? 'rgba(132, 179, 255, 0.10)' : 'rgba(33, 96, 212, 0.07)';
      lctx.fill();
      lctx.setLineDash([6, 5]);
      lctx.lineWidth = 1.5;
      lctx.strokeStyle = ink;
      lctx.stroke();
      lctx.setLineDash([]);
    }
    if (!sel) return;
    const lifting = act?.kind === 'lift' && act.moved;
    if (lifting) {
      const v = lifted(act.tf);
      lctx.save();
      drawPhotos(lctx, b, act.items, v, w, h, dpr);
      drawStrokes(lctx, act.items, b.bg, v, w, h, dpr);
      lctx.restore();
      lctx.globalCompositeOperation = 'source-over';
      lctx.globalAlpha = 1;
    }
    const r = boxOnScreen(lifting ? act.tf : null);
    if (!r) return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.setLineDash([6, 5]);
    lctx.lineWidth = 1.5;
    lctx.strokeStyle = accent;
    lctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    lctx.setLineDash([]);
    lctx.beginPath();
    lctx.arc(r.x + r.w, r.y + r.h, 7, 0, Math.PI * 2);
    lctx.fillStyle = '#ffffff';
    lctx.fill();
    lctx.lineWidth = 2;
    lctx.strokeStyle = accent;
    lctx.stroke();
  }
  // The box round what's picked up, on screen (CSS px, with its margin), moved by tf if they're being moved.
  function boxOnScreen(tf = null) {
    if (!sel?.box) return null;
    let { x0, y0, x1, y1 } = sel.box;
    if (tf) [x0, y0, x1, y1] = [tf.ox + (x0 - tf.ox) * tf.k + tf.dx, tf.oy + (y0 - tf.oy) * tf.k + tf.dy, tf.ox + (x1 - tf.ox) * tf.k + tf.dx, tf.oy + (y1 - tf.oy) * tf.k + tf.dy];
    const x = (x0 - view.x) * view.z - BOX_PAD, y = (y0 - view.y) * view.z - BOX_PAD;
    return { x, y, w: (x1 - x0) * view.z + 2 * BOX_PAD, h: (y1 - y0) * view.z + 2 * BOX_PAD };
  }
  // The view that draws the lines moved by tf (each point (x, y) to (ox + (x - ox) * k + dx, …)) where they'd be.
  function lifted(tf) {
    const z = view.z * tf.k;
    return { x: (view.x - tf.ox * (1 - tf.k) - tf.dx) / tf.k, y: (view.y - tf.oy * (1 - tf.k) - tf.dy) / tf.k, z };
  }
  // Where a pen, finger or mouse at p (CSS px) is on the box: 'corner', 'box' or null.
  function onBox(p) {
    const r = boxOnScreen();
    if (!r) return null;
    if (Math.hypot(p.x - r.x - r.w, p.y - r.y - r.h) <= GRIP) return 'corner';
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h ? 'box' : null;
  }
  // The page hears where the box is on screen whenever that changes (to put its buttons by it), and null while there's
  // none, or while it moves.
  function told() {
    const r = act?.kind === 'lift' && act.moved ? null : boxOnScreen();
    const key = r ? [r.x, r.y, r.w, r.h].map(Math.round).join() : '';
    if (key === selShown) return;
    selShown = key;
    onSelect?.(r);
  }
  function select(ids) {
    const b = board();
    const box = ids?.length && b ? pickedBounds(b, ids) : null;
    sel = box ? { ids: [...ids], box } : null;
    request(false);
  }
  // The board changed under them (undo, another device): what's left of them stays picked up.
  function reselect() {
    if (!sel) return;
    const b = board(), have = new Set(b?.strokes.map(s => s.id));
    const ids = sel.ids.filter(id => have.has(id));
    if (ids.length !== sel.ids.length || ids.length) select(ids);
  }
  function startLasso(e, p, base) {
    const where = sel && onBox(p);
    if (where) {
      const q = toBoard(p.x, p.y), { x0, y0, x1, y1 } = sel.box;
      act = { ...base, kind: 'lift', corner: where === 'corner', from: q, moved: false, tf: { dx: 0, dy: 0, k: 1, ox: x0, oy: y0 }, far: { x: x1, y: y1 }, sp: p };
      return;
    }
    // (A tap that puts down what was picked up only puts it down: see endLasso.)
    const dropped = !!sel;
    if (sel) select(null);
    const q = toBoard(p.x, p.y);
    act = { ...base, kind: 'loop', pts: [q.x, q.y], sp: p, dropped };
  }
  function moveLasso(p, list) {
    if (act.kind === 'loop') {
      for (const ce of list) { const q = local(ce), r = toBoard(q.x, q.y); act.pts.push(r.x, r.y); }
      request(false);
      return;
    }
    const q = toBoard(p.x, p.y);
    if (!act.moved && Math.hypot(p.x - act.sp.x, p.y - act.sp.y) < 3) return;
    if (!act.moved) { act.moved = true; act.items = pickedStrokes(board(), sel.ids); host.classList.add('lifting'); request(true); }
    if (act.corner) {
      // Bigger or smaller about the opposite corner, by how far along the box's diagonal the corner has been taken.
      const { ox, oy } = act.tf, span = act.far.x - ox + (act.far.y - oy);
      act.tf = { ...act.tf, k: Math.min(MAX_K, Math.max(MIN_K, span > 0 ? (q.x - ox + (q.y - oy)) / span : 1)) };
    } else act.tf = { ...act.tf, dx: q.x - act.from.x, dy: q.y - act.from.y };
    request(false);
  }

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
      stopEase();
      if (act?.kind === 'shape' || act?.kind === 'lift') dropInk(); else if (inking()) finishInk();
      view = { x: view.x + (w - nw) / 2 / view.z, y: view.y + (h - nh) / 2 / view.z, z: view.z };
    }
    w = nw; h = nh; dpr = nd;
    for (const c of [main, live]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    request();
    if (shift) onView?.(view, true); // (kept for next time, without showing the zoom)
  }
  new ResizeObserver(resize).observe(host);
  // (A photo's picture decoded: drawn in.)
  onPhoto(() => request(true, true));
  // (A canvas whose memory the browser took back comes back blank.)
  main.addEventListener('contextrestored', () => { shown = null; slid = false; request(true, true); });
  resize();

  // A shape being dragged out with the shapes tool, and a hand-drawn line that has snapped, as strokes to draw.
  function shapeOf(a) {
    const r = dragShape(a.shape, a.a.x, a.a.y, a.b.x, a.b.y, a.square);
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
    const base = { id: e.pointerId, type: e.pointerType, t0: now() };
    // (With the pointer on, only a pen's own eraser, its eraser end or its side button, erases: the eraser tool waits.)
    const penEraser = e.pointerType === 'pen' && !!((e.buttons & (32 | 2)) || e.button === 5);
    if (pointing && !(erasing && penEraser)) {
      const trail = { pts: [], end: 0 };
      trails.push(trail);
      act = { ...base, kind: 'point', trail };
      const q = toBoard(p.x, p.y);
      trail.pts.push(q.x, q.y);
    } else if (erasing && settings.eraser.mode === 'lines') {
      act = { ...base, kind: 'erase', gone: new Set(), last: toBoard(p.x, p.y), at: { ...p, size: settings.eraser.size } };
      eraseTo(p);
    } else if (erasing) {
      // A rub-out is a line too, one that clears what's under it.
      act = { ...base, kind: 'draw', tool: 'rub', sim: 0, color: '', size: SIZES.eraser[settings.eraser.size] / view.z, pts: [], at: { ...p, size: settings.eraser.size } };
      addPoint(e);
      request(true);
    } else if (settings.tool === 'lasso') {
      startLasso(e, p, base);
    } else if (settings.tool === 'shape') {
      const q = toBoard(p.x, p.y);
      act = { ...base, kind: 'shape', a: q, b: q, square: e.shiftKey, shape: settings.shape.kind, fill: settings.shape.fill, color: settings.pen.color, size: SIZES.pen[settings.pen.size] / view.z };
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
      // (A photo is taken only by a swipe that takes no lines: lines written on a photo go, and the photo stays.)
      if (s.tool === 'photo' && act.lines) continue;
      if (touches(s, l.x, l.y, q.x, q.y, r, rubs)) { act.gone.add(s.id); hit = true; if (s.tool !== 'photo') act.lines = true; }
    }
    if (act.lines) for (const s of b.strokes) if (s.tool === 'photo') act.gone.delete(s.id);
    act.last = q;
    act.at = { ...p, size: settings.eraser.size };
    request(hit);
  }
  function finishInk() {
    const a = act;
    act = null;
    clearTimeout(holdTimer);
    if (a.kind === 'point') { a.trail.end = now(); request(false); onEnd?.(); return; } // (left to fade, kept nowhere)
    if (a.kind === 'loop' || a.kind === 'lift') { host.classList.remove('lifting'); endLasso(a); request(true); onEnd?.(); return; }
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
  function dropInk() { if (act?.kind === 'point') act.trail.end = now(); act = null; host.classList.remove('lifting'); clearTimeout(holdTimer); request(true); onEnd?.(); }
  // The lasso lifting: a loop picks up what's inside it, and a tap on a photo picks up that photo (a tap that put down
  // what was picked up, say on a worksheet that fills the screen, picks up nothing); a move or resize is made.
  function endLasso(a) {
    if (a.kind === 'loop') {
      const b = board(), sp = a.sp;
      let far = 0;
      for (let i = 0; i < a.pts.length; i += 2) far = Math.max(far, Math.hypot((a.pts[i] - a.pts[0]) * view.z, (a.pts[i + 1] - a.pts[1]) * view.z));
      select(far > 8 && sp ? pick(b, a.pts) : b && !a.dropped ? tapPick(b, a.pts[0], a.pts[1]) : null);
      return;
    }
    if (sel && a.moved && (a.tf.dx || a.tf.dy || a.tf.k !== 1)) onPlace?.(sel.ids, a.tf);
  }

  // ---------- moving and zooming ----------
  // A line being drawn when the board moves under it (the wheel, a zoom key, Show it all) ends where it had got to, as
  // when the screen turns (see resize()): the rest of it would land somewhere else on the board. (Opening a board moves
  // it quietly, and stops what was going on first.)
  function setView(v, quiet) {
    stopEase();
    showView(v, quiet);
  }
  function showView(v, quiet) {
    const next = { x: v.x, y: v.y, z: clampZ(v.z) };
    if (!quiet && inking() && (next.x !== view.x || next.y !== view.y || next.z !== view.z)) {
      if (act.kind === 'shape' || act.kind === 'lift') dropInk(); else finishInk();
    }
    view = next;
    request();
    if (!quiet) onView?.(view);
  }
  function zoomAt(px, py, z) {
    const q = toBoard(px, py), nz = clampZ(z);
    setView({ x: q.x - px / nz, y: q.y - py / nz, z: nz });
  }
  // Show it all, back to 100% and Ctrl + = and − ease the board into place: the middle of the screen moves in a straight
  // line while the zoom changes by the same ratio each frame, quick at first and slowing at the end. The board slides
  // as a picture meanwhile (see paintMain) and is drawn whole once it's there. Anything coming down on the board, or the
  // wheel, stops it where it is; with Reduce motion on (or a board not yet on screen) it's there at once.
  const goal = () => (ease ? ease.to : view);
  function easeTo(v) {
    const to = { x: v.x, y: v.y, z: clampZ(v.z) };
    if (calm.matches || !w || !h) { setView(to); return; }
    stopEase();
    ease = { from: { ...view }, to, t0: now(), frame: requestAnimationFrame(easeStep) };
  }
  function easeStep() {
    const { from: a, to: b, t0 } = ease, k = Math.min(1, (now() - t0) / EASE_MS), e = 1 - (1 - k) ** 3;
    const mid = (v, d) => v[d] + (d === 'x' ? w : h) / 2 / v.z;
    const z = a.z * (b.z / a.z) ** e, cx = mid(a, 'x') + (mid(b, 'x') - mid(a, 'x')) * e, cy = mid(a, 'y') + (mid(b, 'y') - mid(a, 'y')) * e;
    if (k < 1) { ease.frame = requestAnimationFrame(easeStep); showView({ x: cx - w / 2 / z, y: cy - h / 2 / z, z }); return; }
    ease = null;
    showView(b);
  }
  function stopEase() {
    if (!ease) return;
    cancelAnimationFrame(ease.frame);
    ease = null;
    request(true); // (drawn whole where it stopped)
  }
  // Zoomed about the middle of the screen, from where the board is going if it's easing there already (so three quick
  // presses of Ctrl + = zoom three steps).
  function zoomMiddle(z) {
    const g = goal(), nz = clampZ(z), q = { x: g.x + w / 2 / g.z, y: g.y + h / 2 / g.z };
    easeTo({ x: q.x - w / 2 / nz, y: q.y - h / 2 / nz, z: nz });
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
    if (act?.kind === 'pinch' || act?.id === id) { act = null; request(true); }
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
    stopEase();
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
      // Once there's a pen, a touch far bigger than a fingertip is the side of a hand, whatever fingers are set to do.
      if (settings.penSeen && Math.max(e.width || 0, e.height || 0) > PALM_SIZE) return;
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
        request(true);
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
      // A touch that spreads out past a fingertip, once there's a pen, was the side of a hand after all: a line it was
      // drawing (with fingers set to Always draw) goes, and a board it was moving goes back.
      if (settings.penSeen && Math.max(e.width || 0, e.height || 0) > PALM_SIZE) {
        if (act && act.id === e.pointerId && inking()) dropInk();
        palm(e.pointerId);
        return;
      }
    }
    if (act && act.id === e.pointerId && inking()) {
      const events = e.getCoalescedEvents?.() || [];
      const list = events.length ? events : [e];
      if (act.kind === 'point') {
        for (const ce of list) { const q = local(ce), b = toBoard(q.x, q.y); act.trail.pts.push(b.x, b.y); }
        request(false);
      } else if (act.kind === 'loop' || act.kind === 'lift') {
        moveLasso(p, list);
      } else if (act.kind === 'shape') {
        act.b = toBoard(p.x, p.y);
        act.square = e.shiftKey; // (Shift with a mouse makes it square or round, however far off)
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
    if (!act && e.pointerType !== 'touch' && ((settings.tool === 'eraser' && !pointing) || penEraser)) { hover = { ...p, pen: penEraser }; request(false); }
    else if (hover) { hover = null; request(false); }
    // (Over the lasso's box, the mouse or a pen shows it would move it, or by its corner, resize it.)
    const grip = !act && e.pointerType !== 'touch' && settings.tool === 'lasso' && !pointing ? onBox(p) : null;
    host.style.cursor = grip === 'corner' ? 'nwse-resize' : grip === 'box' ? 'move' : '';
  }

  function up(e, cancelled) {
    if (act && act.id === e.pointerId && inking()) {
      if (e.pointerType === 'pen') lastPen = now();
      if (cancelled && e.pointerType === 'touch') dropInk(); else finishInk();
    } else if (act?.kind === 'pan' && act.id === e.pointerId && e.pointerType !== 'touch') {
      act = null;
      request(true); // (the board, which slid as a picture while it moved, drawn whole: see paintMain)
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
      if (act?.kind === 'pan' || act?.kind === 'pinch') { act = null; request(true); }
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
    stopEase();
    // (It has no end of its own: the board is drawn whole once it has been still for a moment.)
    wheeling = true;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheeling = false; request(true); }, 150);
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
    redraw() { if (act?.snap) act.snap = null; request(true, true); }, // (all of it, a rub-out in progress included)
    // The board has changed: draw what's new on it (all of it, unless only strokes on top were added).
    update() { if (act?.snap) act.snap = null; reselect(); request(true); },
    // The lines the lasso has picked up (their ids), picking up others, or none.
    get selected() { return sel ? [...sel.ids] : []; },
    get box() { return boxOnScreen(); }, // (where the box is on screen, for the tests)
    select(ids) { if (act?.kind === 'lift') dropInk(); select(ids); },
    // Back to 100%, keeping the middle of the screen where it is.
    zoomTo(z) { zoomMiddle(z); },
    zoomBy(k) { zoomMiddle(goal().z * k); },
    fit() { const b = board(); easeTo(b.strokes.length ? fitView(b, w, h, Math.min(w, h) * 0.08, 2) : { x: 0, y: 0, z: 1 }); },
    // Where the board is going (where it is, unless it's easing there), and whether it's easing.
    get goal() { return { ...goal() }; },
    get easing() { return !!ease; },
    // Stop whatever's in progress, without keeping it (opening another board, say).
    cancel() { stopEase(); act = null; host.classList.remove('lifting'); sel = null; clearTimeout(holdTimer); fingers.clear(); tap = null; gesture = null; trails.length = 0; request(true, true); },
    // The pointer on or off. Turned off, a trail on screen still fades as it would.
    get pointing() { return pointing; },
    setPointer(on) {
      pointing = !!on;
      if (!pointing && act?.kind === 'point') finishInk();
      hover = null;
      request(false);
    },
    get trails() { return trails.length; }, // (for the tests)
  };
}
