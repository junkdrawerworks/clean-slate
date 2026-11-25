// How strokes look, where they are, and what the eraser touches. Drawing on a canvas is here too, for the board on
// screen, its picture and the thumbnails, so all three come out the same.
import { getStroke } from './vendor/perfect-freehand.js';
import { BACKGROUNDS, SPACING, shade, clears } from './board.js';

// perfect-freehand turns the points into the outline of a pen line: wider where the pen pressed harder. A finger or
// a mouse has no pressure, so their lines get it from speed instead (sim). A highlighter is the same width all along.
const THINNING = 0.6; // how much a pen line narrows from firm to light
function options(s, last) {
  if (s.tool === 'rub') return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last };
  if (s.tool === 'marker') return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last };
  return {
    size: s.size, thinning: s.sim ? 0.45 : THINNING, smoothing: 0.55, streamline: s.sim ? 0.5 : 0.35,
    simulatePressure: !!s.sim, last, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 },
  };
}

function triples(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

// How many times a stroke's outline has been traced (perfect-freehand run over its points, or a shape's lines worked
// out). Only the tests read it, to show that what's kept for a stroke isn't traced again.
export const outlinesTraced = { n: 0 };
export const outline = (s, last = true) => (outlinesTraced.n++, getStroke(triples(s.pts), options(s, last)));

// The size a shape needs to look as heavy as the pen line it's snapped from: perfect-freehand draws a pen line
// 2 x size x (0.5 - thinning x (0.5 - pressure)) wide, so a line pressed firmly snaps to a bolder shape and a light one
// to a finer one (at the line's middle pressure). A highlighter is the same width all along, and a finger's or the
// mouse's line is close to its size, so theirs stay as they are.
export function weight(s) {
  if (s.tool !== 'pen' || s.sim) return s.size;
  const ps = [];
  for (let i = 2; i < s.pts.length; i += 3) ps.push(s.pts[i]);
  if (!ps.length) return s.size;
  ps.sort((a, b) => a - b);
  return s.size * 2 * (0.5 - THINNING * (0.5 - ps[ps.length >> 1]));
}

// A shape is drawn as clean lines through its points, not as a pen outline: its corners, closed back to the first
// for a rectangle, triangle or ellipse, and with a head on the end of an arrow (and on both ends of a double arrow).
// An arrow's head goes with the line's size (so it looks the same at whatever zoom it was drawn), and is never more than
// 0.4 of the arrow's shaft, the last two of its points. A double arrow's two heads are the same size.
export function headLength(s) {
  const p = s.pts, n = p.length;
  const shaft = n >= 6 ? Math.hypot(p[n - 3] - p[n - 6], p[n - 2] - p[n - 5]) : 0;
  return Math.min(0.4 * shaft, s.size * 5);
}
export function shapeLines(s) {
  outlinesTraced.n++;
  const pts = triples(s.pts).map(([x, y]) => [x, y]);
  const lines = [pts];
  if ((s.shape === 'arrow' || s.shape === 'double') && pts.length >= 2) {
    const L = headLength(s);
    const head = (a, b) => { const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); return [[b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)], b, [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)]]; };
    lines.push(head(pts[pts.length - 2], pts[pts.length - 1]));
    if (s.shape === 'double') lines.push(head(pts[1], pts[0]));
  }
  return lines;
}

const paths = new WeakMap(), boxes = new WeakMap(), outlines = new WeakMap();
// A pen, highlighter or rub-out line's outline, made once per stroke too.
export function outlineOf(s) {
  let o = outlines.get(s);
  if (!o) outlines.set(s, o = outline(s));
  return o;
}

// The stroke as a canvas path, made once per stroke (a stroke never changes once it's made).
export function path(s) {
  let p = paths.get(s);
  if (!p) {
    if (s.shape) {
      p = new Path2D();
      shapeLines(s).forEach((line, i) => {
        line.forEach(([x, y], j) => (j ? p.lineTo(x, y) : p.moveTo(x, y)));
        if (i === 0 && s.shape === 'closed') p.closePath();
      });
    } else p = toPath2D(outlineOf(s));
    paths.set(s, p);
  }
  return p;
}
export function toPath2D(poly) {
  const p = new Path2D();
  if (!poly.length) return p;
  p.moveTo(poly[0][0], poly[0][1]);
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}
// The same outline as SVG path data.
export function pathData(poly) {
  if (!poly.length) return '';
  const f = n => Math.round(n * 10) / 10;
  let d = `M${f(poly[0][0])} ${f(poly[0][1])}Q`;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    d += `${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)} `;
  }
  return d.trimEnd() + 'Z';
}

// A photo as the eraser and the lasso see it: a filled rectangle, its corners in order.
const asShapes = new WeakMap();
function solid(s) {
  if (s.tool !== 'photo') return s;
  let r = asShapes.get(s);
  if (!r) {
    const [x0, y0, , x1, y1] = s.pts;
    asShapes.set(s, r = { ...s, tool: 'pen', shape: 'closed', fill: 1, size: 0, pts: [x0, y0, 1, x1, y0, 1, x1, y1, 1, x0, y1, 1] });
  }
  return r;
}

// The box a stroke fits in, with room for its width.
export function bounds(s) {
  let b = boxes.get(s);
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const r = (s.shape === 'arrow' || s.shape === 'double' ? headLength(s) : 0) + s.size * 0.8 + 1;
    b = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
    boxes.set(s, b);
  }
  return b;
}

// Everything drawn on a board, or null for an empty one.
export function contentBounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    if (s.tool === 'rub') continue; // rubbing out where nothing is drawn doesn't make the drawing bigger
    const b = bounds(s);
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// What shows of the drawing: everything drawn, less the lines and outlined shapes that the rub-outs that clear them have
// cleared completely (the frame of a picture of the board, or Show it all). A line partly rubbed out counts whole.
export function visibleBounds(strokes) {
  const rubs = strokes.filter(s => s.tool === 'rub');
  return contentBounds(rubs.length ? strokes.filter(s => s.tool === 'rub' || !cleared(s, rubs)) : strokes);
}
// (Whether any of the stroke shows, rubs being the board's rub-outs: the lasso picks up only a line that does.)
export const shows = (s, rubs) => !cleared(s, rubs);
function cleared(s, rubs) {
  if (s.fill || s.tool === 'photo') return false;
  const b = bounds(s);
  const later = rubs.filter(u => { const o = bounds(u); return clears(u, s) && o.x0 <= b.x1 && o.x1 >= b.x0 && o.y0 <= b.y1 && o.y1 >= b.y0; });
  if (!later.length) return false;
  const gone = (x, y) => covered(s, x, y, later);
  if (!s.shape) {
    for (let i = 0; i < s.pts.length; i += 3) if (!gone(s.pts[i], s.pts[i + 1])) return false;
    return outlineOf(s).every(([x, y]) => gone(x, y));
  }
  // A shape's lines, every half its width along them, at the middle and both edges of the line.
  const half = s.size / 2, step = Math.max(half, 0.5);
  for (const p of edges(s)) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[Math.min(i + 1, p.length - 1)], len = Math.hypot(x1 - x0, y1 - y0);
      const nx = len ? -(y1 - y0) / len * half : half, ny = len ? (x1 - x0) / len * half : 0;
      for (let j = 0, n = Math.max(1, Math.ceil(len / step)); j <= n; j++) {
        const x = x0 + (x1 - x0) * j / n, y = y0 + (y1 - y0) * j / n;
        if (!gone(x, y) || !gone(x + nx, y + ny) || !gone(x - nx, y - ny)) return false;
      }
    }
  }
  return true;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}
// An outline's edges in runs of 16, each with the box it fits in, so a test near one part of a long line skips the rest.
const runs = new WeakMap();
function runsOf(poly) {
  let out = runs.get(poly);
  if (!out) {
    out = [];
    const n = poly.length;
    for (let i = 0; i < n; i += 16) {
      const e = Math.min(n, i + 16);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = i; k <= e; k++) { const [x, y] = poly[k % n]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      out.push([i, e, x0, y0, x1, y1]);
    }
    runs.set(poly, out);
  }
  return out;
}
// Is (x, y) inside the polygon, filled the way a canvas fills a path (nonzero: where an outline crosses itself on a
// tight turn, the overlap is still ink)?
function inside(poly, x, y) {
  let wind = 0;
  const n = poly.length;
  for (const [i0, i1, , y0, x1, y1] of runsOf(poly)) {
    if (y < y0 || y > y1 || x > x1) continue; // (an edge only counts where it crosses level with the point, to its right)
    for (let i = i0; i < i1; i++) {
      const [xj, yj] = poly[i], [xi, yi] = poly[(i + 1) % n];
      if ((yj <= y) !== (yi <= y)) {
        const cross = (xi - xj) * (y - yj) - (x - xj) * (yi - yj);
        if (yi > yj ? cross > 0 : cross < 0) wind += yi > yj ? 1 : -1;
      }
    }
  }
  return wind !== 0;
}
// The nearest point of the polygon's edge to (x, y) that's within r, or null.
function nearEdge(poly, x, y, r) {
  const n = poly.length;
  let best = r * r, at = null;
  for (const [i0, i1, x0, y0, x1, y1] of runsOf(poly)) {
    if (x < x0 - r || x > x1 + r || y < y0 - r || y > y1 + r) continue;
    for (let i = i0; i < i1; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      const px = ax + t * dx, py = ay + t * dy, d = (px - x) ** 2 + (py - y) ** 2;
      if (d <= best) { best = d; at = [px, py]; }
    }
  }
  return at;
}
const lift = (b, ax, ay, bx, by, r) => Math.max(ax, bx) + r < b.x0 || Math.min(ax, bx) - r > b.x1 || Math.max(ay, by) + r < b.y0 || Math.min(ay, by) - r > b.y1;
// A shape's lines as the eraser sees them: a closed one goes back to its first corner.
function edges(s) {
  const lines = shapeLines(s);
  if (s.shape === 'closed') lines[0] = [...lines[0], lines[0][0]];
  return lines;
}

// Does the eraser, moving from (ax, ay) to (bx, by) with radius r, touch this stroke's ink as it's drawn? A pen or
// highlighter line is as wide as its outline (wider where the pen pressed harder); a shape is its lines at their width,
// and inside it too if it's filled. With rubs, the board's rub-outs near the eraser, ink a later rub-out has cleared
// isn't there to touch: the eraser takes the line only where some of it still shows.
export function touches(s, ax, ay, bx, by, r, rubs = null) {
  const later = rubs?.filter(u => clears(u, s) && !lift(bounds(u), ax, ay, bx, by, r)); // (none for a photo)
  s = solid(s);
  const box = bounds(s);
  if (lift(box, ax, ay, bx, by, r)) return false;
  const shows = later?.length ? (ex, ey, edge) => showing(s, ex, ey, r, later, edge) : () => true;
  // Steps along the eraser's move, each no longer than half the eraser, so a quick swipe misses nothing in between.
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1e-6, r / 2)));
  const lines = s.shape ? edges(s) : null, poly = s.shape ? null : outlineOf(s);
  const reach2 = (r + s.size * 0.5) ** 2;
  for (let k = 0; k <= steps; k++) {
    const ex = ax + (bx - ax) * k / steps, ey = ay + (by - ay) * k / steps;
    if (ex + r < box.x0 || ex - r > box.x1 || ey + r < box.y0 || ey - r > box.y1) continue;
    if (poly) {
      const edge = nearEdge(poly, ex, ey, r);
      if ((edge || inside(poly, ex, ey)) && shows(ex, ey, edge)) return true;
      continue;
    }
    let on = s.fill && inside(lines[0], ex, ey);
    for (const p of lines) {
      if (on) break;
      if (p.length === 1) { on = (p[0][0] - ex) ** 2 + (p[0][1] - ey) ** 2 <= reach2; continue; }
      for (let i = 0; i + 1 < p.length && !on; i++) on = segDist2(ex, ey, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= reach2;
    }
    if (on && shows(ex, ey, null)) return true;
  }
  return false;
}

// Is any of the stroke's ink inside the eraser's circle at (ex, ey), radius r, still showing, not cleared by one of the
// later rub-outs? Tried at points that are on the ink: the middle of the line (a shape's lines, or the pen's path)
// every half eraser along it, the middle of the circle and points around it, the outline's corners in it, and the
// nearest point of its edge.
function showing(s, ex, ey, r, later, edge) {
  const r2 = r * r, shows = (x, y) => !covered(s, x, y, later);
  const half = s.shape ? s.size / 2 : 0, reach2 = (r + half) ** 2;
  for (const p of s.shape ? edges(s) : [triples(s.pts)]) {
    if (p.length === 1) { if ((p[0][0] - ex) ** 2 + (p[0][1] - ey) ** 2 <= reach2 && shows(p[0][0], p[0][1])) return true; continue; }
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1], dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
      if (segDist2(ex, ey, x0, y0, x1, y1) > reach2) continue;
      const t = len2 ? Math.max(0, Math.min(1, ((ex - x0) * dx + (ey - y0) * dy) / len2)) : 0;
      if (shows(x0 + t * dx, y0 + t * dy)) return true;
      const n = Math.ceil(Math.sqrt(len2) / Math.max(1e-6, r / 2));
      for (let j = 0; j <= n; j++) { const x = x0 + dx * j / n, y = y0 + dy * j / n; if ((x - ex) ** 2 + (y - ey) ** 2 <= reach2 && shows(x, y)) return true; }
    }
  }
  const area = s.shape ? (s.fill ? edges(s)[0] : null) : outlineOf(s);
  if (area) {
    for (const [k, n] of [[0, 1], [0.5, 6], [0.95, 12]]) {
      for (let i = 0; i < n; i++) {
        const x = ex + Math.cos(i / n * 2 * Math.PI) * r * k, y = ey + Math.sin(i / n * 2 * Math.PI) * r * k;
        if (inside(area, x, y) && shows(x, y)) return true;
      }
    }
  }
  if (!s.shape) {
    for (const [x, y] of outlineOf(s)) if ((x - ex) ** 2 + (y - ey) ** 2 <= r2 && shows(x, y)) return true;
    if (edge && shows(edge[0], edge[1])) return true;
  }
  return false;
}

// Is the point (x, y) of stroke s cleared by one of the rub-outs that clear it (drawn after it, and in its group if
// they have one)?
export function covered(s, x, y, rubs) {
  for (const u of rubs) {
    if (!clears(u, s)) continue;
    const b = bounds(u);
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    if (inside(outlineOf(u), x, y)) return true;
  }
  return false;
}

// ---------- drawing on a canvas ----------
// A view is where the board sits on screen: (x, y) is the board point at the top-left corner and z the zoom, so a
// board point (bx, by) is on screen at ((bx - x) * z, (by - y) * z).

// The colour and lines, in screen space, crisp at any zoom. w and h are in CSS pixels; the context is scaled to them.
export function drawBackground(ctx, board, view, w, h) {
  const look = BACKGROUNDS[board.bg] || BACKGROUNDS.white;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, w, h);
  if (board.pattern === 'blank') return;
  let step = SPACING;
  while (step * view.z < 12) step *= 2; // zoomed far out, every other line, so the board doesn't go solid
  const px = step * view.z;
  const first = v => Math.ceil(v / step) * step;
  const sx = bx => (bx - view.x) * view.z, sy = by => (by - view.y) * view.z;
  const hair = 1 / (ctx.getTransform().a || 1); // one device pixel
  const crisp = v => Math.round(v / hair) * hair + hair / 2;
  if (board.pattern === 'dots') {
    ctx.fillStyle = look.dot;
    const r = Math.max(0.9, Math.min(2.2, 1.3 * Math.sqrt(view.z)));
    for (let by = first(view.y); sy(by) < h + px; by += step) {
      for (let bx = first(view.x); sx(bx) < w + px; bx += step) {
        ctx.beginPath(); ctx.arc(sx(bx), sy(by), r, 0, Math.PI * 2); ctx.fill();
      }
    }
    return;
  }
  ctx.strokeStyle = look.line;
  ctx.lineWidth = hair * Math.max(1, Math.min(2, Math.round(view.z)));
  ctx.beginPath();
  for (let by = first(view.y); sy(by) < h + 1; by += step) { const y = crisp(sy(by)); ctx.moveTo(0, y); ctx.lineTo(w, y); }
  if (board.pattern === 'grid') {
    for (let bx = first(view.x); sx(bx) < w + 1; bx += step) { const x = crisp(sx(bx)); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  }
  ctx.stroke();
}

// How a highlighter goes down: multiplied into the light boards, so it only darkens and black writing under it stays
// black; screened onto the slate, so it only lightens: chalk writing under it stays white and the colour stays bright.
export const markerOp = bg => (BACKGROUNDS[bg]?.dark ? 'screen' : 'multiply');

// One stroke, in board space, on a context already set up for it. (backdrop: see inkLayer.)
export function drawStroke(ctx, s, bg, op = markerOp(bg), backdrop = null) {
  ctx.globalAlpha = 1;
  if (s.tool === 'rub' && backdrop) {
    ctx.save();
    ctx.clip(path(s));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(backdrop, 0, 0);
    ctx.restore();
    return;
  }
  ctx.globalCompositeOperation = s.tool === 'rub' ? 'destination-out' : s.tool === 'marker' ? op : 'source-over';
  const color = s.tool === 'rub' ? '#000' : shade(s, bg);
  if (s.shape) {
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (s.fill) { ctx.fillStyle = color; ctx.fill(path(s)); }
    ctx.stroke(path(s));
  } else {
    ctx.fillStyle = color;
    ctx.fill(path(s));
  }
}

// Strokes, in board space. scale is device pixels per CSS pixel.
//
// A rub-out in a group (see clears in board.js) clears only its group's lines, not everything under it, so it can't
// clear the ink layer as it goes: each line it clears is drawn on its own first, the group's rub-outs after it cut out
// of that, and the rest laid on the layer as the line itself would go (a highlighter multiplied or screened). A line
// with none goes straight on, and a rub-out with no group clears the layer, as before.
export function drawStrokes(ctx, strokes, bg, view, w, h, scale, backdrop = null) {
  const x0 = view.x, y0 = view.y, x1 = view.x + w / view.z, y1 = view.y + h / view.z;
  ctx.save();
  ctx.setTransform(scale * view.z, 0, 0, scale * view.z, -view.x * view.z * scale, -view.y * view.z * scale);
  const op = markerOp(bg), own = groupRubs(strokes);
  for (const s of strokes) {
    const b = bounds(s);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    if ((s.tool === 'rub' && s.grp) || s.tool === 'photo') continue; // (cut out of its group's lines, below; photos: drawPhotos)
    const cut = own && s.grp && s.tool !== 'rub' ? own.get(s.grp)?.filter(u => u.t > s.t && meets(bounds(u), b)) : null;
    if (cut?.length) drawCut(ctx, s, cut, c => drawStroke(c, s, bg, 'source-over'), s.tool === 'marker' ? op : 'source-over');
    else drawStroke(ctx, s, bg, op, backdrop);
  }
  ctx.restore();
}
const meets = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
// Each group's rub-outs, in order (group -> rub-outs), or null when no rub-out has a group.
export function groupRubs(strokes) {
  let own = null;
  for (const s of strokes) if (s.tool === 'rub' && s.grp) { own ||= new Map(); (own.get(s.grp) || own.set(s.grp, []).get(s.grp)).push(s); }
  return own;
}
// Stroke s drawn (by draw) on a canvas of its own the size of the part of the screen it covers, the rub-outs `rubs` cut
// out of it, and the rest laid on ctx with op. ctx's transform is board space to its pixels, scaling and moving only.
let cutCanvas = null;
function drawCut(ctx, s, rubs, draw, op) {
  const T = ctx.getTransform(), b = bounds(s);
  const ax = Math.max(0, Math.floor(b.x0 * T.a + T.e) - 1), ay = Math.max(0, Math.floor(b.y0 * T.d + T.f) - 1);
  const bx = Math.min(ctx.canvas.width, Math.ceil(b.x1 * T.a + T.e) + 1), by = Math.min(ctx.canvas.height, Math.ceil(b.y1 * T.d + T.f) + 1);
  if (bx <= ax || by <= ay) return;
  cutCanvas ||= document.createElement('canvas');
  if (cutCanvas.width < bx - ax || cutCanvas.height < by - ay) { cutCanvas.width = Math.max(cutCanvas.width, bx - ax); cutCanvas.height = Math.max(cutCanvas.height, by - ay); }
  const cc = cutCanvas.getContext('2d');
  cc.setTransform(1, 0, 0, 1, 0, 0);
  cc.globalCompositeOperation = 'source-over';
  cc.globalAlpha = 1;
  cc.clearRect(0, 0, bx - ax, by - ay);
  cc.setTransform(T.a, 0, 0, T.d, T.e - ax, T.f - ay);
  draw(cc);
  cc.globalCompositeOperation = 'destination-out';
  cc.globalAlpha = 1;
  cc.fillStyle = '#000';
  for (const u of rubs) cc.fill(path(u));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = op;
  ctx.drawImage(cutCanvas, 0, 0, bx - ax, by - ay, ax, ay, bx - ax, by - ay);
  ctx.restore();
}

// ---------- photos ----------
// Each photo's picture, decoded once (its data: URL -> an image), and who to tell when one is ready to draw.
const images = new Map(), ready = new Set();
export const onPhoto = fn => ready.add(fn);
function imageFor(data) {
  let img = images.get(data);
  if (!img) {
    img = new Image();
    images.set(data, img);
    img.src = data;
    img.decode().then(() => { for (const f of ready) f(); }, () => {});
  }
  return img;
}
const drawn = img => img.complete && img.naturalWidth > 0;
// Once every photo on the board has been decoded (before a picture of it is made, which can't wait for one).
export function photosReady(board, strokes = board.strokes) {
  const list = strokes.filter(s => s.tool === 'photo' && board.photos?.[s.src]).map(s => imageFor(board.photos[s.src]));
  return Promise.all(list.map(img => (drawn(img) ? null : img.decode().catch(() => {}))));
}
// The photos, under the ink, in board space. A rub-out never clears one (see clears in board.js). (A photo whose
// picture hasn't come, or is still being decoded, is a faint grey box meanwhile.)
export function drawPhotos(ctx, board, strokes, view, w, h, scale) {
  if (!strokes.some(s => s.tool === 'photo')) return;
  const x0 = view.x, y0 = view.y, x1 = view.x + w / view.z, y1 = view.y + h / view.z;
  ctx.save();
  ctx.setTransform(scale * view.z, 0, 0, scale * view.z, -view.x * view.z * scale, -view.y * view.z * scale);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const s of strokes) {
    if (s.tool !== 'photo') continue;
    const b = bounds(s);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    const data = board.photos?.[s.src], img = data && imageFor(data);
    const [px, py, , qx, qy] = s.pts;
    if (img && drawn(img)) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, px, py, qx - px, qy - py); }
    else { ctx.fillStyle = 'rgba(128, 128, 128, 0.18)'; ctx.fillRect(px, py, qx - px, qy - py); }
  }
  ctx.restore();
}
// The board's colour and lines, and its photos on them: what the ink goes on. (ctx scaled to CSS pixels, as for
// drawBackground.)
export function drawUnder(ctx, board, view, w, h, scale, strokes = board.strokes) {
  drawBackground(ctx, board, view, w, h);
  drawPhotos(ctx, board, strokes, view, w, h, scale);
}

// The ink goes on its own layer, so a rub-out clears the ink and leaves the board's colour and lines. On the light
// boards the layer starts transparent, a rub-out clears it, and it goes onto the board multiplied, so highlighters stay
// see-through over the lines. On the slate it starts as a copy of the board (backdrop, the canvas with just the board
// drawn on it), so a highlighter screens onto the board's lines as well as the ink; a rub-out paints the board back,
// and the layer is laid on top.
export function layerFor(canvas, layer) {
  const L = layer || document.createElement('canvas');
  if (L.width !== canvas.width || L.height !== canvas.height) { L.width = canvas.width; L.height = canvas.height; }
  return L;
}
export function inkLayer(L, strokes, bg, view, w, h, scale, backdrop = null) {
  const lc = L.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = 'source-over';
  lc.globalAlpha = 1;
  lc.clearRect(0, 0, L.width, L.height);
  if (backdrop) lc.drawImage(backdrop, 0, 0);
  drawStrokes(lc, strokes, bg, view, w, h, scale, backdrop);
  return L;
}
// (r, if given, is the part of it to lay down: [x, y, w, h] in the canvas's own pixels.)
export function laydown(ctx, L, bg, r = null) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = BACKGROUNDS[bg]?.dark ? 'source-over' : 'multiply';
  if (r) ctx.drawImage(L, r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]);
  else ctx.drawImage(L, 0, 0);
  ctx.restore();
}
// The board and its drawing, on ctx (whose transform scales CSS pixels to its own).
export function drawBoard(ctx, board, view, w, h, scale, strokes = board.strokes, layer = null) {
  drawUnder(ctx, board, view, w, h, scale, strokes);
  const L = inkLayer(layerFor(ctx.canvas, layer), strokes, board.bg, view, w, h, scale, BACKGROUNDS[board.bg]?.dark ? ctx.canvas : null);
  laydown(ctx, L, board.bg);
  return L;
}

// The view that fits everything drawn (or an empty stretch of board) into w x h, with a margin around it.
export function fitView(board, w, h, margin = 24, maxZoom = 1) {
  const c = visibleBounds(board.strokes) || { x0: 0, y0: 0, x1: w, y1: h };
  const cw = Math.max(1, c.x1 - c.x0), ch = Math.max(1, c.y1 - c.y0);
  const z = Math.min(maxZoom, (w - 2 * margin) / cw, (h - 2 * margin) / ch);
  return { x: (c.x0 + c.x1) / 2 - w / 2 / z, y: (c.y0 + c.y1) / 2 - h / 2 / z, z };
}

// The margin of board round a picture of the drawing c: a share of the drawing, so a signature isn't lost in it and a
// line drawn zoomed far out isn't cut at its edge. The SVG uses it too.
export const marginFor = c => Math.min(40, Math.max(12, 0.06 * Math.max(c.x1 - c.x0, c.y1 - c.y0)));
// The frame of a picture of the drawing c: where it starts on the board, its size in board units, and its pixels per
// unit, two or more so something small comes out at least about 1600 pixels on its long side, up to eight, and never
// past `max` pixels on a side (phones refuse very big canvases).
export function frame(c, { max = 4096, margin = marginFor(c) } = {}) {
  const w = c.x1 - c.x0 + 2 * margin, h = c.y1 - c.y0 + 2 * margin;
  return { x: c.x0 - margin, y: c.y0 - margin, w, h, k: Math.min(8, Math.max(2, 1600 / Math.max(w, h)), max / w, max / h) };
}
// The whole board as a picture on a new canvas: everything that shows, with a margin of board around it.
export function picture(board, opts) {
  const { x, y, w, h, k } = frame(visibleBounds(board.strokes) || { x0: 0, y0: 0, x1: 800, y1: 600 }, opts);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBoard(ctx, board, { x, y, z: 1 }, w, h, k);
  return canvas;
}

// The whole drawing as a picture `long` pixels on its long side, and where it is on the board: board point (x, y) is at
// pixel ((x - pic.x) * pic.k, (y - pic.y) * pic.k). For Ask Claude, which is told the same.
export function scaledPicture(board, long = 1600) {
  const { x, y, w, h } = frame(visibleBounds(board.strokes) || { x0: 0, y0: 0, x1: 800, y1: 600 });
  const k = long / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBoard(ctx, board, { x, y, z: 1 }, w, h, k);
  return { canvas, x, y, k };
}

// What's on screen as a picture: the board as it shows in a w x h window (CSS pixels) at view, at scale pixels to each,
// two or more so it's sharp, and never past 4096 on a side.
export function viewPicture(board, view, w, h, scale = 2) {
  const k = Math.min(Math.max(2, scale), 4096 / w, 4096 / h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBoard(ctx, board, view, w, h, k);
  return canvas;
}

// A small picture for the list of boards.
let thumbLayer = null;
export function thumbnail(board, w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const view = fitView(board, w, h, 6, 0.6);
  thumbLayer ||= document.createElement('canvas');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawBoard(ctx, { ...board, pattern: view.z < 0.25 ? 'blank' : board.pattern }, view, w, h, scale, board.strokes, thumbLayer);
  return canvas;
}
