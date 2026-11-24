// Clean Slate: a board to draw on with a pen, a finger or a mouse. This file wires the page together: the toolbar,
// the list of boards, the menu, undo, pictures and backups.
import * as store from './store.js';
import { settings, saveSettings } from './store.js';
import { contentKey, addStrokes, removeStrokes, INKS, MARKERS, SIZES, BACKGROUNDS, PATTERNS, shareable, cleanBoard, importBoard, shade, nextName, untouched, laterThan, twin, cleanName, copyBoard, newId, nextT, photoKey, MAX_PHOTO } from './board.js';
import { createSurface } from './surface.js';
import { picture, viewPicture, thumbnail, fitView, visibleBounds, photosReady, onPhoto } from './ink.js';
import { placeStep, recolourStep, deleteStep, pickedStrokes } from './lasso.js';
import { toSVG, fromSVG } from './svg.js';
import { KINDS } from './shapes.js';
import { initSync, chip, card, sync, syncState, shown as driveShown } from './sync.js';
import { $, esc, icon, toast, untoast, ago, twoStep, fileName, keepFocus } from './ui.js';
import { guardEdges } from './edge-guard.js';
import { makeHistory } from './history.js';

const single = 'single' in document.documentElement.dataset; // the one-file copy (no service worker, no Google Drive)
// The one-file copy shown inside another page (an Artifact, framed in claude.ai, say), where saving and opening files
// isn't allowed. Opened as a file on the computer, it saves pictures and backups and opens files like the site.
const framed = single && (() => { try { return window.top !== window.self; } catch { return true; } })();
let current = '';
let deleting = null; // a board just deleted, while its toast offers Undo: { id, here, made }
let penNews = false; // a pen has just been found: say so when it lifts
// board id -> its undo and redo (js/history.js). The last steps of each are kept with the board (store.setUndo), so
// they carry on after a reload.
const history = new Map();
const hist = id => history.get(id) || history.set(id, makeHistory({
  add: strokes => store.edit(id, b => addStrokes(b, strokes)),
  remove: ids => store.edit(id, b => removeStrokes(b, ids)),
  has: ids => { const b = store.get(id); return !!b && ids.some(i => b.strokes.some(s => s.id === i)); },
  find: s => { const b = store.get(id); return b ? twin(b, s) : null; },
}, store.get(id)?.undo)).get(id);
const board = () => store.get(current);

await store.init();
current = store.get(settings.board) ? settings.board : newest().id;

const surface = createSurface($('#board'), {
  board,
  settings,
  // The hint on an empty board makes way as soon as a line starts, and comes back if it comes to nothing.
  onBegin() { closePop(); $('#hint').classList.add('away'); },
  onEnd() {
    hint();
    // Said once the pen lifts, not as it lands, so it isn't spent while the person is writing.
    if (penNews && !deleting) toast('Pen found: it draws, and a finger moves the board. Change that under Fingers in the menu.', 6000);
    penNews = false;
  },
  onStroke(s) {
    // (A board drawn on here opens where it was drawn on, so its place is kept from its first line.)
    if (!board().view) store.setView(current, surface.view);
    store.edit(current, b => addStrokes(b, [s]));
    remember({ add: [s] });
    keepBoards();
  },
  onErase(ids) {
    const b = board();
    const gone = b.strokes.filter(s => ids.includes(s.id));
    store.edit(current, x => removeStrokes(x, ids));
    remember({ remove: gone });
  },
  onView: (view, quiet) => { if (!quiet) showZoom(view); keepView(); },
  // The lasso's lines put down where they were taken (moved, or made bigger or smaller): one change, one undo step,
  // and they stay picked up where they are now.
  onPlace(ids, tf) { lassoDid(placeStep(board(), ids, tf)); },
  onSelect: placeBar,
  // A two- or three-finger tap says what it did, since the change may be off screen (the buttons and keys stay quiet).
  // While a deleted board's Undo is offered and nothing has been done since, the delete was the last thing done, so a
  // two-finger tap brings that board back. Otherwise it undoes, and the delete's toast stays on screen, as it does for
  // a three-finger tap.
  onUndo() { if (undoBringsBack()) { bringBack(); return; } const done = undo(); if (!deleting) toast(done ? 'Undone.' : 'Nothing to undo.', 1200); },
  onRedo() { const done = redo(); if (!deleting) toast(done ? 'Redone.' : 'Nothing to redo.', 1200); },
  onPenSeen() {
    saveSettings();
    penNews = settings.fingers === 'auto' && coarse; // (with no touch screen, no finger to tell about)
    hint();
  },
  // The first time a finger moves the board instead of drawing because a pen has been used, on this device, say so
  // once, and where to change it.
  onFingerPan() {
    if (settings.fingers !== 'auto' || !settings.penSeen || settings.toldFingers || deleting) return;
    settings.toldFingers = true;
    saveSettings();
    toast('A finger moves the board now you’ve used a pen. To draw with it, pick Always draw under Fingers in the menu.', 6000);
  },
});
// A line started near the side of a phone's screen can set off Android's back gesture (or Chrome's swipe to go back),
// which takes the touch away and then goes Back, out of Clean Slate. A Back that comes while something is touching the
// board, or within a second of a touch on it being taken, is a slip and leaves the board as it was. A Back otherwise
// leaves in one press, as it always has. (See js/edge-guard.js.)
guardEdges({ surfaces: [$('#board')] });
// For the tests and the screenshots.
window.cleanSlate = { store, surface, settings, open: openBoard, current: () => current, shown: () => shown().map(b => b.id), sync, syncState };

// The boards in the list: all of them but one just deleted, while its Undo is offered (see deleteBoard).
function shown() { return store.list().filter(b => b.id !== deleting?.id); }
function newest() { return shown().sort((a, b) => b.changed - a.changed)[0]; }

// Once there's a drawing worth keeping, ask the browser to keep this site's boards when it's short of space, rather
// than clearing them with everything else. Chrome and Safari decide by themselves; Firefox asks the person, once.
function keepBoards() {
  if (settings.askedToKeep || !store.isKept() || !navigator.storage?.persist) return;
  settings.askedToKeep = true;
  saveSettings();
  navigator.storage.persist().catch(() => {});
}

// ---------- undo ----------
// Undoing a removal puts the strokes back as copies (the originals stay removed on every device that saw them go).
function remember(step) { hist(current).remember(step); keepUndo(); if (deleting) deleting.since = true; tools(); }
function undo() { const done = hist(current).undo(); if (done) keepUndo(); tools(); return done; }
function redo() { const done = hist(current).redo(); if (done) keepUndo(); tools(); return done; }
function keepUndo() { store.setUndo(current, hist(current).saved()); }

// ---------- the toolbar ----------
const TOOLS = [['pen', 'Pen', icon.pen, 'P'], ['marker', 'Highlighter', icon.marker, 'H'], ['shape', 'Shapes', icon.rect, 'S'], ['eraser', 'Eraser', icon.eraser, 'E'], ['lasso', 'Lasso', icon.lasso, 'V']];
// With a mouse (a pointer that hovers) the titles say the keys; on a touch screen, the finger taps.
const hovers = matchMedia('(hover: hover)').matches;
const keyed = (label, key) => (hovers ? `${label} (${key})` : label);
// (On a Mac, and an iPad with a keyboard, the key that goes with Z, 0, = and − is ⌘. Chrome names the platform
// 'macOS', Safari 'MacIntel'.)
const MOD = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? '⌘' : 'Ctrl';
const SIZE_NAMES = ['Fine', 'Medium', 'Bold'];
const ERASER_NAMES = ['Small', 'Medium', 'Large'];
const MODES = { rub: ['Rub out', 'Rubs out just where it touches'], lines: ['Whole lines', 'Takes away every line it touches'] };
const narrowScreen = matchMedia('(max-width: 859px)');
const wide = () => !narrowScreen.matches;

function toolbarHTML() {
  return `<div class="group" role="group" aria-label="Tools">${TOOLS.map(([k, label, svg, key]) => `<button type="button" class="tool" data-tool="${k}" aria-label="${label}" title="${keyed(label, key)}" aria-keyshortcuts="${key}"${k === 'shape' ? ' aria-controls="pop" aria-expanded="false"' : ''}>${svg}</button>`).join('')}</div>
    <span class="sep wide"></span><div class="group wide swatches" role="group" aria-label="Colour"></div>
    <span class="sep wide"></span><div class="group wide sizes" role="group" aria-label="Size"></div>
    <span class="sep narrow"></span><button type="button" class="tool style narrow" id="styleBtn" aria-label="Colour and size" aria-controls="pop" aria-expanded="false"><i></i></button>
    <span class="sep"></span><div class="group" role="group" aria-label="Undo and redo"><button type="button" class="tool" id="undo" aria-label="Undo" title="${hovers ? `Undo (${MOD} + Z)` : 'Undo (two-finger tap)'}" aria-keyshortcuts="Control+Z Meta+Z">${icon.undo}</button><button type="button" class="tool" id="redo" aria-label="Redo" title="${hovers ? `Redo (${MOD} + Shift + Z)` : 'Redo (three-finger tap)'}" aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z">${icon.redo}</button></div>`;
}
const toolbar = $('#tools');
toolbar.innerHTML = toolbarHTML();
toolbar.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  // A button clicked with the mouse or a tap doesn't keep the keyboard's focus, which would take Space from Space + drag.
  // (A click from the keyboard has no detail, and keeps it.)
  if (e.detail) b.blur();
  if (b.dataset.tool) {
    if (longPressed && e.detail) { longPressed = false; return; } // (the end of a long press that put the pointer on)
    const same = !surface.pointing && settings.tool === b.dataset.tool;
    setTool(b.dataset.tool);
    // The shapes tool always offers its shapes; a tool tapped again on a narrow screen offers its colours and sizes.
    if (b.dataset.tool === 'shape') { if (same && popOpen()) closePop(); else openPop(b); }
    else if (same && !wide()) togglePop(b);
    else closePop();
    if (!e.detail) popFocus();
  } else if (b.dataset.color) { settings[penTool()].color = b.dataset.color; saveSettings(); tools(); }
  else if (b.dataset.size) { settings[sizeTool()].size = +b.dataset.size; saveSettings(); tools(); }
  else if (b.dataset.mode) { settings.eraser.mode = b.dataset.mode; saveSettings(); tools(); }
  else if (b.id === 'styleBtn') { togglePop(b); if (!e.detail) popFocus(); }
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
});
const penTool = () => (settings.tool === 'marker' ? 'marker' : 'pen');
const sizeTool = () => (settings.tool === 'eraser' ? 'eraser' : penTool());
function setTool(t) { surface.setPointer(false); if (t !== 'lasso') surface.select(null); settings.tool = t; saveSettings(); tools(); surface.update(); }

// ---------- the pointer, for presenting ----------
// Holding the pen button down (or L) puts the pointer on: what's drawn is a red trail that fades a second after the lift,
// never kept, synced or undone (js/surface.js). It stays out of the toolbar: the pen button shows it, and picking any
// tool, or Esc, puts it away.
function setPointer(on) {
  if (on === surface.pointing) return;
  surface.setPointer(on);
  tools();
  if (on) { closePop(); toast(hovers ? 'Pointer: its trail fades a second after you lift. Press Esc or pick a tool to stop.' : 'Pointer: its trail fades a second after you lift. Pick a tool to stop.', 4000); }
}
const LONG_PRESS = 500;
let longPress = 0, longPressed = false;
toolbar.addEventListener('pointerdown', e => {
  longPressed = false;
  if (!e.target.closest('[data-tool="pen"]') || e.button > 0) return;
  clearTimeout(longPress);
  longPress = setTimeout(() => { longPressed = true; setPointer(true); }, LONG_PRESS);
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) toolbar.addEventListener(t, () => clearTimeout(longPress));
// (A long press on a touch screen would otherwise bring up the browser's own menu.)
toolbar.addEventListener('contextmenu', e => e.preventDefault());

// Colours and sizes for the tool in hand: in the toolbar on a wide screen, in a small pop-up on a narrow one.
// (Shapes take the pen's colour and size. The eraser has its two ways of erasing where the colours would be.)
function modesHTML() {
  return Object.entries(MODES).map(([k, [label, title]]) => `<button type="button" class="mode" data-mode="${k}" title="${title}" aria-pressed="${settings.eraser.mode === k}">${label}</button>`).join('');
}
function kindsHTML() {
  return `<div class="kinds" role="group" aria-label="Shapes">${Object.entries(KINDS).map(([k, label]) => `<button type="button" class="tool" data-kind="${k}" aria-label="${label}" title="${label}" aria-pressed="${settings.shape.kind === k}">${icon[k]}</button>`).join('')}
    <span class="sep"></span><button type="button" class="tool" data-fill aria-label="Filled" title="Filled rectangles and ellipses" aria-pressed="${settings.shape.fill}">${icon.filled}</button></div>`;
}
function swatchesHTML() {
  if (settings.tool === 'eraser') return modesHTML();
  if (settings.tool === 'lasso') return '<span class="says">Draw round lines to pick them up</span>';
  const set = settings.tool === 'marker' ? MARKERS : INKS, bg = board().bg, mine = settings[penTool()].color;
  // (The first ink is drawn chalk-white on the Slate, and named so.)
  const name = (k, c) => (k === 'ink' && BACKGROUNDS[bg]?.dark ? 'White' : c.name);
  return Object.entries(set).map(([k, c], i) => `<button type="button" class="swatch" data-color="${k}" aria-label="${name(k, c)}" title="${keyed(name(k, c), i + 1)}" aria-pressed="${k === mine}" style="--c:${shade({ tool: penTool(), color: k }, bg)}"></button>`).join('');
}
function sizesHTML() {
  if (settings.tool === 'lasso') return '';
  const t = sizeTool(), names = t === 'eraser' ? ERASER_NAMES : SIZE_NAMES, mine = settings[t].size;
  const dot = i => (t === 'eraser' ? [8, 13, 19] : t === 'marker' ? [7, 11, 16] : [3.5, 6, 10])[i];
  return SIZES[t].map((_, i) => `<button type="button" class="size" data-size="${i}" aria-label="${names[i]}" title="${names[i]}" aria-pressed="${i === mine}"><i style="--d:${dot(i)}px"></i></button>`).join('');
}
function tools() {
  const pointing = surface.pointing;
  toolbar.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(pointing ? b.dataset.tool === 'pen' : b.dataset.tool === settings.tool)));
  // (With the pointer on, the pen button shows it, in red.)
  const penBtn = $('[data-tool="pen"]', toolbar);
  if (penBtn.classList.contains('pointing') !== pointing) {
    penBtn.classList.toggle('pointing', pointing);
    penBtn.innerHTML = pointing ? icon.pointer : icon.pen;
    penBtn.setAttribute('aria-label', pointing ? 'Pointer' : 'Pen');
    penBtn.title = pointing ? (hovers ? 'Pointer: pick a tool or press Esc to stop' : 'Pointer: pick a tool to stop') : keyed('Pen', 'P');
  }
  document.body.classList.toggle('pointing', pointing);
  keepFocus($('.swatches', toolbar), () => { $('.swatches', toolbar).innerHTML = swatchesHTML(); });
  toolbar.classList.toggle('erasing', settings.tool === 'eraser');
  // (With Filled on, a filled rectangle or ellipse, so it's plain what the next one will be once the pop-up has gone.)
  const shapeBtn = $('[data-tool="shape"]', toolbar), { kind, fill } = settings.shape, filled = fill && (kind === 'rect' || kind === 'ellipse');
  shapeBtn.innerHTML = filled ? (kind === 'rect' ? icon.filled : icon.ellipseFilled) : icon[kind] || icon.rect;
  shapeBtn.setAttribute('aria-label', filled ? 'Shapes, filled' : 'Shapes');
  shapeBtn.title = keyed(filled ? 'Shapes, filled' : 'Shapes', 'S');
  keepFocus($('.sizes', toolbar), () => { $('.sizes', toolbar).innerHTML = sizesHTML(); });
  const h = hist(current);
  $('#undo').disabled = !h.canUndo();
  $('#redo').disabled = !h.canRedo();
  const style = $('#styleBtn');
  const t = sizeTool();
  style.style.setProperty('--c', settings.tool === 'eraser' ? 'transparent' : shade({ tool: penTool(), color: settings[penTool()].color }, board().bg));
  style.style.setProperty('--d', `${[0.5, 0.72, 1][settings[t].size] * 20}px`);
  style.classList.toggle('erasing', settings.tool === 'eraser');
  // (The lasso has no colour or size of its own: it picks up lines, and recolours them from its own buttons.)
  style.disabled = settings.tool === 'lasso';
  if (popOpen()) fillPop();
  document.body.dataset.using = settings.tool;
}

const pop = $('#pop');
// Reduce motion, in the system's settings: the pop-up and the sheets come and go at once (the board's easing too, in
// js/surface.js).
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const FADE_MS = 120, SLIDE_MS = 220; // as in css/app.css
function fillPop() {
  const shape = settings.tool === 'shape' ? kindsHTML() : '';
  const rest = wide() || settings.tool === 'lasso' ? '' : `<div class="swatches${settings.tool === 'eraser' ? ' modes' : ''}" role="group" aria-label="${settings.tool === 'eraser' ? 'How it erases' : 'Colour'}">${swatchesHTML()}</div><div class="sizes" role="group" aria-label="Size">${sizesHTML()}</div>`;
  keepFocus(pop, () => { pop.innerHTML = shape + rest; });
  pop.setAttribute('aria-label', settings.tool === 'shape' ? (rest ? 'Shapes, colour and size' : 'Shapes') : 'Colour and size');
  if (!pop.innerHTML) closePop(); else popped();
}
// (popFrom: the button that opened it, which the keyboard goes back to when it closes.)
let popFrom = null;
// It fades in and out (css/app.css). While it fades out it's closed already: nothing in it can be tapped or reached
// with the keyboard, and it's hidden once it has faded. With Reduce motion on it goes at once.
let popGoing = 0;
const popOpen = () => !pop.hidden && !pop.classList.contains('out');
function openPop(from = null) {
  popFrom = from;
  clearTimeout(popGoing);
  pop.classList.remove('out');
  pop.inert = false;
  fillPop();
  pop.hidden = !pop.innerHTML;
  popped();
}
function togglePop(from) { if (!popOpen()) openPop(from); else closePop(); }
function closePop() {
  const inside = pop.contains(document.activeElement);
  if (popOpen() && !calm.matches) {
    pop.classList.add('out');
    pop.inert = true;
    clearTimeout(popGoing);
    popGoing = setTimeout(() => { pop.hidden = true; pop.classList.remove('out'); pop.inert = false; }, FADE_MS);
  } else if (!pop.classList.contains('out')) pop.hidden = true;
  popped();
  if (inside) popFrom?.focus({ preventScroll: true });
}
// Opened from the keyboard: the keyboard goes into it, to what's chosen there.
function popFocus() { if (popOpen()) (pop.querySelector('[aria-pressed="true"]') || pop.querySelector('button'))?.focus({ preventScroll: true }); }
// While the pop-up is open, a toast on a phone sits above it rather than on it (css/app.css).
function popped() {
  for (const b of [$('#styleBtn'), $('[data-tool="shape"]', toolbar)]) b.setAttribute('aria-expanded', String(popOpen() && popFrom === b));
  document.body.classList.toggle('popped', popOpen());
  if (popOpen()) document.body.style.setProperty('--pop-h', pop.offsetHeight + 'px');
}
// A tablet turned, or a window made wider or narrower, past the point where the colours and sizes move between the
// toolbar and the pop-up: an open pop-up follows, so it never shows them twice, or leaves them out under the shapes.
narrowScreen.addEventListener('change', () => { if (popOpen()) fillPop(); });
pop.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (e.detail) b.blur(); // (as in the toolbar)
  if (b.dataset.color) settings[penTool()].color = b.dataset.color;
  if (b.dataset.size) settings[sizeTool()].size = +b.dataset.size;
  if (b.dataset.mode) settings.eraser.mode = b.dataset.mode;
  if (b.dataset.kind) settings.shape.kind = b.dataset.kind;
  if ('fill' in b.dataset) settings.shape.fill = !settings.shape.fill;
  saveSettings();
  tools();
  if (b.dataset.size || (b.dataset.kind && wide())) closePop();
});

// ---------- photos ----------
// Add a photo (in the menu), or one pasted or dropped on the board: made at most 1600 pixels on its long side (a JPEG, or
// a PNG if it has see-through parts), and put in the middle of the screen, no bigger than most of it, nor bigger than
// its own pixels. It goes under the ink, and comes picked up with the lasso, so it can be moved and resized straight
// away. (Kept with the board once however often it's copied, and in the board's file on Drive.)
const PHOTO_PX = 1600;
async function photoData(file) {
  let img;
  try { img = await createImageBitmap(file); } catch { return null; }
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  let k = Math.min(1, PHOTO_PX / Math.max(img.width, img.height)), clear = null, data = '';
  // (A picture with see-through parts is a PNG, and a busy one can come out longer than a board keeps: then smaller,
  // until it fits, rather than gone the next time the board opens.)
  for (let tries = 0; tries < 8; tries++, k *= 0.7) {
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (clear === null) {
      clear = false;
      try { const d = ctx.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length && !clear; i += 4) clear = d[i] < 255; } catch { /* fine */ }
    }
    data = clear ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    if (data.length <= MAX_PHOTO) break;
  }
  img.close?.();
  return data.length <= MAX_PHOTO ? { data, w: c.width, h: c.height } : null;
}
let adding = false;
async function addPhoto(file) {
  if (adding) return;
  adding = true;
  try {
    const p = await photoData(file);
    if (!p || !/^data:image\/(jpeg|png);base64,/.test(p.data)) { toast('That picture wouldn’t open. Try a JPEG or a PNG.'); return; }
    const v = surface.goal, { w, h } = surface.size;
    const k = Math.min(0.7 * w / (p.w * v.z), 0.7 * h / (p.h * v.z), 1 / v.z);
    const pw = p.w * k, ph = p.h * k, cx = v.x + w / 2 / v.z, cy = v.y + h / 2 / v.z;
    const r = n => Math.round(n * 10) / 10;
    const key = photoKey(p.data);
    const s = { id: newId('s'), t: nextT(board()), tool: 'photo', color: '', size: 1, sim: 0, pts: [r(cx - pw / 2), r(cy - ph / 2), 1, r(cx + pw / 2), r(cy + ph / 2), 1], src: key };
    if (!board().view) store.setView(current, surface.view);
    store.edit(current, b => { b.photos = { ...b.photos, [key]: p.data }; addStrokes(b, [s]); });
    remember({ add: [s] });
    keepBoards();
    closeSheets();
    setTool('lasso');
    surface.select([s.id]);
    toast('Photo added. Drag it to move it, or its corner to resize it. Pick the pen to write on it.', 4000);
  } finally { adding = false; }
}
$('#addPhoto').addEventListener('click', () => $('#photoFile').click());
$('#photoFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) addPhoto(f);
});

// ---------- the lasso ----------
// What the lasso picks up gets a small bar of buttons by its box (js/surface.js draws the box): Duplicate, Colour (the
// six inks, for the pen lines and shapes among them), Delete and Copy picture. Each change is one undo step, and what
// it made stays picked up.
const bar = $('#lassoBar');
function lassoDid(r) {
  if (!r) return;
  store.edit(current, b => { removeStrokes(b, (r.step.remove || []).map(s => s.id)); addStrokes(b, r.step.add || []); });
  remember(r.step);
  surface.select(r.ids || null);
}
function lassoDelete() { lassoDid(deleteStep(board(), surface.selected)); }
function barHTML(colours) {
  if (colours) {
    const bg = board().bg;
    return `<button type="button" class="tool" data-back aria-label="Back" title="Back">${icon.back}</button>${Object.entries(INKS).map(([k, c]) => `<button type="button" class="swatch" data-ink="${k}" aria-label="${k === 'ink' && BACKGROUNDS[bg]?.dark ? 'White' : c.name}" title="${k === 'ink' && BACKGROUNDS[bg]?.dark ? 'White' : c.name}" style="--c:${shade({ tool: 'pen', color: k }, bg)}"></button>`).join('')}`;
  }
  const clip = !!(window.ClipboardItem && navigator.clipboard?.write);
  return `<button type="button" class="act" data-act="copy">${icon.copy}Duplicate</button><button type="button" class="act" data-act="colour">${icon.colour}Colour</button><button type="button" class="act" data-act="delete">${icon.trash}Delete</button>${clip ? `<button type="button" class="act" data-act="picture">${icon.picture}Copy picture</button>` : ''}`;
}
// Put by the box: centred over it, or under it when there's no room above (the toolbar is there), and on screen.
let barAt = null;
function placeBar(r) {
  barAt = r;
  if (!r) { bar.hidden = true; bar.classList.remove('colours'); return; }
  if (bar.hidden) { bar.innerHTML = barHTML(false); bar.hidden = false; }
  const W = innerWidth, H = innerHeight, bw = bar.offsetWidth, bh = bar.offsetHeight, phone = W < 600;
  const top = phone ? 66 : 76, bottom = H - (phone ? 76 : 12);
  let y = r.y - bh - 10;
  if (y < top) y = r.y + r.h + 10;
  if (y + bh > bottom) y = Math.max(top, Math.min(bottom - bh, r.y + 10));
  bar.style.left = `${Math.round(Math.max(8, Math.min(W - bw - 8, r.x + r.w / 2 - bw / 2)))}px`;
  bar.style.top = `${Math.round(y)}px`;
}
bar.addEventListener('pointerdown', e => e.stopPropagation());
bar.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (e.detail) b.blur();
  const ids = surface.selected;
  if (!ids.length) return;
  if (b.dataset.act === 'colour' || 'back' in b.dataset) {
    const on = b.dataset.act === 'colour';
    bar.innerHTML = barHTML(on);
    bar.classList.toggle('colours', on);
    placeBar(barAt);
    if (!e.detail) bar.querySelector('button')?.focus();
    return;
  }
  if (b.dataset.ink) {
    const r = recolourStep(board(), ids, b.dataset.ink);
    bar.innerHTML = barHTML(false);
    bar.classList.remove('colours');
    if (r) lassoDid(r); else placeBar(barAt);
    if (!r) toast('Only pen lines and shapes take a new colour.');
    return;
  }
  if (b.dataset.act === 'delete') { lassoDelete(); return; }
  if (b.dataset.act === 'copy') {
    // The copy goes a little down and to the right of them, the same on screen at any zoom, and is what's picked up.
    const d = 24 / surface.view.z;
    lassoDid(placeStep(board(), ids, { dx: d, dy: d }, { copy: true }));
    return;
  }
  if (b.dataset.act === 'picture') {
    const part = { ...board(), strokes: pickedStrokes(board(), ids) };
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': photosReady(part).then(() => new Promise(resolve => picture(part).toBlob(resolve, 'image/png'))) })]);
      toast('Picture copied.');
    } catch { toast('This browser wouldn’t copy the picture.'); }
  }
});

// ---------- zoom ----------
// The percentage, with a small arrow back, shows while the board isn't at 100%, and a tap takes it back there. For two
// seconds after, it offers Show it all instead (the whole drawing fitted to the screen), so getting back to the drawing
// after pinching far out or moving away is one or two taps.
const zoomBtn = $('#zoom');
$('#fit').title = keyed('Show it all', 'F');
const OFFER_MS = 2000;
let zoomTimer = 0, offerUntil = 0, offerTimer = 0, zoomShows = '';
const offering = () => performance.now() < offerUntil;
function showZoom(view) {
  const pct = Math.round(view.z * 100), offer = pct === 100 && offering();
  const shows = offer ? 'fit' : pct + '%';
  if (shows !== zoomShows) {
    zoomShows = shows;
    zoomBtn.innerHTML = offer ? `${icon.fit}<span>Show it all</span>` : `${icon.reset}<span>${pct}%</span>`;
    zoomBtn.title = offer ? keyed('Show it all', 'F') : keyed('Back to 100%', `${MOD} + 0`);
  }
  zoomBtn.hidden = pct === 100 && !offer;
  zoomBtn.classList.add('on');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => zoomBtn.classList.remove('on'), 1500);
}
function stopOffer() { offerUntil = 0; clearTimeout(offerTimer); }
// The chip sits in the board's corner, where someone zoomed in is writing small: a pen coming down on it draws on the
// board under it (which takes the pen from there to its lift), and only a finger or the mouse taps it.
let penOnZoom = false;
zoomBtn.addEventListener('pointerdown', e => {
  penOnZoom = e.pointerType === 'pen';
  if (!penOnZoom) return;
  e.preventDefault();
  $('#board').dispatchEvent(new PointerEvent('pointerdown', e));
});
zoomBtn.addEventListener('click', e => {
  if (e.detail && (penOnZoom || e.pointerType === 'pen')) { penOnZoom = false; zoomBtn.blur(); return; }
  if (e.detail) zoomBtn.blur();
  // (A second tap while the board is still easing back to 100% counts too.)
  if (offering() && Math.round(surface.goal.z * 100) === 100) { stopOffer(); surface.fit(); return; }
  stopOffer();
  offerUntil = performance.now() + OFFER_MS;
  offerTimer = setTimeout(() => { offerUntil = 0; showZoom(surface.view); }, OFFER_MS);
  surface.zoomTo(1);
});
// Where a board is moved to is kept a moment after it stops (with the board and the place as they were then), and
// straight away when another board is opened before that.
let viewTimer = 0, viewWaiting = null;
function keepView() {
  clearTimeout(viewTimer);
  const id = current, v = surface.view;
  viewWaiting = () => store.setView(id, v);
  viewTimer = setTimeout(keptView, 400);
}
function keptView() { clearTimeout(viewTimer); const f = viewWaiting; viewWaiting = null; f?.(); }

// ---------- the hint on an empty board ----------
// A touch screen (a phone, a tablet, a laptop that has one): fingers draw or move the board. A computer with only a
// mouse or a trackpad has no use for Fingers in the menu, so it isn't there; it comes back if a touch screen does (a
// laptop folded into a tablet, say).
const touchScreen = matchMedia('(any-pointer: coarse)');
let coarse = touchScreen.matches;
touchScreen.addEventListener('change', () => { coarse = touchScreen.matches; fingersShown(); hint(); });
function fingersShown() { $('#fingers').hidden = !coarse; settingsShown(); }
function hint() {
  describe();
  const el = $('#hint');
  const empty = !board().strokes.length;
  el.hidden = !empty;
  el.classList.toggle('away', surface.inking);
  if (el.hidden) return;
  // (What one finger does now: see Fingers in the menu.)
  const fingerMoves = settings.fingers === 'move' || (settings.fingers === 'auto' && settings.penSeen);
  const draws = !fingerMoves ? 'Use a pen or a finger.' : settings.penSeen ? 'Your pen draws; one finger moves the board.' : 'A pen or the mouse draws; one finger moves the board.';
  el.innerHTML = coarse
    ? `<b>Draw anywhere.</b> ${draws} Two fingers move and zoom. Tap with two fingers to undo. More in the\u00a0···\u00a0menu.`
    : `<b>Draw anywhere.</b> Scroll to move the board; pinch or Ctrl + scroll to zoom. Space + drag moves it too. More in the\u00a0···\u00a0menu.`;
}

// What a screen reader hears for the board: which one, and whether anything is on it.
function describe() {
  const b = board(), n = b.strokes.filter(s => s.tool !== 'rub' && s.tool !== 'photo').length, k = b.strokes.filter(s => s.tool === 'photo').length;
  const what = [n && n + (n === 1 ? ' line' : ' lines'), k && k + (k === 1 ? ' photo' : ' photos')].filter(Boolean).join(', ');
  $('#board').setAttribute('aria-label', `${b.name}: ${what || 'empty'}. Draw on it with a pen, a finger or the mouse.`);
}

// ---------- boards ----------
function openBoard(id) {
  if (!store.get(id)) return;
  surface.cancel();
  keptView();
  current = id;
  settings.board = id;
  saveSettings();
  const b = board();
  // Where a board is on screen is kept on each device. One new here (from Drive or a file) opens with all of it on
  // screen, at no more than 100%, rather than at the top left where it may be out of sight, and then opens there again.
  let v = b.view;
  const { w, h } = surface.size;
  if (!v && b.strokes.length && w > 100 && h > 100) { // (and the board is on screen to be fitted to)
    v = fitView(b, w, h, Math.min(w, h) * 0.08, 1);
    store.setView(id, v);
  }
  surface.setView(v || { x: 0, y: 0, z: 1 }, true);
  stopOffer();
  showZoom(surface.view);
  zoomBtn.classList.remove('on');
  $('#boardName').textContent = b.name;
  document.title = `${b.name} · Clean Slate`;
  showBg(b.bg);
  tools();
  hint();
  if (!menu.hidden) fillMenu();
}
// The toolbar, its pop-ups and the zoom percentage take the board's look, light or dark (css/app.css), and so does the
// bar at the top of the screen in the installed app (theme-color), whether the device is in light or dark mode.
function showBg(bg) {
  document.body.dataset.bg = bg;
  const bar = BACKGROUNDS[bg]?.dark ? '#1b2125' : '#f3f5f7';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = bar; });
}

const boardsSheet = $('#boards');
// Each board's little picture, kept while the board is the same (its lines, name, colour and lines, and the screen's
// sharpness), so opening the list draws again only the boards that changed: drawing every one took a quarter of a
// second on a slower tablet each time the list opened.
const thumbs = new Map(); // board id -> { key, canvas }
// (A photo decoded since a picture was made: the pictures are made again, with it.)
onPhoto(() => { thumbs.clear(); if (!boardsSheet.hidden) fillBoards(); });
function thumb(b, scale) {
  const key = `${contentKey(b)}|${b.bg}|${b.pattern}|${scale}`;
  let t = thumbs.get(b.id);
  if (!t || t.key !== key) thumbs.set(b.id, t = { key, canvas: thumbnail(b, 88, 62, scale) });
  return t.canvas;
}
// A long name takes two lines, then ends in an ellipsis (the whole of it is the button's title). A backup's '(backup)'
// goes at the start of the line under it, where the ellipsis can't take it.
function listWhat(b) {
  const [, name, backup] = /^(.*?)( \(backup\))?$/s.exec(b.name);
  const when = b.strokes.length ? `Changed ${ago(b.changed)}` : 'Empty';
  return `<b>${esc(name || b.name)}</b><small>${backup && name ? `(backup) · <span>${when}</span>` : when}</small>`;
}
function fillBoards() {
  // (Made again from the keyboard, after a delete say: the keyboard goes to the open board.)
  const had = $('#boardList').contains(document.activeElement);
  const list = shown().sort((a, b) => b.changed - a.changed);
  // (A name being typed in the list, when the list is made again under it, after a sync say, keeps what's typed.)
  const box = $('#boardList .rename'), inBox = box && document.activeElement === box && [box.value, box.selectionStart, box.selectionEnd];
  if (renaming && !list.some(b => b.id === renaming)) renaming = '';
  refilling = true;
  $('#boardList').innerHTML = list.map(b => `<li${b.id === current ? ' class="here"' : ''} data-row="${b.id}">${rowHTML(b)}</li>`).join('');
  refilling = false;
  $('#boardList').querySelectorAll('li').forEach(wire);
  if (inBox && renaming) { const r = $('#boardList .rename'); r.value = inBox[0]; r.focus({ preventScroll: true }); r.setSelectionRange(inBox[1], inBox[2]); }
  if (had && !$('#boardList').contains(document.activeElement)) $('#boardList li.here .open')?.focus({ preventScroll: true });
}
// A row of the list: the board's picture, name and when it changed (a button that opens it), a pencil to rename it and a
// bin to delete it. Being renamed, the name is a text box, with the same 80-character limit as the menu's Name.
function rowHTML(b) {
  if (b.id === renaming) return `<span class="thumb" data-thumb="${b.id}"></span><input class="rename" type="text" maxlength="80" autocomplete="off" enterkeyhint="done" aria-label="Name of ${esc(b.name)}" value="${esc(b.name)}">`;
  return `<button type="button" class="open" data-id="${b.id}" title="${esc(b.name)}"${b.id === current ? ' aria-current="true"' : ''}><span class="thumb" data-thumb="${b.id}"></span><span class="what">${listWhat(b)}</span></button>
      <button type="button" class="ren icon-btn" data-ren="${b.id}" aria-label="Rename ${esc(b.name)}" title="Rename">${icon.pen}</button>
      <button type="button" class="del icon-btn" data-del="${b.id}" aria-label="Delete ${esc(b.name)}" title="Delete">${icon.trash}</button>`;
}
function wire(li) {
  const scale = Math.min(2, devicePixelRatio || 1);
  for (const el of li.querySelectorAll('[data-thumb]')) el.append(thumb(store.get(el.dataset.thumb), scale));
  li.querySelectorAll('[data-del]').forEach(btn => twoStep(btn, 'Delete?', () => deleteBoard(btn.dataset.del), `Delete ${store.get(btn.dataset.del)?.name}? Press again to delete`));
}
// Renaming a board from the list: the pencil turns its name into a text box. Enter, or leaving the box (tapping
// elsewhere, closing the list), keeps the name typed; Esc keeps the name it had, and so does an empty box. Only that
// row is made again afterwards, so a tap on another board that ends the renaming still opens it.
let renaming = '', refilling = false;
function startRename(id) {
  endRename(true);
  renaming = id;
  const li = $(`#boardList [data-row="${id}"]`);
  if (!li) { renaming = ''; return; }
  li.innerHTML = rowHTML(store.get(id));
  wire(li);
  const box = $('.rename', li);
  box.focus({ preventScroll: true });
  box.select();
}
function endRename(keep, focus = false) {
  const id = renaming, box = $('#boardList .rename');
  if (!id) return;
  renaming = '';
  if (keep && box) rename(id, box.value);
  const li = $(`#boardList [data-row="${id}"]`), b = store.get(id);
  if (!li || !b) return;
  li.innerHTML = rowHTML(b);
  wire(li);
  if (focus) $('.open', li)?.focus({ preventScroll: true });
}
$('#boardList').addEventListener('keydown', e => {
  if (!e.target.matches('.rename')) return;
  if (e.key === 'Enter') { e.preventDefault(); endRename(true, true); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false, true); }
});
$('#boardList').addEventListener('focusout', e => { if (e.target.matches('.rename') && !refilling) endRename(true); });
// Deleting takes the board out of the list at once, but it stays in the store, with its undo, while the toast offers
// Undo. It's deleted for good (from this device, and with Drive on, binned there) when the toast goes, when another
// board is deleted, or when the page is left, so nothing reaches IndexedDB or Drive before then.
function deleteBoard(id) {
  deleted();
  const b = store.get(id);
  if (!b) return;
  const d = deleting = { id, here: id === current, made: '' };
  if (!shown().length) d.made = store.create(nextName([])).id;
  if (id === current) openBoard(newest().id);
  fillBoards();
  toast(`Deleted “${b.name}”.`, 6000, { label: 'Undo', act: () => undelete(d), end: () => deleted(d) });
}
// (Each toast's Undo and end belong to its own delete, which may have been made final already.)
function deleted(d = deleting) {
  if (!d || d !== deleting) return;
  deleting = null;
  store.remove(d.id);
  history.delete(d.id);
}
function undelete(d) {
  if (!d || d !== deleting) return;
  deleting = null;
  if (store.get(d.id)) {
    if (d.here) openBoard(d.id);
    // The empty board made to stand in for it goes again, unless it's been used meanwhile.
    const made = store.get(d.made);
    if (made && untouched(made) && d.made !== current) store.remove(d.made);
  }
  if (!boardsSheet.hidden) fillBoards();
}
// Undo from a two-finger tap or the keys while the toast offers it, if the delete is still the last thing done (a line
// drawn since is what Undo takes then; the toast's own Undo still brings the board back): the same, and a word to say so.
const undoBringsBack = () => !!deleting && !deleting.since;
function bringBack() {
  const d = deleting, name = store.get(d.id)?.name;
  undelete(d);
  if (name) toast(`Brought back “${name}”.`);
}
// (Its toast goes too, so an Undo that can no longer bring the board back isn't left on screen for the return.)
function deletedNow() { if (!deleting) return; deleted(); untoast(); }
addEventListener('pagehide', () => { commitName(); endRename(true); deletedNow(); store.flush(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (deleting || typed || renaming)) { commitName(); endRename(true); deletedNow(); store.flush(); } });
$('#boardList').addEventListener('click', e => {
  const b = e.target.closest('button.open');
  if (b) { openBoard(b.dataset.id); closeSheets(); }
  const r = e.target.closest('button[data-ren]');
  if (r) startRename(r.dataset.ren);
});
// New board, while the board on screen is still empty and has never been named, goes back to it rather than piling up
// another empty one.
$('#newBoard').addEventListener('click', () => {
  const here = board();
  if (!here.strokes.length && !here.nameAt) { closeSheets(); toast('This board is still empty.'); return; }
  openBoard(store.create().id);
  closeSheets();
});
$('#boardsBtn').addEventListener('click', e => openSheet(boardsSheet, e));

// ---------- the menu ----------
const menu = $('#menu');
function fillMenu() {
  const b = board();
  $('#nameInput').value = b.name;
  keepFocus($('#bgs'), () => { $('#bgs').innerHTML = Object.entries(BACKGROUNDS).map(([k, v]) => `<button type="button" class="chip bgchip" data-bg="${k}" aria-pressed="${b.bg === k}"><i style="background:${v.bg}"></i>${v.name}</button>`).join(''); });
  keepFocus($('#patterns'), () => { $('#patterns').innerHTML = Object.entries(PATTERNS).map(([k, v]) => `<button type="button" class="chip" data-pattern="${k}" aria-pressed="${b.pattern === k}"><i class="pat ${k}"></i>${v}</button>`).join(''); });
  menu.querySelectorAll('input[name="fingers"]').forEach(r => { r.checked = r.value === settings.fingers; });
  pictureChips();
  $('#kept').hidden = store.isKept();
  $('#kept').textContent = store.stopped() ? 'This browser has stopped keeping boards. Save a backup now, then reload the page.' : keptText;
  clearable();
}
const keptText = $('#kept').textContent;
// Clear, and Make a copy, have nothing to do on an empty board.
function clearable() { $('#clear').disabled = $('#copyBoard').disabled = !board().strokes.length; }
$('#menuBtn').addEventListener('click', e => { fillMenu(); openSheet(menu, e); driveShown(); });
// The name typed in the box is kept a moment after typing stops (so the top button follows it), on Enter or leaving the
// box, and when the page is left with the box still open (a phone switching apps can drop the page in the background
// and never come back to it). An empty box keeps the name there was. (typed: what's waiting to be kept, and for which
// board, so a name typed just before another board opens goes to the board it was typed for.)
let typed = null;
function commitName() {
  if (!typed) return;
  clearTimeout(typed.timer);
  const { id, text } = typed;
  typed = null;
  rename(id, text);
}
// A name typed for a board, in the menu or the list of boards. An empty one keeps the name there was.
function rename(id, text) {
  const b = store.get(id), name = cleanName(text);
  if (!b || !name) return;
  if (name !== b.name) store.edit(id, x => { x.name = name; x.nameAt = laterThan(x.nameAt); });
  if (id !== current) return;
  $('#boardName').textContent = name;
  describe();
  document.title = `${name} · Clean Slate`;
}
const nameBox = $('#nameInput');
nameBox.addEventListener('input', () => {
  clearTimeout(typed?.timer);
  typed = { id: current, text: nameBox.value, timer: setTimeout(commitName, 400) };
});
nameBox.addEventListener('change', () => {
  typed = { id: current, text: nameBox.value };
  commitName();
  nameBox.value = board().name;
});
$('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
menu.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  // (The colour or lines it already has changes nothing, and so has nothing new to save to Drive.)
  if (b.dataset.bg === board().bg || b.dataset.pattern === board().pattern) return;
  if (b.dataset.picture) { settings.picture = b.dataset.picture; saveSettings(); pictureChips(); return; }
  if (b.dataset.bg) { store.edit(current, x => { x.bg = b.dataset.bg; x.bgAt = laterThan(x.bgAt); }); showBg(b.dataset.bg); fillMenu(); tools(); surface.redraw(); }
  if (b.dataset.pattern) { store.edit(current, x => { x.pattern = b.dataset.pattern; x.patternAt = laterThan(x.patternAt); }); fillMenu(); surface.redraw(); }
});
menu.addEventListener('change', e => {
  if (e.target.name === 'fingers') { settings.fingers = e.target.value; saveSettings(); hint(); }
});
twoStep($('#clear'), 'Tap again to clear', () => {
  const b = board(), id = current;
  if (!b.strokes.length) return;
  const gone = [...b.strokes], step = { remove: gone };
  store.edit(current, x => removeStrokes(x, gone.map(s => s.id)));
  remember(step);
  closeSheets();
  // Its message offers Undo, as a delete's does. The tap undoes the Clear only while that board is open and the Clear
  // is still the next thing Undo would undo there (a line drawn since, say, and it does nothing).
  toast(`Cleared “${b.name}”.`, 6000, { label: 'Undo', act: () => { if (current === id && hist(id).last() === step) undo(); } });
});
$('#fit').addEventListener('click', () => { surface.fit(); closeSheets(); });
// Make a copy: another board with the same drawing, colour and lines, opened where this one is on screen.
$('#copyBoard').addEventListener('click', () => {
  const b = board();
  if (!b.strokes.length) return;
  const c = store.add(copyBoard(b, store.list()));
  store.setView(c.id, surface.view);
  openBoard(c.id);
  closeSheets();
  toast(`Opened “${c.name}”, a copy of “${b.name}”.`, 3000);
});

// Pictures and files.
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// PNG, Share and Copy save the whole drawing, or just what's on screen, as chosen above them (and kept on this device).
// The SVG is always the whole drawing: it's the file that opens again in Clean Slate.
const onScreen = () => settings.picture === 'screen';
const pictureNow = () => { const { w, h } = surface.size; return onScreen() ? viewPicture(board(), surface.goal, w, h, devicePixelRatio || 1) : picture(board()); };
const png = async () => { await photosReady(board()); return new Promise(resolve => pictureNow().toBlob(resolve, 'image/png')); };
// Whether any of the drawing is on screen.
function inSight() {
  const c = visibleBounds(board().strokes), v = surface.goal, { w, h } = surface.size;
  return !!c && c.x1 > v.x && c.x0 < v.x + w / v.z && c.y1 > v.y && c.y0 < v.y + h / v.z;
}
const PICTURE_SAYS = {
  all: $('#pictureSays').textContent,
  screen: 'Just what’s on screen, as you see it. An SVG is still the whole drawing, sharp at any size, to open again in Clean Slate.',
};
function pictureChips() {
  menu.querySelectorAll('[data-picture]').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.picture === (onScreen() ? 'screen' : 'all'))));
  $('#pictureSays').textContent = PICTURE_SAYS[onScreen() ? 'screen' : 'all'];
}
// A picture of a big board takes a moment: meanwhile the button says so, and a second tap doesn't make a second file.
// An empty board gets a word instead of a blank picture, and so does an empty screen.
async function making(btn, working, work, whole = false) {
  if (btn.disabled) return;
  if (!board().strokes.length) { toast('Nothing on this board yet.'); return; }
  if (!whole && onScreen() && !inSight()) { toast('None of the drawing is on screen. Show it all, or save the whole drawing.', 4000); return; }
  const label = btn.innerHTML;
  btn.disabled = true;
  if (working) {
    btn.innerHTML = label.replace(/[^>]*$/, working);
    await new Promise(r => requestAnimationFrame(() => setTimeout(r))); // (so the label shows before the work starts)
  }
  try { await work(); } finally { btn.innerHTML = label; btn.disabled = false; }
}
$('#savePng').addEventListener('click', e => making(e.currentTarget, 'Saving…', async () => {
  const name = fileName(board().name) + '.png';
  save(await png(), name);
  toast(`Saved ${name}.`);
}));
$('#saveSvg').addEventListener('click', e => making(e.currentTarget, 'Saving…', () => {
  const name = fileName(board().name) + '.svg';
  save(new Blob([toSVG(board())], { type: 'image/svg+xml' }), name);
  toast(`Saved ${name}.`);
}, true));
const share = $('#sharePng');
share.hidden = !(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] }));
share.addEventListener('click', () => making(share, 'Sharing…', async () => {
  const file = new File([await png()], fileName(board().name) + '.png', { type: 'image/png' });
  try { await navigator.share({ files: [file], title: board().name }); } catch { /* cancelled */ }
}));
const copy = $('#copyPng');
copy.hidden = !(window.ClipboardItem && navigator.clipboard?.write);
// (The clipboard is written straight from the tap, with the picture to follow, as Safari asks.)
copy.addEventListener('click', () => making(copy, '', async () => {
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]); toast('Picture copied.'); } catch { toast('This browser wouldn’t copy the picture. Save it as a PNG instead.'); }
}));
$('#backup').addEventListener('click', () => {
  const list = shown(), now = new Date();
  const data = JSON.stringify({ cleanSlate: 1, saved: now.toISOString(), boards: list.map(shareable) });
  // (The file is named for the day it is here: the ISO date is the day in London, a day ahead every evening in the
  // Americas.)
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  save(new Blob([data], { type: 'application/json' }), `Clean Slate backup ${day}.json`);
  toast(`Saved a backup of ${list.length === 1 ? 'one board' : list.length + ' boards'}.`);
});
$('#restore').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  openFile(f);
});
// A backup or a Clean Slate SVG, from Open a file, or dropped or pasted on the page.
async function openFile(f) {
  if (!f) return;
  let boards = [];
  try {
    const text = await f.text();
    const o = /^\s*</.test(text) ? null : JSON.parse(text);
    if (o?.cleanSlate && Array.isArray(o.boards)) boards = o.boards.map(cleanBoard).filter(Boolean);
    else { const b = fromSVG(text); if (b) boards = [b]; }
  } catch { boards = []; }
  if (!boards.length) { toast('That isn’t a Clean Slate backup or board.'); return; }
  // A file that holds the board just deleted, while its Undo is offered, brings it back rather than being deleted with it.
  if (boards.some(b => b.id === deleting?.id)) { deleting = null; untoast(); }
  // A board that has lost strokes here since the file was saved (Clear, say) gets the file's copy beside it, so the
  // file brings back what was taken away (see importBoard in board.js).
  const came = boards.map(b => importBoard(store.get(b.id), b));
  for (const { board: b } of came) store.absorb(b, 'import');
  // The empty board a new device starts with (or the one left when the last was deleted) has done its job, as with
  // Drive's first sync.
  const brought = new Set(came.map(c => c.board.id));
  for (const b of store.list()) if (untouched(b) && !brought.has(b.id) && b.id !== deleting?.id) store.remove(b.id, 'removed');
  const beside = came.filter(c => c.asNew);
  const n = boards.length, first = came[0].board.name;
  toast(n === 1 ? (beside.length ? `Opened “${first}” beside the board you have.` : `Opened “${first}”.`)
    : `Opened ${n} boards.${beside.length === 1 ? ` “${beside[0].board.name}” is beside the board you have.` : beside.length ? ` ${beside.length} of them are beside the boards you have.` : ''}`, beside.length ? 5000 : 2600);
  if (n === 1) openBoard(came[0].board.id);
  closeSheets();
}
// A file dropped on the page, or pasted, opens as Open a file does (and a dropped file never takes the browser away to
// show it instead); a photo goes on the board, as Add a photo puts it. The name box keeps what's dropped or pasted in it.
const photo = f => /^image\/(png|jpeg|webp|gif)$/.test(f.type);
function brought(f) { if (photo(f)) addPhoto(f); else openFile(f); }
const files = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', e => { if (files(e)) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!files(e)) return;
  e.preventDefault();
  if (!typing(e) && e.dataTransfer.files[0]) brought(e.dataTransfer.files[0]);
});
document.addEventListener('paste', e => {
  const f = e.clipboardData?.files?.[0];
  if (typing(e) || !f || !(photo(f) || f.type === 'image/svg+xml' || f.type === 'application/json')) return;
  e.preventDefault();
  brought(f);
});
// Printing prints the whole drawing, fitted to the page (css/app.css), rather than the part of it on screen. The copy
// is the PNG's picture, as a canvas so it's there the moment the page is printed (an image would still be loading).
addEventListener('beforeprint', () => {
  document.querySelector('.print-copy')?.remove();
  if (!board().strokes.length) return;
  const c = picture(board());
  c.className = 'print-copy';
  c.setAttribute('aria-hidden', 'true');
  $('#app').append(c);
});
addEventListener('afterprint', () => document.querySelector('.print-copy')?.remove());
// The one-file copy has no offline copy and nothing to add to a home screen, and framed in another page, no files.
if (single) $('#homeScreen').hidden = true;
if (framed) menu.querySelectorAll('.files').forEach(el => { el.hidden = true; });
// Opened from the home screen, it's there already. (navigator.standalone: Safari on an iPhone or iPad.)
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('#homeScreen').hidden = true;
// The menu's Settings heading goes when there's nothing under it (in the one-file copy on a computer, say).
function settingsShown() { $('#settings').hidden = ![...$('#settings').children].some(el => el.matches('section:not([hidden])')); }

// ---------- sheets ----------
// The list of boards and the menu are dialogs over the board: while one is open, everything behind it is inert (no
// Tab and no screen reader there), and Tab goes round inside it (and the message at the bottom, which may hold an
// Undo). Opening one puts the focus in it, on the open board in the list or on the menu itself (never on the name box,
// which would bring up a tablet's on-screen keyboard). Closing it puts the focus back on the button that opened it,
// when that was done from the keyboard (after a tap the focus is let go, so Space still moves the board).
const scrim = $('#scrim');
const behind = () => [$('.top'), $('#board'), pop, zoomBtn, $('#lassoBar')];
let opener = null;
// A sheet slides out as it slid in (and the scrim fades): closed at once, with nothing in it to tap or reach with the
// keyboard while it goes, and hidden once it has gone. With Reduce motion on it goes at once.
const going = new Map(); // a sheet or the scrim -> its timer
const isOpen = sheet => !sheet.hidden && !sheet.inert;
function stay(el) { clearTimeout(going.get(el)); going.delete(el); el.hidden = false; el.inert = false; }
function away(el) {
  el.classList.remove('in');
  if (el !== scrim) el.inert = true;
  clearTimeout(going.get(el));
  if (calm.matches) { el.hidden = true; return; }
  going.set(el, setTimeout(() => { going.delete(el); el.hidden = true; }, SLIDE_MS));
}
function openSheet(sheet, e) {
  const from = e && e.detail === 0 ? document.activeElement : null;
  closePop();
  closeSheets();
  opener = from;
  if (sheet === boardsSheet) fillBoards();
  stay(sheet);
  stay(scrim);
  for (const el of behind()) el.inert = true;
  requestAnimationFrame(() => {
    if (!isOpen(sheet)) return; // (closed again meanwhile)
    sheet.classList.add('in');
    scrim.classList.add('in');
    if (sheet.contains(document.activeElement)) return;
    const to = sheet === boardsSheet ? $('#boardList li.here .open') : null;
    (to || sheet).focus({ preventScroll: true });
  });
}
function closeSheets() {
  const was = sheetOpen();
  if (!was) return;
  endRename(true);
  const inside = [boardsSheet, menu].some(s => s.contains(document.activeElement));
  for (const s of [boardsSheet, menu]) if (isOpen(s)) away(s);
  away(scrim);
  for (const el of behind()) el.inert = false;
  const back = opener;
  opener = null;
  if (back?.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
  else if (inside) document.activeElement?.blur?.();
}
scrim.addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
// Tab and Shift + Tab go round inside the open sheet.
function tabRound(e) {
  const sheet = isOpen(menu) ? menu : isOpen(boardsSheet) ? boardsSheet : null;
  if (!sheet) return;
  const can = el => !el.disabled && el.getClientRects().length && !(el.type === 'radio' && !el.checked && [...sheet.querySelectorAll(`input[name="${el.name}"]`)].some(r => r.checked));
  const all = [...sheet.querySelectorAll('button, a[href], input:not([type=file])'), ...$('#toast').querySelectorAll('button')].filter(can);
  if (!all.length) return;
  const first = all[0], last = all[all.length - 1], at = document.activeElement;
  if (e.shiftKey && (at === first || at === sheet || !all.includes(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !all.includes(at) && at !== sheet)) { e.preventDefault(); first.focus(); }
}

// ---------- keys ----------
// Typing in a text box keeps its keys (a Fingers choice or a checkbox doesn't: the shortcuts carry on there).
const typing = e => e.target.closest?.('input:not([type=radio]):not([type=checkbox]):not([type=file]), textarea, [contenteditable]');
const sheetOpen = () => isOpen(menu) || isOpen(boardsSheet);
document.addEventListener('keydown', e => {
  // Esc closes the menu from anywhere in it, the name box too (leaving the box keeps the name typed).
  if (e.key === 'Tab') { tabRound(e); return; }
  if (e.key === 'Escape') {
    if (document.activeElement === $('#nameInput')) $('#nameInput').blur();
    // (and with nothing open, puts down what the lasso picked up, or puts the pointer away)
    const open = sheetOpen() || popOpen();
    closeSheets();
    closePop();
    if (!open && surface.selected.length) surface.select(null);
    else if (!open) setPointer(false);
    return;
  }
  if (typing(e)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && (k === 'z' || k === 'y')) {
    e.preventDefault();
    // Just after a board is deleted, Undo brings it back (the delete was the last thing done, if nothing's been drawn
    // since). Otherwise, while the menu or the list of boards is open, the board they'd change is out of sight behind
    // it, so they wait.
    if (undoBringsBack() && k === 'z' && !e.shiftKey) bringBack();
    else if (!sheetOpen()) { if (k === 'y' || e.shiftKey) redo(); else undo(); }
    return;
  }
  if (mod && (k === '0')) { e.preventDefault(); surface.zoomTo(1); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); surface.zoomBy(1.25); return; }
  if (mod && k === '-') { e.preventDefault(); surface.zoomBy(0.8); return; }
  if (mod || e.altKey) return;
  // The board's own keys wait while the menu or the list of boards is open over it.
  if (sheetOpen()) return;
  if (e.key === ' ' && !e.target.closest?.('button, a, input, select, label')) { e.preventDefault(); surface.setSpace(true); document.body.classList.add('panning'); return; }
  if (k === 'p') setTool('pen');
  else if (k === 'h') setTool('marker');
  else if (k === 'e') setTool('eraser');
  else if (k === 'v') setTool('lasso');
  else if ((e.key === 'Delete' || e.key === 'Backspace') && surface.selected.length) { e.preventDefault(); lassoDelete(); }
  else if (k === 's') setTool('shape');
  else if (k === 'l') setPointer(!surface.pointing);
  else if (k === 'f') surface.fit();
  else if (/^[1-6]$/.test(k) && settings.tool !== 'eraser') {
    const keys = Object.keys(settings.tool === 'marker' ? MARKERS : INKS);
    if (keys[+k - 1]) { settings[penTool()].color = keys[+k - 1]; saveSettings(); tools(); }
  } else if (k === '[' || k === ']') {
    const t = sizeTool();
    settings[t].size = Math.max(0, Math.min(2, settings[t].size + (k === ']' ? 1 : -1)));
    saveSettings();
    tools();
    surface.update(); // (the eraser's circle, if it shows, takes the new size)
  }
});
function spaceUp() { surface.setSpace(false); document.body.classList.remove('panning'); }
document.addEventListener('keyup', e => { if (e.key === ' ') spaceUp(); });
// Space let go of in another window (after Alt + Tab, say) never sends its keyup here.
addEventListener('blur', spaceUp);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') spaceUp(); });

// ---------- changes from elsewhere (Drive, another tab) ----------
store.on(({ id, why }) => {
  if (why === 'unkept') { unkept(); return; }
  if (why === 'removed' || (why === 'sync' && !store.get(id))) {
    thumbs.delete(id);
    if (id === deleting?.id) { deleting = null; untoast(); } // deleted on another device meanwhile
    if (id === current) { if (!shown().length) store.create(nextName([])); openBoard(newest().id); }
    if (!boardsSheet.hidden) fillBoards();
    return;
  }
  if (id === current) {
    if (why === 'sync' || why === 'tab' || why === 'import' || why === 'named') {
      const b = board();
      $('#boardName').textContent = b.name;
      document.title = `${b.name} · Clean Slate`;
      showBg(b.bg);
      tools();
    }
    surface.update();
    hint();
    if (!menu.hidden) clearable();
  }
  if (!boardsSheet.hidden && why !== 'edit') fillBoards();
});
// The browser has stopped keeping boards partway through, and opening its storage again didn't help (Safari can lose
// its connection to it after a while put down, and then only a reload brings it back). What's drawn from now on lasts
// only while the page is open: say so straight away, with the backup a tap away, and ask before the page is left.
function unkept() {
  if (framed) toast('This page has stopped keeping boards. They last only while it’s open.', 12000);
  else toast('This browser has stopped keeping boards. Save a backup now, then reload the page.', 20000, { label: 'Save a backup', act: () => $('#backup').click() });
  if (!menu.hidden) fillMenu();
}
addEventListener('beforeunload', e => { if (store.stopped()) { e.preventDefault(); e.returnValue = ''; } });
// Don't let the page scroll or zoom under the board on phones (the toolbar stays put).
document.addEventListener('touchmove', e => { if (e.touches.length > 1 || e.target.closest('#board')) e.preventDefault(); }, { passive: false });

initSync({
  busy: id => id === current && surface.inking,
  // What a sync did that would otherwise happen without a word. (A deleted board's Undo stays on screen.)
  told(e) {
    if (deleting) return;
    if (e.why === 'deleted' && e.id === current) toast(`“${e.name}” was deleted on another device.${e.trash ? ' It’s in the Drive trash for 30 days.' : ''}`, 6000);
    else if (e.why === 'back') toast(`“${e.name}” is back: it was drawn on on another device after you deleted it.`, 6000);
    else if (e.why === 'arrived') toast(`Brought ${e.n === 1 ? 'one board' : e.n + ' boards'} from Google Drive.`);
  },
});
chip($('#cloud'));
card($('#drive'));
fingersShown();
openBoard(current);
if (!store.isKept()) toast(framed ? 'This page isn’t keeping boards. They last only while it’s open.' : 'This browser isn’t keeping boards (a private window, perhaps). Save a backup before you close it.', 6000);
document.body.classList.add('ready');

if (!single && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
