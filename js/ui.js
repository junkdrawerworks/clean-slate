// Small page helpers and the icons, drawn inline so nothing loads from elsewhere.
export const $ = (sel, el = document) => el.querySelector(sel);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;

export const icon = {
  pen: svg('<path d="M4 20l1.2-4.6L16.6 4a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14.5 6.1l3.4 3.4"/>'),
  marker: svg('<path d="M9.4 15.6l-3-3L15.8 3.2a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3z"/><path d="M6.4 12.6L4.6 17.4l2 2 4.8-1.8"/><path d="M3 21h7" stroke-width="2.6"/>'),
  eraser: svg('<path d="M8.6 19.5L3.9 14.8a1.8 1.8 0 0 1 0-2.6l8.3-8.3a1.8 1.8 0 0 1 2.6 0l5.3 5.3a1.8 1.8 0 0 1 0 2.6l-7.9 7.7z"/><path d="M8.2 8.1l7.6 7.6"/><path d="M12.5 19.5H20"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  boards: svg('<rect x="3.5" y="5.5" width="13" height="13" rx="2"/><path d="M7.5 3.5h11a2 2 0 0 1 2 2v11"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5h6V7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  download: svg('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  share: svg('<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  cloud: svg('<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.5 9 4.75 4.75 0 0 0 7 18.5z"/>'),
  open: svg('<path d="M4 19V6.5A1.5 1.5 0 0 1 5.5 5h4l2 2h7A1.5 1.5 0 0 1 20 8.5V19"/><path d="M4 19h16"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>'),
  line: svg('<path d="M5 19L19 5"/>'),
  arrow: svg('<path d="M5 19L19 5"/><path d="M10 5h9v9"/>'),
  double: svg('<path d="M5 19L19 5"/><path d="M11 5h8v8"/><path d="M13 19H5v-8"/>'),
  filled: svg('<rect x="4" y="6" width="16" height="12" rx="1.5" fill="currentColor"/>'),
  ellipseFilled: svg('<ellipse cx="12" cy="12" rx="8.5" ry="6.5" fill="currentColor"/>'),
  fit: svg('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
};

let toastTimer = 0, toastEnd = null, toastGo = null, toastWired = false;
// A short message at the bottom of the screen. With an action, { label, act, end }, it carries a button for as long as
// it shows: act() runs on a tap, and end() when it goes without one (its time is up, or another message took its place).
// Its time stands still while the keyboard is on it or the pointer is over it, and runs on (3 s more) once they leave.
// Once it has faded, it's emptied, so no unseen button is left to Tab to or a screen reader to read.
export function toast(msg, ms = 2600, action = null) {
  const el = $('#toast');
  if (!el) return;
  if (!toastWired) wire(el);
  const was = toastEnd;
  toastEnd = null;
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.classList.toggle('act', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    const end = action.end || (() => {});
    btn.addEventListener('click', () => {
      if (toastEnd !== end) return;
      toastEnd = null;
      clearTimeout(toastTimer);
      fade(el);
      action.act();
    });
    el.append(' ', btn);
    toastEnd = end;
  }
  el.classList.add('on');
  toastGo = () => {
    fade(el);
    const f = toastEnd;
    toastEnd = null;
    f?.();
  };
  if (!held(el)) toastTimer = setTimeout(toastGo, ms);
  was?.();
}
function fade(el) {
  el.classList.remove('on', 'act');
  toastGo = null;
  setTimeout(() => { if (!el.classList.contains('on')) el.textContent = ''; }, 250);
}
// (Only a pointer that hovers holds it: a phone or tablet can leave :hover on the spot last tapped, and a message there
// would then never go.)
const held = el => el.contains(document.activeElement) || (matchMedia('(hover: hover)').matches && el.matches(':hover'));
function wire(el) {
  toastWired = true;
  const hold = () => { if (toastGo) clearTimeout(toastTimer); };
  // (after the event: focus or the pointer may be moving within it)
  const letGo = () => setTimeout(() => { if (toastGo && !held(el)) { clearTimeout(toastTimer); toastTimer = setTimeout(toastGo, 3000); } });
  el.addEventListener('focusin', hold);
  el.addEventListener('pointerenter', hold);
  el.addEventListener('focusout', letGo);
  el.addEventListener('pointerleave', letGo);
}

// Takes the message away now, without its end() (for an action that can no longer be taken).
export function untoast() {
  clearTimeout(toastTimer);
  toastEnd = null;
  const el = $('#toast');
  if (el) fade(el);
}

export function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 300 * 86400 ? 'numeric' : undefined });
}

// A button that asks once and acts on the second tap within a few seconds. A second tap that comes too quickly to be
// an answer (a double tap, or a tap that bounced) only asks: the question has to be on screen before it's answered.
// A button named by aria-label is named by `said` while it asks, so a screen reader hears the question too.
const SURE = 400; // ms
export function twoStep(btn, ask, act, said = '') {
  let armed = 0;
  const label = btn.innerHTML, name = btn.getAttribute('aria-label');
  const set = on => {
    btn.innerHTML = on ? ask : label;
    btn.classList.toggle('armed', on);
    if (name != null) btn.setAttribute('aria-label', on ? said || ask : name);
  };
  btn.addEventListener('click', () => {
    const since = Date.now() - armed;
    if (armed && since < SURE) return;
    if (armed && since < 4000) { armed = 0; set(false); act(); return; }
    armed = Date.now();
    set(true);
    setTimeout(() => { if (armed && Date.now() - armed >= 4000) { armed = 0; set(false); } }, 4100);
  });
}

// Runs fn, which rebuilds the buttons in container, and puts the keyboard's focus back on the new button that matches
// the one it was on (by its data-color, data-size and so on), so picking a colour from the keyboard doesn't throw the
// focus out to the page. A button tapped or clicked has already let go of focus, so it's left alone.
const KEYS = ['color', 'size', 'mode', 'kind', 'fill', 'bg', 'pattern'];
export function keepFocus(container, fn) {
  const was = document.activeElement;
  const key = was && was !== container && container.contains(was) ? KEYS.find(k => k in was.dataset) : null;
  const value = key && was.dataset[key];
  fn();
  if (!key || was.isConnected) return;
  const sel = `[data-${key}${value ? `="${CSS.escape(value)}"` : ''}]`;
  (container.querySelector(sel) || container.querySelector('[aria-pressed="true"]'))?.focus({ preventScroll: true });
}

export const fileName = s => (String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Board').slice(0, 80);
