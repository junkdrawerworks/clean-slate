// Saving boards to Google Drive, so they're in the person's own Drive and follow them from device to device.
// The boards in this browser stay the working copy, and the page never waits for Drive. When saving is on, each board
// is a picture, "Board name.svg", in a "Clean Slate" folder in the person's Drive: it opens in Drive like any picture,
// and has the board tucked inside, so Clean Slate on another device can open it and carry on. The two copies of a
// board are merged stroke by stroke (see board.js), so drawing on two devices keeps both drawings.
// Nothing about this shows away from https://clean-slate.junkdrawer.works, the address Google accepts it from.
import * as store from './store.js';
import { contentKey, untouched, nothingBeyond } from './board.js';
import { toSVG, fromSVG } from './svg.js';
import { esc, icon, ago, fileName, twoStep, toast } from './ui.js';

const ORIGINS = ['https://clean-slate.junkdrawer.works'];
// The junkdrawer.works OAuth client, shared by every junkdrawer.works project.
const CLIENT_ID = '897653851078-p5jrh2bto6h3bj0lc4jist3k1vsc1pj4.apps.googleusercontent.com';
// drive.file: Google lets the projects on this client see only the files they made themselves.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/';
const FOLDER = { name: 'Clean Slate', mimeType: 'application/vnd.google-apps.folder', appProperties: { cleanslate: 'folder' } };
const TAG = 'cleanslate';
// KT is shared by every junkdrawer.works project at this address: one sign-in, good for an hour.
const KT = 'junkdrawer.google', KS = 'clean-slate.drive';
const RETRY = { retry: true }, STOPPED = { stopped: true };
const OFFLINE = 'Offline. Your boards are kept here and go to Drive when you’re back.';

export const available = () => ORIGINS.includes(location.origin) && !('single' in document.documentElement.dataset);

const get = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
// files: board id -> { id, version, rev, key }: the Drive file, its version when this device last saw it, the
// board's rev here that it holds, and a key for what's in it. deleted: boards taken away here, to bin in Drive.
// binned: board id -> when this device binned its file, for a day, so a board that comes back can say why.
const fresh = () => ({ on: false, email: '', files: {}, deleted: {}, binned: {}, last: 0, skipped: 0 });

let st = { ...fresh(), ...(get(KS) || {}) };
let tok = get(KT);
let status = 'off', note = '', busy = null, again = false, client = null, gisLoading = false, asked = false, soon = null;
let arrived = 0; // boards this sync brought to this device
let gen = 0; // goes up when this device stops saving, so a sync already under way writes nothing more
// From the page: busy(id) is whether a line is being drawn on that board right now, and told(e) hears what a sync
// did that the person should know: { why: 'deleted', id, name } just before a board deleted on another device goes,
// { why: 'back', id, name } when one deleted here comes back, and { why: 'arrived', n } after a first sync.
const hooks = { busy: () => false, told: () => {} };
const watchers = new Set();
const saveSt = () => put(KS, st);

function live() {
  tok = get(KT);
  return !!(tok && tok.token && tok.exp - 60000 > Date.now() && String(tok.scope || '').includes(SCOPE));
}
// Signed out: 'tap' when something here is waiting to go to Drive, 'out' when nothing is (a tap then only brings in
// what the other devices saved).
const signedOut = () => (waiting() ? 'tap' : 'out');
function waiting() {
  if (Object.keys(st.deleted).length) return true;
  return store.list().some(b => { const m = st.files[b.id]; return m ? b.rev > (m.rev ?? -1) : !untouched(b); });
}
const offline = () => navigator.onLine === false;
function setStatus(s, n = '') { status = s; note = n; watchers.forEach(f => { try { if (f() === false) watchers.delete(f); } catch { watchers.delete(f); } }); }

// ---------- Drive calls ----------
async function call(method, path, body, type) {
  if (!tok?.token) throw { auth: true };
  const headers = { Authorization: 'Bearer ' + tok.token };
  if (type) headers['Content-Type'] = type;
  let r;
  try { r = await fetch(API + path, { method, headers, body }); } catch { throw { net: true }; }
  if (r.status === 401) {
    const g = get(KT);
    if (g && g.token === tok.token) put(KT, null);
    tok = null;
    throw { auth: true };
  }
  if (r.status === 404) throw { gone: true };
  if (!r.ok) throw { http: r.status };
  return r;
}
const api = async (...a) => { const r = await call(...a); return r.status === 204 ? null : r.json(); };
const json = o => JSON.stringify(o);
const props = (board, extra = {}) => ({ [TAG]: 'board', board, ...extra });

async function folderId() {
  const q = `appProperties has { key='${TAG}' and value='folder' } and trashed=false`;
  const x = await api('GET', `drive/v3/files?spaces=drive&orderBy=createdTime&pageSize=10&fields=${encodeURIComponent('files(id)')}&q=${encodeURIComponent(q)}`);
  if (x?.files?.length) return x.files[0].id;
  return (await api('POST', 'drive/v3/files?fields=id', json(FOLDER), 'application/json')).id;
}
// Every board file, the binned ones too: a board binned with `gone` set was deleted on another device.
async function boardFiles() {
  const q = `appProperties has { key='${TAG}' and value='board' }`;
  const fields = encodeURIComponent('nextPageToken,files(id,name,version,trashed,createdTime,appProperties)');
  const out = [];
  let page = '';
  do {
    const x = await api('GET', `drive/v3/files?spaces=drive&orderBy=createdTime&pageSize=1000&fields=${fields}&q=${encodeURIComponent(q)}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    out.push(...(x?.files || []));
    page = x?.nextPageToken || '';
  } while (page);
  return out;
}
async function download(id) {
  const r = await call('GET', `drive/v3/files/${id}?alt=media`);
  return fromSVG(await r.text());
}
async function create(dir, board, text) {
  const bd = 'cleanslate' + Date.now().toString(36);
  const meta = { name: fileName(board.name) + '.svg', mimeType: 'image/svg+xml', parents: [dir], appProperties: props(board.id) };
  const payload = `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json(meta)}\r\n--${bd}\r\nContent-Type: image/svg+xml\r\n\r\n${text}\r\n--${bd}--`;
  const x = await api('POST', 'upload/drive/v3/files?uploadType=multipart&fields=id,version', payload, `multipart/related; boundary=${bd}`);
  return { id: x.id, version: String(x.version) };
}
const bin = (f, board, gone) => api('PATCH', `drive/v3/files/${f}?fields=id`, json({ trashed: true, appProperties: props(board, gone ? { gone: '1' } : {}) }), 'application/json');

// ---------- one sync ----------
async function run(g = gen) {
  // Stopped while this was waiting on Drive: leave both sides as they are.
  const going = () => { if (g !== gen || !st.on) throw STOPPED; };
  let dir = null;
  const folder = async () => (dir ||= await folderId());
  const files = await boardFiles();
  going();
  const by = new Map();
  for (const f of files) {
    const id = f.appProperties?.board;
    if (id) (by.get(id) || by.set(id, []).get(id)).push(f);
  }
  // Boards deleted here: their files go to the Drive trash, marked so the other devices delete them too.
  st.binned ||= {};
  for (const [id, at] of Object.entries(st.binned)) if (Date.now() - at > 86400000) delete st.binned[id];
  for (const id of Object.keys(st.deleted)) {
    for (const f of by.get(id) || []) if (!f.trashed) { await bin(f.id, id, true); going(); }
    st.binned[id] = Date.now();
    delete st.deleted[id];
    saveSt();
    by.delete(id);
  }
  st.skipped = 0;
  const first = !st.last;
  arrived = 0;
  const ids = new Set([...store.list().map(b => b.id), ...by.keys()]);
  // One board that won't save (too big for Drive, say) doesn't stop the others: each board is tried on its own, and
  // the ones that failed are named at the end. Only a sign-in that has run out, or saving being stopped, ends it.
  const failed = [];
  for (const id of ids) {
    try {
      for (let tries = 0; ; tries++) {
        try { await one(id, by.get(id) || [], folder, going, first); break; } catch (e) {
          if (e !== RETRY || tries >= 3) throw e;
          by.set(id, (await boardFiles()).filter(f => f.appProperties?.board === id));
          going();
        }
      }
    } catch (e) {
      if (e === STOPPED || e?.auth || (e?.net && offline())) throw e;
      failed.push({ name: store.get(id)?.name || (by.get(id)?.[0]?.name || '').replace(/\.svg$/, '') || 'A board', net: !!e?.net });
    }
  }
  // A device's first sync that brought boards in: the empty board it started with has done its job.
  if (first && arrived) {
    for (const b of store.list()) if (untouched(b) && !st.files[b.id]) store.remove(b.id, 'sync');
    hooks.told({ why: 'arrived', n: arrived });
  }
  st.last = Date.now();
  saveSt();
  if (failed.length) throw { failed };
}

// What to say when some boards couldn't be saved: which.
function failedNote(failed) {
  const rest = store.list().length > failed.length ? '; your other boards are saved' : '';
  return failed.length === 1 ? `“${failed[0].name}” couldn’t be saved to Google Drive${rest}.` : `${failed.length} boards couldn’t be saved to Google Drive${rest}.`;
}

async function one(id, files, folder, going, first) {
  const open = files.filter(f => !f.trashed);
  const deleted = files.some(f => f.trashed && f.appProperties?.gone);
  const meta = st.files[id];
  // Deleted here while this sync was under way: the next one bins it.
  const dropped = () => !!st.deleted[id];
  if (dropped()) return;
  let b = store.get(id);
  if (!open.length) {
    if (!b) return; // only in the Drive trash
    if (deleted && meta && b.rev <= meta.rev) { // deleted on another device, and not drawn on here since
      // (unless a line is being drawn on it right now: then it stays, the line makes it drawn on since, and the next
      // sync brings it back rather than losing the line)
      if (hooks.busy(id)) return;
      delete st.files[id];
      saveSt();
      gone(b);
      return;
    }
    // Deleted on another device while this one wasn't saving to Drive (it stopped, and this is the first sync since
    // it started again): this device has no record of the file, so the binned file is the record. The board goes here
    // too if it holds nothing the binned file doesn't; otherwise it was drawn on since, and comes back as a new file.
    // (Only on that first sync: later, a board here with no record is one brought back from a backup file on purpose.)
    if (deleted && !meta && first) {
      const binned = files.filter(f => f.trashed && f.appProperties?.gone);
      const last = await download(binned[binned.length - 1].id);
      going();
      if (dropped()) return;
      b = store.get(id);
      if (!b) return;
      if (last?.id === id && nothingBeyond(b, last) && !hooks.busy(id)) {
        gone(b);
        return;
      }
    }
    if (untouched(b)) return;
    // New here, or drawn on again here after another device deleted it: a new file.
    const rev = b.rev, key = contentKey(b), text = toSVG(b);
    const dir = await folder();
    going();
    const made = await create(dir, b, text);
    st.files[id] = { id: made.id, version: made.version, rev, key };
    saveSt();
    return;
  }
  // Two devices each made a file for this board before either saw the other's: fold the later ones into the first
  // (which the devices that already synced with it know) and bin them.
  const [file, ...extra] = open;
  for (const x of extra) {
    const other = await download(x.id);
    going();
    if (dropped()) return;
    if (other?.id === id) store.absorb(other);
    await bin(x.id, id, false);
    going();
  }
  let remoteKey = meta?.key;
  const seen = meta && meta.id === file.id && meta.version === String(file.version) && !extra.length;
  // Not readable when last seen, and not changed since: left alone without downloading it again.
  if (seen && meta.skipped) { st.skipped++; return; }
  if (!seen) {
    const other = await download(file.id);
    going();
    if (!other || other.id !== id) { // not readable: left alone, and not downloaded again until it changes
      st.skipped++;
      st.files[id] = { ...meta, id: file.id, version: String(file.version), skipped: true };
      saveSt();
      return;
    }
    if (dropped()) return;
    remoteKey = contentKey(other);
    const here = !!store.get(id);
    if (!here) arrived++;
    store.absorb(other);
    // Deleted here in the last day, and drawn on on another device since: it's back, and the person is told why.
    if (!here && st.binned?.[id]) { delete st.binned[id]; saveSt(); hooks.told({ why: 'back', id, name: other.name }); }
  }
  b = store.get(id);
  if (!b) return;
  const name = fileName(b.name) + '.svg';
  if (contentKey(b) === remoteKey && !extra.length && file.name === name) {
    st.files[id] = { id: file.id, version: String(file.version), rev: b.rev, key: remoteKey };
    saveSt();
    return;
  }
  // Another device may have saved since the list was read; then read it again and merge that.
  const now = await api('GET', `drive/v3/files/${file.id}?fields=version`);
  if (String(now.version) !== String(file.version)) throw RETRY;
  going();
  const rev = b.rev, key = contentKey(b), text = toSVG(b);
  let x = await api('PATCH', `upload/drive/v3/files/${file.id}?uploadType=media&fields=id,version`, text, 'image/svg+xml');
  if (file.name !== name) x = await api('PATCH', `drive/v3/files/${file.id}?fields=id,version`, json({ name }), 'application/json');
  st.files[id] = { id: file.id, version: String(x.version), rev, key };
  saveSt();
}

// A board deleted on another device goes here too (and the page hears first, to say so if it's the one on screen).
function gone(b) {
  hooks.told({ why: 'deleted', id: b.id, name: b.name });
  store.remove(b.id, 'sync');
}

export function sync() {
  if (!available() || !st.on) return Promise.resolve();
  if (!live()) { setStatus(signedOut()); return Promise.resolve(); }
  if (busy) { again = true; return busy; }
  clearTimeout(soon);
  // No connection: nothing is tried until it's back (the 'online' event, below).
  if (offline()) { setStatus('offline', OFFLINE); return Promise.resolve(); }
  setStatus('busy');
  busy = run().then(() => setStatus(st.on ? 'ok' : 'off', st.skipped ? `${st.skipped === 1 ? 'One board file' : st.skipped + ' board files'} in your Drive couldn’t be read, so Clean Slate left ${st.skipped === 1 ? 'it' : 'them'} alone.` : ''), e => {
    if (!st.on || e === STOPPED) setStatus(st.on ? status : 'off');
    else if (e?.auth) setStatus(signedOut());
    else if (e?.net || (e?.failed && e.failed.every(f => f.net))) setStatus('offline', OFFLINE);
    else if (e?.failed) setStatus('error', failedNote(e.failed));
    else setStatus('error', 'Couldn’t finish saving to Google Drive.');
  }).then(() => {
    busy = null;
    if (again) { again = false; return sync(); }
  });
  return busy;
}

// A change on this page: sync a few seconds after the drawing stops.
function changed() {
  if (!available() || !st.on) return;
  clearTimeout(soon);
  if (live()) soon = setTimeout(sync, 4000); else setStatus(signedOut());
}

// ---------- signing in (Google Identity Services, in a pop-up) ----------
// Google's script loads only once the Drive option is on screen (the menu is open) or saving is on, never just for
// visiting. If it can't load, that's only said once the person has tapped to sign in; otherwise the next time the menu
// opens tries again.
function loadGis() {
  if (!available() || client) return;
  if (window.google?.accounts?.oauth2) { initClient(); return; }
  if (gisLoading) return;
  gisLoading = true;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = initClient;
  s.onerror = () => { gisLoading = false; s.remove(); if (asked) setStatus(st.on ? signedOut() : 'off', 'Google sign-in didn’t load. Check the connection.'); };
  document.head.appendChild(s);
}
function initClient() {
  if (client) return;
  client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: gotToken,
    error_callback: e => setStatus(st.on ? signedOut() : 'off', e?.type === 'popup_closed' ? '' : 'Google sign-in didn’t finish. If your browser blocks pop-ups, allow them for this page.'),
  });
  setStatus(status, note);
}
async function gotToken(r) {
  if (!r || r.error || !r.access_token || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
    setStatus(st.on ? signedOut() : 'off', 'Google Drive wasn’t allowed, so nothing was saved there. Try again and leave the Drive box ticked.');
    return;
  }
  tok = { token: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000, scope: r.scope || SCOPE, email: st.email || get(KT)?.email || '' };
  put(KT, tok);
  st.on = true;
  saveSt();
  if (!st.email) await whoami();
  sync();
}
// The account's address, to show where boards are saved and to skip Google's account chooser next time.
async function whoami() {
  try {
    const x = await api('GET', 'drive/v3/about?fields=' + encodeURIComponent('user(emailAddress)'));
    st.email = x?.user?.emailAddress || '';
    saveSt();
    if (tok && st.email) { tok.email = st.email; put(KT, tok); }
  } catch { /* shown without it */ }
}
// Google only opens its window from a tap, so this has to run inside a click handler.
function signIn() {
  asked = true;
  if (!client) { loadGis(); setStatus(status, 'Google sign-in is still loading. Tap again in a second.'); return; }
  const hint = st.email || get(KT)?.email || '';
  client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: 'select_account' });
}
// Turn it on. With a sign-in still good from earlier, no Google window at all.
async function start() {
  if (!available()) return;
  if (!live()) { signIn(); return; }
  st.on = true;
  if (!st.email && tok.email) st.email = tok.email;
  saveSt();
  if (!st.email) await whoami();
  sync();
}
function now() { if (!st.on) return start(); if (!live()) return signIn(); return sync(); }
// Stop on this device. The sign-in stays, and nothing is revoked: revoking would cancel Google's permission for
// every junkdrawer.works project. The boards stay here, and in Drive.
export function stop() {
  gen++;
  st = fresh();
  saveSt();
  clearTimeout(soon);
  again = false;
  setStatus('off');
}

// ---------- the bits of page ----------
function title() {
  return status === 'busy' ? 'Saving to Google Drive'
    : status === 'tap' ? 'Tap to sign in to Google again and save'
    : status === 'out' ? 'Sign in again to bring in changes from your other devices'
    : status === 'offline' ? OFFLINE
    : status === 'error' ? note + ' Tap to try again.'
    : 'Saved to Google Drive' + (st.last ? ' ' + ago(st.last) : '') + '. Tap to save now.';
}
const FAILED = new Set(['offline', 'error']);

// The header button: a cloud with a mark that has its own shape as well as its colour in each state (css/app.css):
// a green dot saved, an amber ring saving, a red badge with '!' when it needs a tap (signed out with changes waiting,
// or a save that failed), a hollow red ring signed out with nothing waiting, a grey dash offline.
export function chip(btn) {
  if (!available()) { btn.hidden = true; return; }
  btn.innerHTML = icon.cloud + '<i class="dot"></i>';
  // A tap that tries again and fails again says why, since a tablet shows no title on hover.
  btn.addEventListener('click', async () => {
    const tried = FAILED.has(status);
    await now();
    if (tried && FAILED.has(status)) toast(note || title(), 6000);
  });
  watch(() => { btn.hidden = !st.on; btn.dataset.s = status; btn.title = title(); btn.setAttribute('aria-label', title()); });
}

// The card in the menu: turn it on, see where boards go, save now, or stop.
export function card(host) {
  if (!host) return;
  if (!available()) { host.hidden = true; return; }
  host.hidden = false;
  function draw() {
    if (!host.isConnected) return false;
    const line = status === 'busy' ? 'Saving now.' : status === 'out' ? 'Google signs this page out after an hour. Tap <b>Save now</b> to sign back in and bring in changes from your other devices.' : status === 'tap' ? 'Google signs this page out after an hour. Tap <b>Save now</b> to sign back in; your boards wait safely here meanwhile.' : status === 'error' || note ? esc(note) : st.last ? `Last saved ${ago(st.last)}.` : '';
    host.innerHTML = st.on
      ? `<h2>Google Drive</h2><p class="small">Your boards are saved to <b>${esc(st.email || 'your Google Drive')}</b>, in <span class="path">My Drive › Clean Slate</span>, one picture per board. Do the same on another device and the same boards show up there. ${line}</p>
        <div class="row"><button class="btn" type="button" data-a="now"${status === 'busy' ? ' disabled' : ''}>${icon.cloud}Save now</button><button class="btn quiet" type="button" data-a="off">Stop on this device</button></div>`
      : `<h2>Save to Google Drive</h2><p class="small">Keep your boards in your own Google Drive, in a “Clean Slate” folder, as pictures you can open there. Do the same on your other devices and the same boards show up on each, ready to draw on. <a href="https://junkdrawer.works/privacy.html">Privacy</a></p>${note ? `<p class="small err">${esc(note)}</p>` : ''}
        <div class="row"><button class="btn primary" type="button" data-a="on">${icon.cloud}Save to Google Drive</button></div>`;
    host.querySelector('[data-a="on"]')?.addEventListener('click', start);
    host.querySelector('[data-a="now"]')?.addEventListener('click', now);
    // Asks first, like Clear: red, and back to normal after a few seconds without a second tap.
    const off = host.querySelector('[data-a="off"]');
    if (off) twoStep(off, 'Tap again to stop', stop);
  }
  watch(draw);
}
function watch(f) { watchers.add(f); f(); }
// The menu, with the Drive card in it, has opened: Google's sign-in gets ready for a tap.
export const shown = () => loadGis();

export const syncState = () => ({ ...st, status, note });

export function initSync({ busy, told } = {}) {
  if (busy) hooks.busy = busy;
  if (told) hooks.told = told;
  store.on(({ id, why }) => {
    if (why === 'sync' || why === 'tab' || why === 'unkept') return;
    if (why === 'removed' && st.on && st.files[id]) {
      st.deleted[id] = st.files[id].id;
      delete st.files[id];
      saveSt();
    }
    changed();
  });
  if (!available()) return;
  if (st.on) {
    loadGis(); // ready before the first tap
    status = live() ? 'ok' : signedOut();
    if (live()) setTimeout(sync, 0);
  }
  document.addEventListener('visibilitychange', () => {
    if (!st.on) return;
    // Back after Google's hour is up: say so now, not at the next timer.
    if (!live()) { if (document.visibilityState === 'visible' && status !== signedOut()) setStatus(signedOut()); return; }
    // Leaving the page: save what's waiting now rather than in a few seconds.
    if (document.visibilityState === 'hidden' && soon) { clearTimeout(soon); soon = null; sync(); }
    else if (document.visibilityState === 'visible' && Date.now() - st.last > 30000) sync();
  });
  setInterval(() => { if (document.visibilityState === 'visible' && st.on && live() && !busy) sync(); else if (st.on && !live() && status !== signedOut()) setStatus(signedOut()); }, 90000);
  // The connection is back: what's waiting goes now, rather than at the next line drawn or the next timer.
  window.addEventListener('online', () => { if (st.on && live()) sync(); });
  window.addEventListener('storage', e => {
    if (e.key === KS || e.key === KT) {
      st = { ...fresh(), ...(get(KS) || {}) };
      tok = get(KT);
      setStatus(st.on ? (live() ? 'ok' : signedOut()) : 'off');
    }
  });
}
