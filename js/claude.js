// Ask Claude: a picture of the board (and for Tidy it up, an outline of its lines) sent to Anthropic's API with the
// owner's own API key, and what comes back, checked. No page needed except for send() and the key, which use fetch and
// localStorage (so test/unit.test.mjs runs the rest in Node).
//
// The request is made with a plain fetch, not Anthropic's SDK. Clean Slate is ES modules served as they are, with no
// build step and no npm dependencies in what it ships, and it has to keep working as the one-file copy
// (dist/clean-slate.html). Bringing in the SDK for one POST would mean vendoring a bundle bigger than the app. So the
// request is built here by hand, to the shapes in Anthropic's docs (platform.claude.com/docs): the Messages API,
// structured outputs (output_config.format), server-side refusal fallbacks, and the header that lets a browser call the
// API directly.
//
// Nothing is sent until the owner taps an action. The key is kept in its own localStorage entry, apart from the
// settings, so it never goes into Drive, a backup, a picture or an SVG, and it goes only to api.anthropic.com.
import { makeStroke, nextTs, clears, INKS, MARKERS } from './board.js';
import { dragShape } from './shapes.js';
import { bounds, weight } from './ink.js';

export const API = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-opus-5-5';
export const VERSION = '2026-10-21';
// Server-side fallback: a request that Opus 5.5's safety checks decline is tried again, in the same call, on the model
// Anthropic recommends for that kind of decline (fallbacks: 'default' needs this beta).
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const KEY_ENTRY = 'clean-slate.claude-key';
export const PICTURE_PX = 1600; // the picture's long side, in pixels (about 2,000-2,500 tokens, under a cent)
export const TIMEOUT = 180000; // ms before a request is given up on
// Room for the thinking as well as the answer (thinking counts towards it). It's a ceiling, not what's spent.
export const MAX_TOKENS = 16000;
// How hard Claude thinks for each action. Tidy it up is spatial reasoning over the whole drawing (which strokes make one
// box, what lines up with what, where an arrow meets a box), so it gets medium, Opus 5.5's own default. Type it out is
// reading, not reasoning, and Opus 5.5 reads pictures well even at low, so it gets low: quicker and cheaper. Ask about
// it can be anything from "what does this say" to "check my maths", so medium.
export const EFFORT = { tidy: 'medium', type: 'low', ask: 'medium' };

// Dollars per million tokens, [input, output, cache reads], for the model asked for and the models a declined request
// can fall back to. (Anthropic's pricing page, November 2026.) One not listed is counted at the dearest of them.
const PRICES = { 'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5] };
const DEAREST = [5, 25, 0.5];
const NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-opus-5': 'Claude Opus 5', 'claude-opus-4-8': 'Claude Opus 4.8' };

// ---------- the key ----------
export function readKey() { try { return localStorage.getItem(KEY_ENTRY) || ''; } catch { return ''; } }
export function keepKey(key) {
  const k = String(key).trim();
  try { if (k) localStorage.setItem(KEY_ENTRY, k); else localStorage.removeItem(KEY_ENTRY); return true; } catch { return false; }
}
export function forgetKey() { try { localStorage.removeItem(KEY_ENTRY); } catch { /* storage blocked */ } }
// What's wrong with a key as typed, or '' when it looks like one. (Anthropic's keys start sk-ant-; the API decides.)
export function keyTrouble(key) {
  const k = String(key).trim();
  if (!k) return 'Paste a key first.';
  if (/\s/.test(k)) return 'That has a space in it. Copy the key again, on its own.';
  if (!/^sk-ant-/.test(k)) return 'That doesn’t look like an Anthropic API key: they start sk-ant-.';
  return '';
}

// ---------- the requests ----------
// Every request: one picture of the board, then the text. Images first is what the vision docs recommend.
function request({ effort, system, text, image, format }) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort, ...(format && { format }) },
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } }, { type: 'text', text }] }],
  };
}

export function headers(key) {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': VERSION,
    'anthropic-beta': FALLBACK_BETA,
    // The API takes a request straight from a browser only with this header. It's the owner's own key, on their own
    // device, sent only from this page to Anthropic, which is the case the header is for.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

const BOARD = 'The picture is a whiteboard drawn in Clean Slate, a drawing app, with a pen, a finger or a mouse. It may hold handwriting, sketches, shapes, highlighter, and photos the person put under their ink. The faint grid, ruled lines or dots are the board’s paper, not part of the drawing.';

// Type it out: the handwriting as text.
export function typeRequest(image) {
  return request({
    effort: EFFORT.type,
    image,
    system: `${BOARD} You transcribe the handwriting on it into plain text the person can copy.`,
    text: `Type out the handwriting on this board.

- Write exactly what's written, in reading order (top to bottom, left to right, one part of the board at a time). Don't correct spelling or add words.
- Keep lists as lists: "- " for bullets and checkboxes, "1. " for numbered ones, as written. Keep headings as their own line.
- Where a word can't be read, put [unreadable] in its place, or your best guess followed by [?] when you're fairly sure. Never guess silently.
- Leave out drawings, arrows and shapes, unless a label belongs with them: then write the label.
- Plain text only: no Markdown headings, bold, tables or code blocks, and nothing before or after the transcription. If there's no handwriting at all, say "No handwriting on this board."`,
  });
}

// Ask about it: the person's own question.
export function askRequest(image, question) {
  return request({
    effort: EFFORT.ask,
    image,
    system: `${BOARD} The person who drew it is asking you about it. Answer in plain text they'll read on a phone or a tablet: short paragraphs, "- " lists where they help, and **bold** only for the key result. No headings, tables, code blocks or LaTeX: write maths inline, like 3 × 4 = 12. If part of the board can't be read, say which part rather than guessing. Be direct and brief.`,
    text: String(question).trim().slice(0, 2000),
  });
}

// Tidy it up's answer: which strokes to replace, and the clean shapes to put in their place, in board coordinates.
// (Numbers can't be limited in a schema, so they're checked when the answer comes back.)
export const TIDY_SCHEMA = {
  type: 'object',
  properties: {
    shapes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          replaces: { type: 'array', items: { type: 'string' }, description: 'The ids of the strokes this shape replaces, from the list.' },
          kind: { type: 'string', enum: ['rect', 'ellipse', 'line', 'arrow', 'double'] },
          x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' },
        },
        required: ['replaces', 'kind', 'x0', 'y0', 'x1', 'y1'],
        additionalProperties: false,
      },
    },
  },
  required: ['shapes'],
  additionalProperties: false,
};

// A pen line Tidy it up may replace: not a highlight, a rub-out or a photo, and not touched by a rub-out (a clean shape
// in its place would bring back what was rubbed out of it).
export function tidyable(b) {
  const rubs = b.strokes.filter(s => s.tool === 'rub');
  const touched = s => { const o = bounds(s); return rubs.some(u => { const r = bounds(u); return clears(u, s) && r.x0 <= o.x1 && r.x1 >= o.x0 && r.y0 <= o.y1 && r.y1 >= o.y0; }); };
  return b.strokes.filter(s => s.tool === 'pen' && !touched(s));
}

const n0 = v => Math.round(v);
const colourName = s => (s.tool === 'marker' ? MARKERS : INKS)[s.color]?.name.toLowerCase() || s.color || '';
// A few points along a line, in board coordinates: its corners (Douglas-Peucker), then at most 12 of them.
function fewPoints(s) {
  const p = [];
  for (let i = 0; i < s.pts.length; i += 3) p.push([s.pts[i], s.pts[i + 1]]);
  if (s.shape) return p.length > 12 ? p.filter((_, i) => i % Math.ceil(p.length / 12) === 0) : p;
  const b = bounds(s), eps = Math.max(1, 0.03 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0));
  let v = simplify(p, eps);
  if (v.length > 12) { const step = (v.length - 1) / 11; v = Array.from({ length: 12 }, (_, i) => v[Math.round(i * step)]); }
  return v;
}
function simplify(p, eps) {
  if (p.length < 3) return p.slice();
  let worst = 0, at = 0;
  const [a, b] = [p[0], p[p.length - 1]];
  for (let i = 1; i < p.length - 1; i++) { const d = segDist(p[i], a, b); if (d > worst) { worst = d; at = i; } }
  if (worst <= eps) return [a, b];
  return [...simplify(p.slice(0, at + 1), eps).slice(0, -1), ...simplify(p.slice(at), eps)];
}
function segDist(q, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]);
}
const SHAPE_NAMES = { line: 'line', arrow: 'arrow', double: 'double arrow' };
const shapeName = s => (s.shape === 'closed' ? (s.pts.length === 12 ? 'rectangle' : s.pts.length > 30 ? 'ellipse' : 'polygon') : SHAPE_NAMES[s.shape]);

// The outline of the board's lines for Tidy it up: each pen line that may be replaced, under a short id (1, 2, 3, … in
// drawing order), with its colour, size, box and a few points; and what's fixed (highlights, photos, lines with rub-outs
// on them) as just its box. ids maps each short id back to the stroke's own.
export function tidyList(b, MAX = 1500) {
  const all = tidyable(b), can = all.slice(0, MAX), ids = new Map(), out = [], fixed = [];
  const yes = new Set(can.map(s => s.id)), clean = new Set(all.map(s => s.id));
  const box = s => { const o = bounds(s); return `box ${n0(o.x0)},${n0(o.y0)} to ${n0(o.x1)},${n0(o.y1)}`; };
  can.forEach((s, i) => {
    const id = String(i + 1);
    ids.set(id, s.id);
    const what = s.shape ? `pen ${shapeName(s)}${s.fill ? ' filled' : ''}` : 'pen';
    out.push(`${id} ${what} ${colourName(s)} size ${Math.round(s.size * 10) / 10} ${box(s)} pts ${fewPoints(s).map(q => `${n0(q[0])},${n0(q[1])}`).join(' ')}`);
  });
  for (const s of b.strokes) {
    if (yes.has(s.id) || s.tool === 'rub') continue;
    fixed.push(`- ${s.tool === 'photo' ? 'photo' : s.tool === 'marker' ? `highlighter ${colourName(s)}` : `pen ${colourName(s)}${clean.has(s.id) ? '' : ', partly rubbed out'}`} ${box(s)}`);
  }
  return { text: out.join('\n'), fixed: fixed.slice(0, 300).join('\n'), ids };
}

// pic: the picture, and where it is on the board: board point (x, y) is at pixel ((x - pic.x) * pic.k, (y - pic.y) * pic.k).
export function tidyRequest(b, pic) {
  const list = tidyList(b);
  const r = v => Math.round(v * 100) / 100;
  const text = `Tidy up this drawing. Find the rough, hand-drawn boxes, circles and ellipses, straight lines, arrows and double arrows (a head at each end), and give each one back as a clean shape. Look at the whole drawing together:
- One shape can be drawn in several strokes (a box drawn as four sides): replace all of them with one shape.
- Boxes in a row or a column should line up, and boxes that are clearly meant to match should be the same size.
- An arrow or a line that points at or joins a box or a circle should start and end on its edge.
- Make nearly level or upright lines exactly level or upright.

Leave everything else exactly as it is: handwriting, letters, numbers and symbols (an o, a 0, an x or a + is writing, not a shape), doodles, ticks, underlines and crossings-out that belong to writing, and anything you're unsure of. Only name strokes from the list. If nothing needs tidying, return no shapes.

Coordinates: the picture is ${pic.w} × ${pic.h} pixels. Pixel (px, py) is board point (${r(pic.x)} + px / ${r(pic.k)}, ${r(pic.y)} + py / ${r(pic.k)}). Everything below, and your answer, is in board coordinates (y grows downwards).

Each shape: "replaces" lists the ids of the strokes it replaces; "kind" is rect, ellipse, line, arrow or double. For rect and ellipse, (x0, y0) and (x1, y1) are opposite corners of the box it fills (an ellipse fills its box; a circle is an ellipse in a square box). For line, arrow and double, (x0, y0) is where it starts and (x1, y1) where it ends: an arrow's head is at (x1, y1). Clean shapes here are level, so leave a box or an ellipse drawn clearly at a slant as it is.

Pen strokes that may be replaced (id, kind, colour, size, box, a few points along it):
${list.text || '(none)'}${list.fixed ? `\n\nOn the board too, and fixed (never name these):\n${list.fixed}` : ''}`;
  return {
    body: request({
      effort: EFFORT.tidy,
      image: pic,
      format: { type: 'json_schema', schema: TIDY_SCHEMA },
      system: `${BOARD} You tidy up the shapes in a drawing, the way a careful person would redraw them with a ruler, and leave the writing alone.`,
      text,
    }),
    ids: list.ids,
  };
}

// ---------- sending ----------
// The answer, or an error from Anthropic, as { status, json, retryAfter }. A network failure, Cancel or the timeout
// throws (an AbortError for the last two).
export async function send(key, body, signal) {
  const res = await fetch(API, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, retryAfter: +res.headers.get('retry-after') || 0 };
}

// ---------- reading the answer ----------
// What came back: { kind: 'text', text, cut } (cut: it ran out of room partway), or { kind: 'refusal', explanation },
// with model (who answered) and fallback (a fallback model answered, not Opus 5.5).
export function readReply(json) {
  const model = typeof json?.model === 'string' ? json.model : MODEL;
  const fallback = (json?.usage?.iterations || []).some(i => i?.type === 'fallback_message') && model !== MODEL;
  if (json?.stop_reason === 'refusal') return { kind: 'refusal', explanation: String(json.stop_details?.explanation || ''), model, fallback };
  const text = (Array.isArray(json?.content) ? json.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('').trim();
  return { kind: 'text', text, cut: json?.stop_reason === 'max_tokens', model, fallback };
}
export const modelName = m => NAMES[m] || String(m);

// What a request cost, in dollars, from the usage Anthropic reports. With a fallback, usage.iterations has each model's
// attempt (the top-level counts are only the one that answered), each at its own model's prices.
export function cost(json) {
  const u = json?.usage;
  if (!u) return 0;
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [{ ...u, model: json.model }];
  let usd = 0;
  for (const p of parts) {
    const [i, o, c] = PRICES[p?.model] || (p?.model === undefined ? PRICES[MODEL] : DEAREST);
    const n = k => (Number.isFinite(+p?.[k]) && +p[k] > 0 ? +p[k] : 0);
    usd += (n('input_tokens') * i + n('cache_creation_input_tokens') * i * 1.25 + n('cache_read_input_tokens') * c + n('output_tokens') * o) / 1e6;
  }
  return usd;
}
export function costText(usd) {
  if (!(usd > 0)) return '';
  const cents = usd * 100;
  if (cents < 0.1) return 'under 0.1¢';
  if (cents < 100) return `about ${cents < 10 ? cents.toFixed(1).replace(/\.0$/, '') : Math.round(cents)}¢`;
  return `about $${usd.toFixed(2)}`;
}

// A plain message for an error from Anthropic (status and body as they came back).
export function problem(status, json, retryAfter = 0) {
  const e = json?.error || {}, msg = typeof e.message === 'string' ? e.message : '', code = e.details?.error_code;
  if (status === 401) {
    // (An organization that can't take requests from a browser at all, whatever the key: the docs give this message.)
    if (/^CORS requests are not allowed/i.test(msg)) return 'Anthropic won’t take requests from a browser for this key’s organization (zero data retention, or its settings). A key from another organization would work.';
    return 'Anthropic didn’t accept that API key. It may have been mistyped, deleted or expired: check it under Settings → Claude in the menu, or make a new one in the Claude Console.';
  }
  if (status === 402 || e.type === 'billing_error') return 'Anthropic turned this down over billing. Check the payment details under Billing in the Claude Console.';
  if (status === 429) {
    if (code === 'enforced_spend_limit_reached') return 'Your API account has reached its monthly spend limit, so Anthropic is turning requests down until it resets. You can raise it under Limits in the Claude Console.';
    return `Too many requests to Anthropic just now. Try again in ${retryAfter > 1 ? `${Math.ceil(retryAfter)} seconds` : 'a minute'}.`;
  }
  if (status === 529 || e.type === 'overloaded_error') return 'Claude is overloaded just now. Try again in a minute or two.';
  if (status === 400) {
    // (Anthropic's wording can change, so these only choose a plainer message; anything else shows theirs.)
    if (/credit balance/i.test(msg)) return 'Your API credit has run out. Add some under Billing in the Claude Console, then try again.';
    if (/spend limit|usage limit/i.test(msg)) return 'Your API account has reached a spend limit you set. You can raise it in the Claude Console.';
    return `Anthropic couldn’t take this request${msg ? `: ${msg.slice(0, 300)}` : '.'}`;
  }
  if (status === 403) return 'This API key isn’t allowed to use Claude Opus 5.5. Check its workspace in the Claude Console.';
  if (status === 413) return 'The picture of this board was too big to send.';
  if (status === 504 || e.type === 'timeout_error') return 'Anthropic took too long to answer. Try again.';
  if (status >= 500) return 'Something went wrong at Anthropic. Try again in a moment.';
  return `Anthropic answered with an error (${status})${msg ? `: ${msg.slice(0, 300)}` : '.'}`;
}
export const OFFLINE = 'You’re offline. Ask Claude needs a connection; everything else works without one.';
export const UNREACHABLE = 'Couldn’t reach Anthropic. Check the connection and try again.';
export const TOO_LONG = `Claude took too long to answer (over ${TIMEOUT / 60000} minutes), so it was stopped. Try again.`;

// ---------- Tidy it up's answer, checked ----------
// The answer as JSON, or null when it isn't any.
export function parseTidy(text) {
  try { const o = JSON.parse(text); return o && typeof o === 'object' && Array.isArray(o.shapes) ? o : null; } catch { return null; }
}

const KINDS = ['rect', 'ellipse', 'line', 'arrow', 'double'];
const FAR = 1e6; // no board point is this far out
const flatten = pts => pts.flatMap(([x, y]) => [x, y, 0.5]);

// The change Tidy it up makes to board b, from Claude's answer (parsed) and the short ids it was sent (ids): one undo
// step, { add, remove }, and how many shapes it puts in, or { count: 0 } when there's nothing to change. Everything in
// the answer is checked: an id that isn't one of the lines it may replace (or is no longer on the board, or was named
// already) is left out; a shape with a number that isn't one, or is far from the lines it replaces, or is too small to
// see, is left out; and no stroke the answer doesn't name is touched. Each shape keeps the colour and size of the first
// line it replaces (as a snapped shape does: its weight), and a filled one stays filled.
export function tidyStep(b, answer, ids) {
  if (!answer || !Array.isArray(answer.shapes)) return { count: 0 };
  const can = new Map(tidyable(b).map(s => [s.id, s])), used = new Set(), specs = [];
  for (const sh of answer.shapes.slice(0, 500)) {
    if (!sh || typeof sh !== 'object' || !KINDS.includes(sh.kind) || !Array.isArray(sh.replaces)) continue;
    const nums = [sh.x0, sh.y0, sh.x1, sh.y1];
    if (!nums.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < FAR)) continue;
    const olds = [];
    for (const a of sh.replaces.slice(0, 50)) {
      const id = typeof a === 'string' && ids?.get(a);
      if (id && can.has(id) && !used.has(id) && !olds.includes(can.get(id))) olds.push(can.get(id));
    }
    if (!olds.length) continue;
    // Near the lines it replaces: within half their size (and at least 40 units) of their box.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of olds) { const o = bounds(s); x0 = Math.min(x0, o.x0); y0 = Math.min(y0, o.y0); x1 = Math.max(x1, o.x1); y1 = Math.max(y1, o.y1); }
    const m = Math.max(40, 0.5 * Math.hypot(x1 - x0, y1 - y0));
    const [a0, b0, a1, b1] = nums;
    if (Math.min(a0, a1) < x0 - m || Math.max(a0, a1) > x1 + m || Math.min(b0, b1) < y0 - m || Math.max(b0, b1) > y1 + m) continue;
    const w = Math.abs(a1 - a0), h = Math.abs(b1 - b0);
    if ((sh.kind === 'rect' || sh.kind === 'ellipse') ? w < 2 || h < 2 : Math.hypot(w, h) < 2) continue;
    const first = olds[0];
    const r = dragShape(sh.kind, a0, b0, a1, b1);
    const spec = { tool: 'pen', color: INKS[first.color] ? first.color : 'ink', size: first.shape ? first.size : weight(first), sim: 0, pts: flatten(r.pts), shape: r.shape, fill: first.fill && r.shape === 'closed' ? 1 : 0 };
    // (A clean shape given back as it was changes nothing.)
    if (olds.length === 1 && first.shape === spec.shape && first.pts.length === spec.pts.length && first.pts.every((v, i) => Math.abs(v - spec.pts[i]) < 0.6)) continue;
    for (const s of olds) used.add(s.id);
    specs.push({ spec, olds });
  }
  if (!specs.length) return { count: 0 };
  const t0 = nextTs(b, specs.length);
  const add = specs.map(({ spec }, i) => makeStroke(spec, t0 + i));
  return { step: { add, remove: specs.flatMap(x => x.olds) }, count: add.length };
}
