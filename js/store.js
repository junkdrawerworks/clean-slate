// Where boards are kept on this device: in memory while the page is open, and in IndexedDB (in this browser, on this
// device) a moment after every change. Settings, like the pen colour, are in localStorage.
// Every board change goes through here, so the page, the other tabs and Google Drive saving all hear about it.
import { makeBoard, mergeBoards, nextName, cleanBoard, contentKey } from './board.js';

const DB = 'clean-slate', STORE = 'boards';
const KSET = 'clean-slate.settings';

const boards = new Map();
const listeners = new Set();
let db = null, kept = true;
const writing = new Map(); // id -> { busy, again }
// When the browser's storage stops answering partway through (Safari drops its connection after the tablet has been put
// down a while), the boards whose writes failed wait here, and the page opens the storage again once and writes them.
// trouble: 0 all well, 1 opening it again, 2 opened again and writing what failed, 3 given up (the page has been told).
const failed = new Set();
let trouble = 0;

export const settingsDefaults = () => ({
  board: '', tool: 'pen', fingers: 'auto', penSeen: false, toldFingers: false, askedToKeep: false,
  pen: { color: 'ink', size: 1 }, marker: { color: 'yellow', size: 1 }, eraser: { size: 1, mode: 'rub' },
  shape: { kind: 'rect', fill: false },
});
function readSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KSET) || '{}');
    const d = settingsDefaults();
    return { ...d, ...s, pen: { ...d.pen, ...s.pen }, marker: { ...d.marker, ...s.marker }, eraser: { ...d.eraser, ...s.eraser }, shape: { ...d.shape, ...s.shape } };
  } catch { return settingsDefaults(); }
}
export const settings = readSettings();
export function saveSettings() { try { localStorage.setItem(KSET, JSON.stringify(settings)); } catch { /* storage blocked */ } }

function open() {
  return new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => { const d = req.result; d.onclose = () => { if (db === d) lost(); }; resolve(d); };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
function all() {
  return new Promise(resolve => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}
// (null when it isn't there; undefined when the storage couldn't be read, which says nothing either way)
function one(id) {
  return new Promise(resolve => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

// Writes go in a moment after a change, so a burst of changes is one write (a big board takes a while to copy).
// Leaving the page writes whatever is waiting straight away.
const soon = new Map();
function persist(id) {
  if (!db) { if (trouble) failed.add(id); return; }
  if (soon.has(id)) return;
  soon.set(id, setTimeout(() => { soon.delete(id); write(id); }, 250));
}
function writeWaiting() { for (const [id, t] of soon) { clearTimeout(t); soon.delete(id); write(id); } }
addEventListener('pagehide', writeWaiting);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeWaiting(); });

// Writes one board, never two of the same board at once; changes made meanwhile go in with the next write.
function write(id) {
  const w = writing.get(id) || { busy: false, again: false };
  writing.set(id, w);
  if (w.busy) { w.again = true; return; }
  w.busy = true;
  const conn = db;
  const done = ok => {
    w.busy = false;
    if (!ok) {
      // Written again, as it is by then, once the storage is open again. (One that was under way on the connection
      // just replaced goes again straight away on the new one.)
      w.again = false;
      writing.delete(id);
      failed.add(id);
      if (db && conn !== db) write(id); else lost();
      return;
    }
    failed.delete(id);
    if (trouble && trouble !== 1 && !failed.size) { trouble = 0; kept = true; }
    if (w.again) { w.again = false; write(id); } else writing.delete(id);
    channel?.postMessage({ id });
  };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const b = boards.get(id);
    if (b) tx.objectStore(STORE).put(b); else tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => done(true);
    tx.onerror = tx.onabort = () => done(false);
    // Sent off now rather than when this task ends: a write started as the page goes away (pagehide) is otherwise
    // dropped with the page, and the last quarter second of drawing with it.
    tx.commit?.();
  } catch { done(false); }
}

// A write failed, or the browser closed the storage: open it again, once, and write every board that failed. If it
// won't open, or a write fails again after it has, the page is told (once) so it can say so and offer a backup.
async function lost() {
  kept = false;
  if (trouble === 1 || trouble === 3) return;
  if (trouble === 2) { giveUp(); return; }
  trouble = 1;
  const old = db;
  db = null;
  try { old?.close(); } catch { /* already gone */ }
  const d = await open();
  if (!d) { giveUp(); return; }
  db = d;
  trouble = 2;
  if (!failed.size) { trouble = 0; kept = true; return; }
  for (const id of [...failed]) write(id);
}
function giveUp() {
  trouble = 3;
  emit({ why: 'unkept' });
}

// Changes from this page's other tabs: take their copy in (stroke by stroke, so nothing drawn here is lost).
let channel = null;
async function heard(id) {
  const saved = await one(id);
  if (saved === undefined) return;
  const here = boards.get(id);
  if (!saved) { if (here) { boards.delete(id); emit({ id, why: 'removed' }); } return; }
  const b = here ? { ...mergeBoards(here, saved), rev: Math.max(here.rev, saved.rev || 0), view: here.view } : saved;
  boards.set(id, b);
  // Both tabs may have written at once, the other tab's copy over this one's: then what's saved lacks lines this tab
  // has, and this tab writes the merged copy back. (Only when they differ, so two tabs don't answer each other forever.)
  if (here && contentKey(b) !== contentKey(saved)) persist(id);
  emit({ id, why: 'tab' });
}

export async function init() {
  db = await open();
  if (!db) kept = false;
  if (db) for (const b of await all()) { const c = cleanBoard(b); if (c) boards.set(c.id, { ...c, rev: b.rev || 0, view: b.view }); }
  try { channel = new BroadcastChannel(DB); channel.onmessage = e => e.data?.id && heard(e.data.id); } catch { channel = null; }
  if (!boards.size) create();
}

export const isKept = () => kept;
// Kept until partway through, and not now: what's drawn from here lasts only while the page is open.
export const stopped = () => !kept && trouble > 0;
export const list = () => [...boards.values()];
export const get = id => boards.get(id) || null;

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const f of listeners) { try { f(e); } catch (err) { console.error(err); } } }

export function create(name) {
  const b = makeBoard(name || nextName(list()));
  boards.set(b.id, b);
  persist(b.id);
  emit({ id: b.id, why: 'created' });
  return b;
}

// A change made on this device: fn changes the board in place.
export function edit(id, fn, why = 'edit') {
  const b = boards.get(id);
  if (!b) return null;
  fn(b);
  b.rev = (b.rev || 0) + 1;
  b.changed = Date.now();
  persist(id);
  emit({ id, why });
  return b;
}

// Where the board is on screen, kept so it opens where it was left. Not a change to the drawing.
export function setView(id, view) {
  const b = boards.get(id);
  if (!b) return;
  b.view = view;
  persist(id);
}

// Another copy of a board (from Drive, or a backup file) merged into this one. Not counted as a change made here.
export function absorb(other, why = 'sync') {
  const here = boards.get(other.id);
  const b = here ? { ...mergeBoards(here, other), rev: here.rev, view: here.view } : { ...other, rev: 0 };
  boards.set(b.id, b);
  persist(b.id);
  emit({ id: b.id, why });
  return b;
}

export function remove(id, why = 'removed') {
  if (!boards.has(id)) return;
  boards.delete(id);
  persist(id);
  emit({ id, why });
}

// Wait for every write that's under way (for tests, and before the page is closed).
export async function flush() {
  writeWaiting();
  for (let i = 0; i < 50 && writing.size; i++) await new Promise(r => setTimeout(r, 20));
}
