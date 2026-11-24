// Uses Clean Slate in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// A pen, fingers and a mouse draw on it through Chrome's own input (so pressure, palms and two-finger taps are the
// real events), then two browser contexts share a stand-in Google Drive as two devices.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the end).
// `drive`, when set, is a stand-in Drive (test/fake-google.mjs) answering under /googleapis/ over a real connection.
let net = 'up', release = false, drive = null;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  if (drive && req.url.startsWith('/googleapis/')) { drive.serve(req, res); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
const wait = ms => new Promise(r => setTimeout(r, ms));
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await wait(100); }
};

// Real input through Chrome: a pen with pressure, fingers, and the mouse.
function hands(page, cdp) {
  const mouse = (type, x, y, o = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...o });
  return {
    async pen(pts, { hold = 0, beforeUp, ...o } = {}) {
      const p = { pointerType: 'pen', ...o };
      await mouse('mousePressed', pts[0][0], pts[0][1], { ...p, force: pts[0][2] ?? 0.5 });
      for (const [x, y, f] of pts.slice(1)) await mouse('mouseMoved', x, y, { ...p, force: f ?? 0.5 });
      if (hold) await wait(hold); // the pen held still at the end
      await beforeUp?.(); // (a look at the page with the pen still down)
      const [x, y] = pts[pts.length - 1];
      await mouse('mouseReleased', x, y, { ...p, force: 0 });
    },
    penDown: (x, y) => mouse('mousePressed', x, y, { pointerType: 'pen', force: 0.5 }),
    penMove: (x, y) => mouse('mouseMoved', x, y, { pointerType: 'pen', force: 0.6 }),
    penUp: (x, y) => mouse('mouseReleased', x, y, { pointerType: 'pen', force: 0 }),
    penHover: (x, y) => mouse('mouseMoved', x, y, { pointerType: 'pen', force: 0, button: 'none', buttons: 0 }),
    // (each point is [x, y], or [x, y, radius] for a contact bigger or smaller than a fingertip)
    touch: (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, r = 8], i) => ({ x, y, id: i + 1, radiusX: r, radiusY: r })) }),
    async swipe(from, to, steps = 8) {
      await this.touch('touchStart', [from]);
      for (let i = 1; i <= steps; i++) await this.touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]);
      await this.touch('touchEnd', []);
    },
    async tap(n) {
      const pts = [[300, 400], [360, 420], [420, 440]].slice(0, n);
      await this.touch('touchStart', pts);
      await wait(60);
      await this.touch('touchEnd', []);
    },
  };
}
const toastText = (p = page) => p.evaluate(() => { const t = document.querySelector('#toast'); return t.classList.contains('on') ? t.textContent : ''; });
const line = (x0, y0, x1, y1, n = 16, f = () => 0.5) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, f(i / n)]);
const count = page => page.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes.length);
const lastStroke = page => page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); return b.strokes[b.strokes.length - 1]; });
const view = page => page.evaluate(() => cleanSlate.surface.view);
// Show it all, back to 100% and Ctrl + = and − ease the board into place: this waits until it's there.
const settled = (p = page) => until(() => p.evaluate(() => !cleanSlate.surface.easing), 2000, 'the board eases into place');

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

// (counting each time the page asks the browser to keep its boards)
await page.addInitScript(() => {
  const ask = navigator.storage.persist.bind(navigator.storage);
  navigator.storage.persist = () => { window.askedToKeep = (window.askedToKeep || 0) + 1; return ask(); };
});
await page.goto(base);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => document.fonts.ready);
const cdp = await ctx.newCDPSession(page);
const h = hands(page, cdp);

// A new board, with the hint, and fingers drawing (no pen seen yet).
assert.equal(await page.isVisible('#hint'), true, 'an empty board says how it works');
assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('#hint')).color, getComputedStyle(document.querySelector('#hint b')).color]), ['rgba(40, 50, 60, 0.72)', 'rgba(40, 50, 60, 0.78)'], 'dark enough to read (4.5:1) on the light boards');
assert.equal(await page.textContent('#boardName'), 'Board 1');
assert.equal(await page.isHidden('#cloud'), true, 'no Drive button away from the real address');
// The hint makes way as soon as a line starts (it would be drawn straight through), and comes back if the line comes
// to nothing: here a second finger soon after made it a pinch.
const hintShows = () => page.evaluate(() => getComputedStyle(document.querySelector('#hint')).opacity);
await h.touch('touchStart', [[200, 300]]);
await h.touch('touchMove', [[210, 300]]);
await h.touch('touchStart', [[210, 300], [350, 400]]);
await h.touch('touchMove', [[205, 300], [355, 400]]);
await h.touch('touchEnd', []);
await until(async () => (await hintShows()) === '1', 2000, 'the hint comes back when a line turns into a pinch');
assert.equal(await count(page), 0);
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
await h.touch('touchStart', [[200, 300]]);
for (let i = 1; i <= 4; i++) await h.touch('touchMove', [[200 + i * 25, 300 + i * 2.5]]);
await wait(250);
assert.equal(await hintShows(), '0', 'the hint makes way as soon as a line starts');
for (let i = 5; i <= 8; i++) await h.touch('touchMove', [[200 + i * 25, 300 + i * 2.5]]);
await h.touch('touchEnd', []);
assert.equal(await count(page), 1, 'a finger draws before any pen has been used');
assert.equal(await page.evaluate(() => window.askedToKeep), 1, 'the first line asks the browser to keep the boards');
assert.equal(await page.isHidden('#hint'), true, 'the hint goes once something is drawn');
// A finger drawing a line, then a second finger to pinch: the pinch starts from where the fingers are, so the board
// doesn't leap, and the line is kept.
await h.touch('touchStart', [[200, 500]]);
for (let i = 1; i <= 10; i++) { await h.touch('touchMove', [[200 + i * 30, 500]]); await wait(40); }
await h.touch('touchStart', [[500, 500], [600, 500]]);
await h.touch('touchMove', [[501, 500], [600, 500]]);
await h.touch('touchMove', [[501, 500], [601, 500]]);
const vp = await view(page);
await h.touch('touchEnd', []);
assert.ok(Math.abs(vp.z - 1) < 0.02 && Math.abs(vp.x) < 5 && Math.abs(vp.y) < 5, `a second finger after a line barely moves the board: ${JSON.stringify(vp)}`);
assert.equal(await count(page), 2, 'and the line is kept');
assert.equal(await page.evaluate(() => window.askedToKeep), 1, 'and only the first');
await page.keyboard.press('Control+z');
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));

// The pen: pressure makes the line wider where it pressed harder.
// (The page says it found the pen once the pen lifts, so it isn't spent while the person writes.)
let penDownToast = null;
await h.pen(line(200, 450, 700, 450, 40, t => 0.1 + 0.9 * t), { beforeUp: async () => { penDownToast = await toastText(); } });
assert.equal(penDownToast, '', 'nothing pops up while the pen is down');
assert.equal(await count(page), 2, 'the pen draws');
assert.equal(await page.evaluate(() => cleanSlate.settings.penSeen), true);
const pressures = await page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); const p = b.strokes[1].pts; return [p[2], p[p.length - 1], b.strokes[1].sim]; });
assert.ok(pressures[0] < 0.3 && pressures[1] > 0.8 && pressures[2] === 0, `the pen's pressure is kept: ${pressures}`);
assert.equal(await toastText(), 'Pen found: it draws, and a finger moves the board. Change that under Fingers in the menu.', 'the page says the pen was found, and where to change what fingers do');
// A pen's pressure 0 while it's down is its lightest touch: a light line that starts at 0 doesn't start fat.
await h.pen([[200, 520, 0], [210, 520, 0], [220, 520, 0], [230, 520, 0.15], [240, 520, 0.15], [260, 520, 0.15]]);
const light = (await lastStroke(page)).pts.filter((_, i) => i % 3 === 2);
assert.ok(light.every(p => p < 0.2), `a light line that starts at pressure 0 starts light: ${light}`);
await page.keyboard.press('Control+z');

// Once a pen is in use, a finger moves the board instead of drawing; a touch while the pen is down is a palm.
await wait(700);
const v0 = await view(page);
await h.swipe([500, 500], [400, 450]);
let v1 = await view(page);
assert.equal(await count(page), 2, 'a finger no longer draws');
assert.ok(Math.abs(v1.x - v0.x - 100) < 2 && Math.abs(v1.y - v0.y - 50) < 2, `a finger moves the board: ${JSON.stringify([v0, v1])}`);
// The first time a finger moves the board instead of drawing, the page says why, and how to have it draw: once on this
// device, not every time.
const fingersToast = 'A finger moves the board now you’ve used a pen. To draw with it, pick Always draw under Fingers in the menu.';
assert.equal(await toastText(), fingersToast, 'the first finger to move the board says why');
await page.evaluate(() => document.querySelector('#toast').classList.remove('on'));
await h.swipe([400, 450], [500, 500]);
assert.equal(await toastText(), '', 'and only the first');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('clean-slate.settings')).toldFingers), true, 'for good on this device');
v1 = await view(page);
await h.penDown(200, 600);
await h.touch('touchStart', [[600, 650]]);
for (let i = 1; i <= 10; i++) { await h.penMove(200 + i * 30, 600 + (i % 2) * 10); await h.touch('touchMove', [[600 - i * 12, 650 - i * 6]]); }
await h.penUp(500, 600);
await h.touch('touchEnd', []);
assert.equal(await count(page), 3, 'the pen still drew with a palm on the screen');
assert.deepEqual(await view(page), v1, 'the palm did not move the board');

// Two fingers zoom; a two-finger tap undoes and a three-finger tap redoes.
await wait(700);
await h.touch('touchStart', [[400, 400], [500, 400]]);
for (let i = 1; i <= 6; i++) await h.touch('touchMove', [[400 - i * 10, 400], [500 + i * 10, 400]]);
await h.touch('touchEnd', []);
v1 = await view(page);
assert.ok(v1.z > 1.9 && v1.z < 2.3, `pinching zooms: ${v1.z}`);
assert.equal(await page.textContent('#zoom'), Math.round(v1.z * 100) + '%');
await page.click('#zoom');
await settled();
assert.equal((await view(page)).z, 1, 'the zoom button goes back to 100%');
// Pinching on past 1000% and back zooms back at once, with no dead stretch to pinch back through first; and the same
// at 10%.
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 5 }));
await h.touch('touchStart', [[500, 400], [540, 400]]);
for (let d = 60; d <= 400; d += 20) await h.touch('touchMove', [[520 - d / 2, 400], [520 + d / 2, 400]]);
assert.equal((await view(page)).z, 10, 'pinching stops at 1000%');
await h.touch('touchMove', [[520 - 190, 400], [520 + 190, 400]]);
assert.ok((await view(page)).z < 10, `and pinching back by 20 px zooms out at once: ${(await view(page)).z}`);
await h.touch('touchEnd', []);
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 0.2 }));
await h.touch('touchStart', [[300, 400], [700, 400]]);
for (let d = 380; d >= 40; d -= 20) await h.touch('touchMove', [[500 - d / 2, 400], [500 + d / 2, 400]]);
assert.equal((await view(page)).z, 0.1, 'pinching stops at 10%');
await h.touch('touchMove', [[500 - 30, 400], [500 + 30, 400]]);
assert.ok((await view(page)).z > 0.1, `and spreading back by 20 px zooms in at once: ${(await view(page)).z}`);
await h.touch('touchEnd', []);
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
// Ctrl + one notch of a mouse wheel zooms one step, about as far as Ctrl + = does; a trackpad pinch's small steps add
// up smoothly.
await page.mouse.move(512, 400);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -100);
await until(async () => (await view(page)).z > 1, 2000, 'Ctrl + wheel zooms');
const zw = (await view(page)).z;
assert.ok(zw > 1.2 && zw < 1.3, `one Ctrl + wheel notch zooms one step: ${zw}`);
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -3);
await until(async () => Math.abs((await view(page)).z / zw - Math.exp(0.6)) < 0.02, 2000, 'small Ctrl + wheel steps zoom smoothly');
await page.keyboard.up('Control');
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
// A quick small pinch, or a short two-finger scroll, moves the board and isn't taken for a tap (which would undo).
await h.touch('touchStart', [[450, 400], [550, 400]]);
for (let i = 1; i <= 4; i++) { await h.touch('touchMove', [[450 - i * 3, 400], [550 + i * 3, 400]]); await wait(25); }
await h.touch('touchEnd', []);
assert.ok((await view(page)).z > 1.1, 'a small pinch zooms');
assert.equal(await count(page), 3, 'and doesn’t undo');
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
await h.touch('touchStart', [[450, 400], [550, 400]]);
for (let i = 1; i <= 4; i++) { await h.touch('touchMove', [[450, 400 - i * 3.25], [550, 400 - i * 3.25]]); await wait(25); }
await h.touch('touchEnd', []);
assert.ok((await view(page)).y > 10, 'a short two-finger scroll moves the board');
assert.equal(await count(page), 3, 'and doesn’t undo');
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
await h.tap(2);
assert.equal(await count(page), 2, 'a two-finger tap undoes');
assert.equal(await toastText(), 'Undone.', 'and says so');
await h.tap(3);
assert.equal(await count(page), 3, 'a three-finger tap redoes');
assert.equal(await toastText(), 'Redone.', 'and says so');
await h.tap(3);
assert.equal(await toastText(), 'Nothing to redo.');
await until(async () => !(await toastText()), 2000, 'the gesture toast goes quickly');
await page.keyboard.press('Control+z');
assert.equal(await count(page), 2, 'Ctrl+Z undoes');
await page.keyboard.press('Control+Shift+z');
assert.equal(await count(page), 3, 'Ctrl+Shift+Z redoes');
// The rest of the keys: P, H, S and E pick the tool, 1–6 the colour, [ and ] the size (stopping at the ends), F shows it
// all, Ctrl + Y redoes, Ctrl + 0 goes back to 100%, and Ctrl + = and Ctrl + − zoom.
{
  const now = () => page.evaluate(() => JSON.parse(JSON.stringify(cleanSlate.settings)));
  for (const [key, tool] of [['h', 'marker'], ['s', 'shape'], ['e', 'eraser'], ['p', 'pen']]) {
    await page.keyboard.press(key);
    assert.equal((await now()).tool, tool, `${key.toUpperCase()} picks the ${tool}`);
  }
  for (const [key, color] of [['3', 'red'], ['6', 'purple'], ['1', 'ink']]) {
    await page.keyboard.press(key);
    assert.equal((await now()).pen.color, color, `${key} picks ${color}`);
  }
  await page.keyboard.press('h');
  await page.keyboard.press('2');
  assert.equal((await now()).marker.color, 'green', 'the number keys pick the highlighter’s colours with it in hand');
  await page.keyboard.press('1');
  await page.keyboard.press('p');
  for (let i = 0; i < 3; i++) await page.keyboard.press('[');
  assert.equal((await now()).pen.size, 0, '[ makes the line finer, down to the finest');
  for (let i = 0; i < 3; i++) await page.keyboard.press(']');
  assert.equal((await now()).pen.size, 2, '] makes it bolder, up to the boldest');
  await page.keyboard.press('[');
  assert.equal((await now()).pen.size, 1);
  await page.keyboard.press('f');
  await settled();
  assert.notDeepEqual(await view(page), { x: 0, y: 0, z: 1 }, 'F shows it all');
  await page.keyboard.press('Control+0');
  await settled();
  assert.equal((await view(page)).z, 1, 'Ctrl + 0 goes back to 100%');
  await page.keyboard.press('Control+=');
  await settled();
  assert.ok(Math.abs((await view(page)).z - 1.25) < 1e-9, 'Ctrl + = zooms in');
  await page.keyboard.press('Control+-');
  await settled();
  assert.ok(Math.abs((await view(page)).z - 1) < 1e-9, 'Ctrl + − zooms out');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  assert.equal(await count(page), 3, 'Ctrl + Y redoes');
  await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
}
// Zoomed in to write small, a pen that comes down on the percentage in the corner draws on the board under it: a dot,
// and a line that starts there and carries on to its lift. Only a finger or the mouse taps it back to 100%.
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 4 }));
await until(() => page.isVisible('#zoom'), 2000, 'the zoom shows at 400%');
{
  const chip = await page.locator('#zoom').boundingBox();
  const [cx, cy] = [chip.x + chip.width / 2, chip.y + chip.height / 2];
  await h.pen([[cx, cy]]);
  assert.equal(await count(page), 4, 'a pen dot on the zoom percentage draws');
  assert.equal((await view(page)).z, 4, 'and the board stays at 400%');
  await h.pen(line(cx, cy, cx - 200, cy - 40, 10));
  assert.equal(await count(page), 5, 'a line that starts on it draws');
  const xs = (await lastStroke(page)).pts.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(xs[0] - cx / 4) < 1 && Math.abs(xs[xs.length - 1] - (cx - 200) / 4) < 1, `all the way to the lift: ${xs}`);
  assert.equal((await view(page)).z, 4, 'still at 400%');
  await page.click('#zoom');
  await settled();
  assert.equal((await view(page)).z, 1, 'a mouse click on it still goes back to 100%');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 3);
}
// The eraser's circle follows the mouse over the board with the eraser in hand, takes a new size from [ and ] at once,
// and goes when another tool is picked.
{
  const shade = (x, y) => page.evaluate(([x, y]) => document.querySelector('#board canvas.live').getContext('2d').getImageData(x, y, 1, 1).data[3], [x, y]);
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press('e');
  await page.mouse.move(600, 560);
  await page.mouse.move(600, 600);
  await frame();
  assert.ok(await shade(600, 600) > 0, 'the eraser’s circle shows where the mouse is');
  assert.equal(await shade(625, 600), 0, 'at the Medium eraser’s size');
  await page.keyboard.press(']');
  await frame();
  assert.ok(await shade(625, 600) > 0, '] makes it the Large eraser’s circle straight away');
  await page.keyboard.press('[');
  await page.keyboard.press('p');
  await frame();
  assert.equal(await shade(600, 600), 0, 'P puts the pen in hand and the circle goes');
}

// A hand that lands just before the pen and nudges the board (no hover to warn of the pen), or a touch that starts as
// small as a fingertip and spreads into a palm: the board goes back where it was.
await wait(700);
const vh = await view(page);
await h.touch('touchStart', [[600, 500, 18]]);
for (let i = 1; i <= 5; i++) { await h.touch('touchMove', [[600 - i * 4, 500 - i * 3, 18]]); await wait(30); }
assert.notDeepEqual(await view(page), vh, 'a touch on its own moves the board');
await h.pen(line(200, 650, 400, 650, 6));
await h.touch('touchEnd', []);
assert.deepEqual(await view(page), vh, 'a pen straight after puts it back: the touch was the hand');
assert.equal(await count(page), 4, 'and draws');
await page.keyboard.press('Control+z');
await wait(700);
await h.touch('touchStart', [[600, 500, 5]]);
for (let i = 1; i <= 6; i++) { await h.touch('touchMove', [[600 - i * 8, 500 - i * 5, 5 + i * 5]]); await wait(30); }
await h.touch('touchEnd', []);
assert.deepEqual(await view(page), vh, 'a touch that spreads into a palm puts the board back');
// With Fingers on Always draw, once a pen has been used, the side of a hand still never draws: a touch far bigger than a
// fingertip draws nothing, nor does one that lands as a fingertip and spreads, while a fingertip draws.
{
  await page.evaluate(() => { cleanSlate.settings.fingers = 'draw'; });
  const n = await count(page);
  await wait(700);
  await h.touch('touchStart', [[300, 300, 30]]);
  for (let i = 1; i <= 6; i++) await h.touch('touchMove', [[300 + i * 20, 300, 30]]);
  await h.touch('touchEnd', []);
  assert.equal(await count(page), n, 'under Always draw, a touch 60 px across draws nothing');
  await h.touch('touchStart', [[300, 360, 5]]);
  for (let i = 1; i <= 8; i++) { await h.touch('touchMove', [[300 + i * 20, 360, 5 + i * 4]]); await wait(30); }
  await h.touch('touchEnd', []);
  assert.equal(await count(page), n, 'nor does a fingertip that spreads into the side of a hand');
  await h.swipe([300, 420, 8], [460, 420, 8]);
  assert.equal(await count(page), n + 1, 'a fingertip draws');
  await page.keyboard.press('Control+z');
  await page.evaluate(() => { cleanSlate.settings.fingers = 'auto'; });
  assert.deepEqual(await view(page), vh);
}
// The hand lands and drifts while the pen hovers a moment over where it will write (over a second, here): the board
// goes back as soon as the pen is close, and the hand moves it no further.
await wait(700);
await h.touch('touchStart', [[600, 500, 10]]);
for (let i = 1; i <= 5; i++) { await h.touch('touchMove', [[600 - i * 4, 500 - i * 6, 10]]); await wait(30); }
assert.notDeepEqual(await view(page), vh, 'a touch on its own moves the board');
for (let i = 1; i <= 12; i++) { await h.penHover(200 + i, 650); await h.touch('touchMove', [[580 - i * 3, 470 - i * 4, 10]]); await wait(100); }
assert.deepEqual(await view(page), vh, 'the pen hovering puts it back, and the hand moves it no further');
await h.pen(line(200, 650, 400, 650, 6));
await h.touch('touchEnd', []);
assert.deepEqual(await view(page), vh, 'nor once the pen writes');
assert.equal(await count(page), 4, 'and the pen draws');
await page.keyboard.press('Control+z');

// The eraser rubs out just where it touches: the line stays either side of it, and the board shows through. Whole
// lines takes away every line it touches. The pen's side button erases the same way with the pen in hand; undo brings
// everything back.
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
// The darkest red value in a short column of the board on screen, around the pen line at y = 450.
const column = x => page.evaluate(x => { const d = document.querySelector('#board canvas.main').getContext('2d').getImageData(x, 440, 1, 20).data; let min = 255; for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i]); return min; }, x);
await wait(100);
assert.ok(await column(452) < 120, 'the pen line is there to start with');
await page.click('[data-tool="eraser"]');
assert.equal(await page.getAttribute('[data-mode="rub"]', 'aria-pressed'), 'true', 'the eraser rubs out to begin with');
await h.pen(line(452, 425, 452, 475, 6));
assert.equal(await count(page), 4, 'a rub-out is kept like a line');
await wait(100);
assert.ok(await column(452) > 200, 'where it rubbed, the board shows through');
assert.ok(await column(300) < 120, 'the rest of the line is still there');
await page.keyboard.press('Control+z');
await wait(100);
assert.ok(await column(452) < 120, 'undo puts it back');
// While a rub-out goes on, only the part of the screen it changed is drawn again: what's on screen then is what a whole
// new frame draws (apart from a few pixels' smoothing where its edge crosses the ink).
{
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const grab = n => page.evaluate(n => { const c = document.querySelector('#board canvas.main'); window[n] = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }, n);
  const pts = Array.from({ length: 60 }, (_, i) => [250 + i * 8, 450 + Math.sin(i / 6) * 40]);
  await h.penDown(...pts[0]);
  for (const [x, y] of pts.slice(1)) await h.penMove(x, y);
  await frames();
  await grab('asDrawn');
  assert.ok(await column(410) > 200, 'the rub-out shows as it goes');
  await page.evaluate(() => cleanSlate.surface.redraw());
  await frames();
  await grab('whole');
  const [n, most] = await page.evaluate(() => { let n = 0, most = 0; for (let i = 0; i < whole.length; i++) { const d = Math.abs(whole[i] - asDrawn[i]); if (d) n++; most = Math.max(most, d); } return [n, most]; });
  assert.ok(n < 400 && most < 100, `a rub-out drawn part by part matches the whole frame: ${n} values differ, by up to ${most}`);
  await h.penUp(...pts[pts.length - 1]);
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 3);
}
await page.click('[data-mode="lines"]');
await h.pen(line(452, 425, 452, 475, 6));
assert.equal(await count(page), 2, 'Whole lines takes the line it touches');
await page.click('#undo');
assert.equal(await count(page), 3, 'undo brought it back');
await page.click('[data-mode="rub"]');
await page.click('[data-tool="pen"]');
await h.pen(line(452, 425, 452, 475, 6), { button: 'right', buttons: 2 });
assert.equal((await lastStroke(page)).tool, 'rub', 'the pen’s side button rubs out');
await page.keyboard.press('Control+z');
assert.equal(await count(page), 3);
// The side button pressed with the pen in the air rubs out nothing, wherever the pen goes, until the tip touches (it
// shows the eraser's circle); held down with the tip down it rubs out, and stops when the tip lifts.
{
  const pen = (type, x, y, o) => cdp.send('Input.dispatchMouseEvent', { type, x, y, clickCount: 1, pointerType: 'pen', ...o });
  const air = { button: 'right', buttons: 2, force: 0 }, tip = { button: 'left', buttons: 3, force: 0.5 };
  await pen('mousePressed', 452, 380, air);
  for (let i = 1; i <= 10; i++) await pen('mouseMoved', 452, 380 + i * 14, air);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.ok(await page.evaluate(() => document.querySelector('#board canvas.live').getContext('2d').getImageData(452, 520, 1, 1).data[3]) > 0, 'the side button in the air shows the eraser’s circle');
  await pen('mouseReleased', 452, 520, { button: 'right', buttons: 0, force: 0 });
  assert.equal(await count(page), 3, 'the side button pressed in the air rubs out nothing');
  assert.ok(await column(452) < 120, 'the line is untouched');
  await pen('mousePressed', 452, 400, air);
  await pen('mousePressed', 452, 410, tip);
  for (let i = 1; i <= 6; i++) await pen('mouseMoved', 452, 410 + i * 10, tip);
  await pen('mouseReleased', 452, 470, { button: 'left', buttons: 2, force: 0 });
  for (let i = 1; i <= 4; i++) await pen('mouseMoved', 452 - i * 40, 470 - i * 5, air);
  await pen('mouseReleased', 292, 450, { button: 'right', buttons: 0, force: 0 });
  assert.equal(await count(page), 4, 'held down with the tip down, it rubs out');
  assert.ok((await lastStroke(page)).pts.every((v, i) => i % 3 !== 0 || v === 452), 'until the tip lifts');
  await wait(100);
  assert.ok(await column(452) > 200 && await column(320) < 120, 'the line is cut there, and only there');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 3);
}
// Whole lines takes a line only where some of it still shows: not for a dab on blank board where it was rubbed out.
await h.pen(line(200, 380, 700, 380, 20));
await page.click('[data-tool="eraser"]');
await page.click('[data-size="2"]');
await h.pen(line(470, 380, 720, 380, 12));
assert.equal(await count(page), 5, 'the right half of a line rubbed out with the Large eraser');
await page.click('[data-mode="lines"]');
await h.pen([[650, 380]]);
assert.equal(await count(page), 5, 'a Whole lines dab where it was rubbed out leaves the line');
await h.pen([[300, 380]]);
assert.equal(await count(page), 4, 'a dab on the half that shows takes it');
for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
assert.equal(await count(page), 3);
await page.click('[data-mode="rub"]');
await page.click('[data-size="1"]');
await page.click('[data-tool="pen"]');

// Colours, sizes and the highlighter, kept for next time.
await page.click('[data-color="red"]');
await page.click('[data-size="2"]');
await page.click('[data-tool="marker"]');
assert.equal(await page.locator('.swatches [data-color]').count(), 5, 'the highlighter has its own colours');
await h.pen(line(180, 450, 720, 450, 20));
const last = await page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); return b.strokes[b.strokes.length - 1]; });
assert.equal(last.tool, 'marker');
assert.equal(last.color, 'yellow');
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('clean-slate.settings')));
assert.equal(kept.pen.color, 'red');
assert.equal(kept.pen.size, 2);
assert.equal(kept.tool, 'marker');
await page.click('[data-tool="pen"]');

// Shapes: the shapes tool drags them out, and a line held still at the end snaps to the shape it looks like.
await page.click('#tools [data-tool="shape"]');
assert.equal(await page.isVisible('#pop [data-kind="ellipse"]'), true, 'the shapes tool offers its shapes');
await page.click('#pop [data-kind="rect"]');
await h.pen(line(560, 120, 760, 220, 8));
let shape = await lastStroke(page);
assert.equal(shape.shape, 'closed');
assert.equal(shape.pts.length, 12, 'a rectangle is its four corners');
assert.equal(shape.color, 'red', 'shapes take the pen’s colour');
// A box dragged out nearly square comes out square (a tablet has no Shift key); with a mouse, Shift makes it square
// however far off.
{
  const side = s => { const x = s.pts.filter((_, i) => i % 3 === 0), y = s.pts.filter((_, i) => i % 3 === 1); return [Math.max(...x) - Math.min(...x), Math.max(...y) - Math.min(...y)]; };
  await h.pen(line(560, 240, 660, 333, 8));
  assert.deepEqual(side(await lastStroke(page)), [100, 100], 'a box 7% off square drawn with the pen is square');
  await page.mouse.move(700, 240);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(700 + i * 15, 240 + i * 5);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.deepEqual(side(await lastStroke(page)), [120, 120], 'a box dragged with Shift held is square');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
}
await page.click('#tools [data-tool="shape"]');
await page.click('#pop [data-fill]');
await page.click('#pop [data-kind="ellipse"]');
await h.pen(line(800, 120, 900, 200, 8));
shape = await lastStroke(page);
assert.equal(shape.fill, 1, 'a filled ellipse');
assert.equal(shape.pts.length, 72 * 3);
// With Filled on, the shapes tool's button shows a filled shape (a line or an arrow has nothing to fill), and says so.
const shapeButton = () => page.evaluate(() => { const b = document.querySelector('#tools [data-tool="shape"]'); return [b.getAttribute('aria-label'), b.title.replace(/ \(S\)$/, ''), b.querySelector('[fill="currentColor"]')?.tagName || 'outline']; });
assert.deepEqual(await shapeButton(), ['Shapes, filled', 'Shapes, filled', 'ellipse']);
await page.click('#tools [data-tool="shape"]');
await page.click('#pop [data-kind="rect"]');
assert.deepEqual(await shapeButton(), ['Shapes, filled', 'Shapes, filled', 'rect']);
await page.click('#tools [data-tool="shape"]');
await page.click('#pop [data-kind="arrow"]');
assert.deepEqual(await shapeButton(), ['Shapes', 'Shapes', 'outline']);
// The double arrow, a head at each end, for a measurement: the shapes button shows it once it's picked.
await page.click('#tools [data-tool="shape"]');
await page.click('#pop [data-kind="double"]');
assert.equal(await page.evaluate(() => document.querySelectorAll('#tools [data-tool="shape"] path').length), 3, 'its button shows the double arrow');
await h.pen(line(200, 700, 500, 702, 8));
shape = await lastStroke(page);
assert.equal(shape.shape, 'double', 'a double arrow');
assert.deepEqual([shape.pts[1], shape.pts[4]], [700, 700], 'level');
await page.keyboard.press('Control+z');
await page.click('#tools [data-tool="shape"]');
await page.click('#pop [data-fill]');
await page.click('#pop [data-kind="ellipse"]');
assert.deepEqual(await shapeButton(), ['Shapes', 'Shapes', 'outline'], 'Filled off');
await page.click('#tools [data-tool="pen"]');
const roughCircle = Array.from({ length: 41 }, (_, i) => { const t = i / 40 * Math.PI * 2.06; return [700 + Math.cos(t) * (60 + Math.sin(i * 2) * 3), 620 + Math.sin(t) * 55]; });
await h.pen(roughCircle, { hold: 700 });
shape = await lastStroke(page);
assert.equal(shape.shape, 'closed', 'a circle held still at the end snaps to a clean one');
assert.equal(shape.pts.length, 72 * 3);
await h.pen(roughCircle.map(([x, y]) => [x - 300, y]));
assert.equal((await lastStroke(page)).shape, undefined, 'without holding still it stays as drawn');
await h.pen(Array.from({ length: 25 }, (_, i) => [150 + i * 12, 560 + Math.sin(i) * 3]), { hold: 700 });
shape = await lastStroke(page);
assert.equal(shape.shape, 'line', 'a wobbly line held still goes straight');
assert.equal(shape.pts[1], shape.pts[4], 'and level');

// The pointer, for presenting: L (or holding the pen button down) puts it on, and what's drawn is a red trail that
// fades away about a second after the lift. Nothing is kept: no stroke, no Undo step, no change to the board. Picking
// any tool, or Esc, puts it away; a pen's eraser end still erases.
{
  const state = () => page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); return { n: b.strokes.length, changed: b.changed, undo: document.querySelector('#undo').disabled, redo: document.querySelector('#redo').disabled }; });
  const pointing = () => page.evaluate(() => [cleanSlate.surface.pointing, document.querySelector('#tools [data-tool="pen"]').getAttribute('aria-label'), document.querySelector('#tools [data-tool="pen"]').getAttribute('aria-pressed')]);
  const red = (x, y) => page.evaluate(([x, y]) => [...document.querySelector('#board canvas.live').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  let before = await state();
  await page.keyboard.press('l');
  assert.deepEqual(await pointing(), [true, 'Pointer', 'true'], 'L puts the pointer on, and the pen button shows it');
  assert.match(await toastText(), /^Pointer: its trail fades a second after you lift\./);
  await h.pen(line(300, 300, 600, 300, 10));
  const lifted = Date.now();
  // (The line being drawn goes to the screen apart from the page, so the moves may not have been drawn yet: a frame.)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const px = await red(450, 300);
  assert.ok(px[3] > 200 && px[0] > 150 && px[1] < 100, `the trail shows, red: ${px}`);
  assert.deepEqual(await state(), before, 'nothing is kept: no stroke, no Undo step, the board unchanged');
  await until(() => page.evaluate(() => cleanSlate.surface.trails === 0), 3000, 'the trail fades away');
  const gone = Date.now() - lifted;
  assert.ok(gone > 700 && gone < 1900, `about a second after the lift: ${gone} ms`);
  assert.equal((await red(450, 300))[3], 0, 'and leaves nothing on screen');
  // The mouse points too, and so does the pen with the eraser tool in hand; the pen's side button still erases.
  await page.mouse.move(300, 340); await page.mouse.down(); await page.mouse.move(500, 360); await page.mouse.up();
  await page.keyboard.press('Escape');
  assert.deepEqual(await pointing(), [false, 'Pen', 'true'], 'Esc puts it away');
  await page.keyboard.press('e');
  await page.keyboard.press('l');
  await h.pen(line(300, 380, 600, 380, 10));
  assert.deepEqual(await state(), before, 'with the eraser tool in hand, the pointer still only points');
  await h.pen(line(150, 560, 450, 560, 10), { buttons: 3 });
  assert.equal((await lastStroke(page)).tool, 'rub', 'a pen’s side button still rubs out');
  await page.keyboard.press('Control+z');
  assert.equal((await state()).n, before.n);
  before = await state();
  await page.keyboard.press('h');
  assert.deepEqual([...(await pointing()).slice(0, 1), await page.evaluate(() => cleanSlate.settings.tool)], [false, 'marker'], 'picking a tool puts it away');
  await page.keyboard.press('p');
  // Holding the pen button down, with the mouse or a finger: the pointer comes on, the pen stays the tool, and letting
  // go doesn't count as a tap on the button. A tap on any tool then puts it away.
  const pen = await page.locator('#tools [data-tool="pen"]').boundingBox(), [bx, by] = [pen.x + pen.width / 2, pen.y + pen.height / 2];
  await page.mouse.move(bx, by); await page.mouse.down(); await wait(700); await page.mouse.up();
  assert.deepEqual(await pointing(), [true, 'Pointer', 'true'], 'holding the pen button with the mouse puts the pointer on');
  await page.mouse.click(bx, by);
  assert.deepEqual(await pointing(), [false, 'Pen', 'true'], 'and a click on the pen puts it away');
  await h.touch('touchStart', [[bx, by]]); await wait(700); await h.touch('touchEnd', []);
  assert.deepEqual(await pointing(), [true, 'Pointer', 'true'], 'so does holding it with a finger');
  await until(() => page.isHidden('#pop'), 2000, 'with no pop-up');
  await page.tap('#tools [data-tool="eraser"]');
  assert.deepEqual([(await pointing())[0], await page.evaluate(() => cleanSlate.settings.tool)], [false, 'eraser'], 'tapping another tool puts it away');
  await page.keyboard.press('p');
  await wait(700);
  assert.deepEqual(await state(), before, 'and nothing it drew was kept');
}

// A line whose hold on the board is lost (its lift then lands on the toolbar), or whose lift never arrives at all, ends
// there: the next line is a line of its own, not joined on to it.
{
  await page.evaluate(() => addEventListener('pointerdown', e => { window.lastPointer = e.pointerId; }, true));
  const n = await count(page);
  await h.penDown(400, 300);
  for (let i = 1; i <= 5; i++) await h.penMove(400 + i * 10, 300);
  await page.evaluate(() => document.querySelector('#board').releasePointerCapture(window.lastPointer));
  for (let i = 1; i <= 5; i++) await h.penMove(450 + i * 10, 300 - i * 53);
  await h.penUp(500, 34);
  await h.pen(line(300, 500, 500, 500, 6));
  assert.equal(await count(page), n + 2, 'after a lost hold, the next line is its own');
  assert.ok((await lastStroke(page)).pts.every((v, i) => i % 3 !== 1 || v > 450), 'and starts where the pen came down');
  await page.evaluate(() => { for (const t of ['pointerup', 'lostpointercapture']) addEventListener(t, e => e.stopPropagation(), { capture: true, once: true }); });
  await h.pen(line(300, 540, 500, 540, 6));
  await h.pen(line(300, 580, 500, 580, 6));
  assert.equal(await count(page), n + 4, 'after a lift that never came, the next line is its own');
}

// A line drawn just before a reload (or the tab closing) is kept: the write that leaving the page starts gets finished.
for (let i = 0; i < 4; i++) {
  const n = await count(page);
  await h.pen(line(300, 600 + i * 12, 500, 600 + i * 12, 6));
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('ready'));
  assert.equal(await count(page), n + 1, `a line drawn straight before a reload is kept (${i + 1})`);
}

// The board is still there after a reload, where it was left.
const before = await count(page);
await page.evaluate(() => cleanSlate.surface.setView({ x: 30, y: 40, z: 1.5 }));
await wait(1000);
// (and the edge guard has taken its entry off again, a second after the last stroke: a reload in the middle of that is
// a test's timing, not a person's)
await until(() => page.evaluate(() => !history.state?.__edgeGuard), 3000, 'the edge guard takes its entry off');
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
assert.equal(await count(page), before, 'the drawing survived a reload');
assert.equal(await page.evaluate(() => window.askedToKeep || 0), 0, 'once only: not again on every visit');
assert.deepEqual(await view(page), { x: 30, y: 40, z: 1.5 }, 'it opens where it was left');

// Esc closes the menu from a Fingers choice and from the name box (keeping the name typed). While the menu is open, the
// board's own keys wait.
await page.click('#menuBtn');
await page.click('input[name="fingers"][value="auto"]');
await page.keyboard.press('h');
assert.equal(await page.evaluate(() => cleanSlate.settings.tool), 'pen', 'tool keys wait while the menu is open');
await page.keyboard.press('Escape');
await until(() => page.isHidden('#menu'), 2000, 'Esc closes the menu from a Fingers choice');
await page.click('#menuBtn');
await page.fill('#nameInput', 'Kitchen');
await page.keyboard.press('Escape');
await until(() => page.isHidden('#menu'), 2000, 'Esc closes the menu from the name box');
assert.equal(await page.textContent('#boardName'), 'Kitchen', 'and keeps the name typed');
// A name being typed shows on the top button a moment after typing stops, and is kept when the page is left with the
// box still open (a phone switching apps can drop the page in the background): no Enter, and no leaving the box.
await page.click('#menuBtn');
await page.fill('#nameInput', 'Kitchen draft');
await until(async () => (await page.textContent('#boardName')) === 'Kitchen draft', 2000, 'the top button follows the typing');
await page.fill('#nameInput', 'Kitchen notes');
await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
assert.equal(await page.textContent('#boardName'), 'Kitchen notes', 'a name typed and not yet confirmed is kept when the page is left');

// The menu: name, colour, lines.
await page.click('#menuBtn');
await page.fill('#nameInput', 'Kitchen plan');
await page.press('#nameInput', 'Enter');
await page.click('[data-bg="slate"]');
await page.click('[data-pattern="dots"]');
let b = await page.evaluate(() => cleanSlate.store.get(cleanSlate.current()));
assert.equal(b.name, 'Kitchen plan');
assert.equal(b.bg, 'slate');
assert.equal(b.pattern, 'dots');
assert.equal(await page.textContent('#boardName'), 'Kitchen plan');
// Tapping the colour or lines the board already has changes nothing (so there's nothing new to save to Drive).
await page.click('#bgs [data-bg="slate"]');
await page.click('#patterns [data-pattern="dots"]');
assert.deepEqual(await page.evaluate(() => { const x = cleanSlate.store.get(cleanSlate.current()); return [x.rev, x.bgAt, x.patternAt]; }), [b.rev, b.bgAt, b.patternAt], 'tapping the colour or lines already chosen changes nothing');

// Pictures and backups.
// Each says it's saved; while a picture is being made its button says so and can't be tapped again, so two quick
// taps make one file.
let downloads = 0;
page.on('download', () => downloads++);
const [png] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => { const b = document.querySelector('#savePng'); b.click(); window.working = [b.disabled, b.textContent]; b.click(); })]);
assert.deepEqual(await page.evaluate(() => window.working), [true, 'Saving…'], 'the PNG button says it’s working');
assert.equal(png.suggestedFilename(), 'Kitchen plan.png');
const pngBytes = await readFile(await png.path());
assert.equal(pngBytes.subarray(1, 4).toString(), 'PNG');
await until(async () => (await toastText()) === 'Saved Kitchen plan.png.', 2000, 'saving the PNG says so');
assert.equal(await page.textContent('#savePng'), 'PNG', 'and the button is back');
await wait(300);
assert.equal(downloads, 1, 'two quick taps made one file');
const [svg] = await Promise.all([page.waitForEvent('download'), page.click('#saveSvg')]);
assert.match(await readFile(await svg.path(), 'utf8'), /clean-slate-board/);
await until(async () => (await toastText()) === 'Saved Kitchen plan.svg.', 2000, 'saving the SVG says so');
const [backup] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
const backupPath = await backup.path();
assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).boards.length, 1);
assert.equal(await toastText(), 'Saved a backup of one board.');
await page.click('#menu [data-close]');

// Boards: a new one, back to the first, and deleting (with Undo).
await page.click('#boardsBtn');
await page.click('#newBoard');
assert.equal(await page.textContent('#boardName'), 'Board 2');
assert.equal(await count(page), 0);
// An empty board has nothing to clear and nothing to save.
await page.click('#menuBtn');
assert.equal(await page.isDisabled('#clear'), true, 'Clear waits for something to clear');
await page.click('#savePng');
await page.click('#saveSvg');
assert.equal(await toastText(), 'Nothing on this board yet.');
await wait(300);
assert.equal(downloads, 3, 'no blank picture');
await page.keyboard.press('Escape');
await h.pen(line(300, 300, 400, 350));
await page.click('#boardsBtn');
assert.equal(await page.locator('#boardList li').count(), 2);
await page.click('#boardList li:nth-child(2) button.open');
assert.equal(await page.textContent('#boardName'), 'Kitchen plan');
await page.click('#boardsBtn');
// A quick double tap on the bin only asks: 'Delete?' has to be on screen before it can be answered.
const kitchen = await page.evaluate(() => cleanSlate.current());
const shown = () => page.evaluate(() => cleanSlate.shown());
const inDb = id => page.evaluate(id => new Promise(resolve => {
  const q = indexedDB.open('clean-slate');
  q.onsuccess = () => { const g = q.result.transaction('boards').objectStore('boards').get(id); g.onsuccess = () => { resolve(!!g.result); q.result.close(); }; };
}), id);
const del = page.locator(`#boardList [data-del="${kitchen}"]`);
await wait(400); // (the list has slid in)
const bin = await del.boundingBox();
for (let i = 0; i < 2; i++) {
  await h.touch('touchStart', [[bin.x + bin.width / 2, bin.y + bin.height / 2]]);
  await h.touch('touchEnd', []);
  if (!i) await wait(90);
}
assert.equal((await shown()).length, 2, 'two quick taps on the bin leave the board');
assert.equal(await del.textContent(), 'Delete?', 'and ask');
await wait(450);
await del.click();
assert.deepEqual(await shown(), [await page.evaluate(() => cleanSlate.current())], 'the second tap takes it out of the list, and the other board opens');
assert.equal(await page.textContent('#toast'), 'Deleted “Kitchen plan”. Undo');
// Undo brings it back as it was, and opens it again.
await page.click('#toast button');
assert.equal((await shown()).length, 2, 'Undo puts it back in the list');
assert.equal(await page.evaluate(() => cleanSlate.current()), kitchen, 'and opens it again');
assert.equal(await count(page), before, 'with every line');
// Ctrl + Z, or a two-finger tap, while the toast offers Undo brings the deleted board back too (the delete was the last
// thing done), and leaves the open board's lines alone. With the list open and nothing just deleted, Ctrl + Z waits:
// the board it would change is behind the list.
{
  const other = (await shown()).find(id => id !== kitchen);
  const lines = id => page.evaluate(id => cleanSlate.store.get(id).strokes.length, id);
  const otherLines = await lines(other);
  const delOther = page.locator(`#boardList [data-del="${other}"]`);
  await page.keyboard.press('Escape');
  await h.pen(line(300, 620, 500, 620, 6)); // (a line on the open board, for its Undo to take)
  for (const how of ['keys', 'tap']) {
    await page.click('#boardsBtn');
    await wait(450);
    await delOther.click();
    await wait(450);
    await delOther.click();
    assert.equal((await shown()).length, 1);
    if (how === 'keys') await page.keyboard.press('Control+z');
    else { await page.keyboard.press('Escape'); await h.tap(2); }
    assert.equal((await shown()).length, 2, `${how}: the deleted board is back`);
    assert.equal(await lines(other), otherLines, `${how}: with every line`);
    assert.equal(await count(page), before + 1, `${how}: and the open board keeps every line`);
    assert.equal(await toastText(), 'Brought back “Board 2”.');
    if (how === 'keys') await page.keyboard.press('Escape');
  }
  // A line drawn after the delete is the last thing done, so Undo takes that line, and the board stays deleted, with
  // its toast's own Undo still there to bring it back.
  for (const how of ['keys', 'tap']) {
    await page.click('#boardsBtn');
    await wait(450);
    await delOther.click();
    await wait(450);
    await delOther.click();
    await page.keyboard.press('Escape');
    await h.pen(line(300, 540, 500, 540, 6));
    assert.equal(await count(page), before + 2);
    if (how === 'keys') await page.keyboard.press('Control+z'); else { await wait(800); await h.tap(2); } // (once the pen is put down)
    assert.equal(await count(page), before + 1, `${how}: Undo after a line drawn since the delete takes that line`);
    assert.equal((await shown()).length, 1, `${how}: and leaves the board deleted`);
    assert.equal(await toastText(), 'Deleted “Board 2”. Undo', `${how}: with the delete's Undo still offered`);
    await page.click('#toast button');
    assert.equal((await shown()).length, 2, `${how}: which brings it back`);
    assert.equal(await lines(other), otherLines, `${how}: with every line`);
  }
  await page.click('#boardsBtn');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), before + 1, 'Ctrl + Z waits while the list is open');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), before, 'and undoes on the board once it’s closed');
  await page.click('#boardsBtn');
}
// Without Undo, it's deleted for good once the toast has gone: from the page and from the browser's storage.
await wait(450);
await del.click();
await wait(450);
await del.click();
assert.equal((await shown()).length, 1);
assert.equal(await inDb(kitchen), true, 'kept while Undo is offered');
await until(async () => !(await page.evaluate(id => !!cleanSlate.store.get(id), kitchen)), 8000, 'the board is deleted once the toast goes');
await until(async () => !(await inDb(kitchen)), 2000, 'and gone from the browser’s storage');
// Deleting the last board leaves a fresh one, and Undo takes that away again if it hasn't been used. The board comes
// back with its undo. (The list stays open after a delete.)
const second = page.locator('#boardList li:first-child [data-del]');
await second.click();
await wait(450);
await second.click();
assert.equal(await page.textContent('#boardName'), 'Board 1', 'deleting the last board leaves a fresh one');
await page.click('#toast button');
assert.equal(await page.textContent('#boardName'), 'Board 2');
assert.equal(await page.evaluate(() => cleanSlate.store.list().length), 1, 'Undo took the fresh board away again');
await page.keyboard.press('Escape');
await page.keyboard.press('Control+z');
assert.equal(await count(page), 0, 'the board came back with its undo');
await page.keyboard.press('Control+Shift+z');
assert.equal(await count(page), 1);
await page.click('#boardsBtn');
await wait(450);
await second.click();
await wait(450);
await second.click();
assert.equal(await page.textContent('#boardName'), 'Board 1');
await page.keyboard.press('Escape');
await page.click('#menuBtn');
await page.setInputFiles('#restoreFile', backupPath);
await until(async () => (await page.textContent('#boardName')) === 'Kitchen plan', 3000, 'a backup file opens');
assert.equal(await count(page), before);
assert.deepEqual(await page.evaluate(() => cleanSlate.store.list().map(b => b.name)), ['Kitchen plan'], 'the empty board left after the delete made way for it: as many boards as the backup has');

// Clear, and undo it.
await page.click('#menuBtn');
await page.click('#clear');
await page.click('#clear');
assert.equal(await count(page), before, 'a second tap straight after the first only asks');
await wait(450);
await page.click('#clear');
assert.equal(await count(page), 0, 'Clear empties the board');
assert.equal(await toastText(), 'Cleared “Kitchen plan”. Undo');
await page.click('#toast button');
assert.equal(await count(page), before, 'and the Undo in its message brings it all back');
// Once something else is done on the board, the message's Undo leaves it be (Undo in the toolbar is for that now).
await page.click('#menuBtn');
await wait(450);
await page.click('#clear');
await wait(450);
await page.click('#clear');
await h.pen(line(300, 620, 500, 620, 6));
await page.click('#toast button');
assert.equal(await count(page), 1, 'a line drawn since: the message’s Undo does nothing');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
assert.equal(await count(page), before, 'and Ctrl + Z undoes the line, then the Clear');
// A backup opened after a Clear brings the drawing back, as a board beside the cleared one (merged into it, every line
// Clear took would stay taken).
await page.click('#menuBtn');
await page.click('#clear');
await wait(450);
await page.click('#clear');
assert.equal(await count(page), 0);
await page.click('#menuBtn');
await page.setInputFiles('#restoreFile', backupPath);
await until(async () => (await page.textContent('#boardName')) === 'Kitchen plan (backup)', 3000, 'a backup opened after Clear opens beside the cleared board');
assert.equal(await count(page), before, 'with every line the backup has');
assert.equal(await toastText(), 'Opened “Kitchen plan (backup)” beside the board you have.');
assert.deepEqual(await page.evaluate(() => cleanSlate.store.list().map(b => [b.name, b.strokes.length]).sort()), [['Kitchen plan (backup)', before], ['Kitchen plan', 0]], 'the cleared board stays too');

// Undo after the eraser or Clear goes back one step at a time, all the way to an empty board.
{
  const kitchen = await page.evaluate(() => cleanSlate.current());
  await page.click('#boardsBtn');
  await page.click('#newBoard');
  const mouseLine = async (x0, y0, x1, y1) => {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10);
    await page.mouse.up();
  };
  await mouseLine(200, 300, 600, 300);
  await page.click('[data-tool="eraser"]');
  await page.click('[data-mode="lines"]');
  await mouseLine(400, 250, 400, 350);
  assert.equal(await count(page), 0, 'Whole lines took the line');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 1, 'undo puts the line back');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 0, 'and a second undo takes it away, back to the empty board');
  assert.equal(await page.isDisabled('#undo'), true, 'with nothing left to undo');
  // A rub-out that goes over no ink isn't kept: it would be an Undo step that changes nothing on screen.
  await page.click('[data-mode="rub"]');
  await mouseLine(200, 300, 600, 300);
  assert.equal(await count(page), 0, 'a rub-out on an empty board leaves it empty');
  assert.equal(await page.isDisabled('#undo'), true, 'with nothing to undo');
  await until(async () => (await hintShows()) === '1', 2000, 'and the hint showing');
  await page.click('[data-tool="pen"]');
  await mouseLine(200, 300, 600, 300);
  await mouseLine(200, 400, 600, 400);
  await page.click('[data-tool="eraser"]');
  await mouseLine(200, 350, 600, 350);
  assert.equal(await count(page), 2, 'nor one that goes between the lines');
  await page.click('[data-tool="pen"]');
  await page.click('#menuBtn');
  await page.click('#clear');
  await wait(450);
  await page.click('#clear');
  assert.equal(await count(page), 0);
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 2, 'undo brings back what Clear took');
  await page.keyboard.press('Control+z');
  assert.equal(await count(page), 1, 'and the next undo takes away the second line');
  // Space + drag moves the board, straight after clicking a toolbar button too (the button doesn't keep Space). Space
  // let go of in another window, where its keyup never comes here, isn't left held down.
  await page.click('#undo');
  await page.click('#redo');
  const vs = await view(page);
  await page.keyboard.down(' ');
  await page.mouse.move(500, 500);
  await page.mouse.down();
  await page.mouse.move(400, 450, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  assert.equal(await count(page), 1, 'Space + drag after clicking a button draws nothing');
  assert.notDeepEqual(await view(page), vs, 'and moves the board');
  await page.keyboard.down(' ');
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(() => document.body.classList.contains('panning')), false, 'leaving the window lets go of Space');
  await mouseLine(200, 500, 600, 500);
  await page.keyboard.up(' ');
  assert.equal(await count(page), 2, 'and a drag draws again');
  await page.evaluate(id => cleanSlate.open(id), kitchen);
}

// The screen turning (or any resize) in the middle of a line ends the line there, rather than carrying it on from a
// point the board has moved under: no long jump across the board. The view it moved to is kept for next time.
{
  const n = await count(page), z = (await view(page)).z;
  await h.penDown(200, 600);
  for (let i = 1; i <= 10; i++) await h.penMove(200 + i * 10, 600);
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(200);
  for (let i = 11; i <= 20; i++) await h.penMove(200 + i * 10, 600);
  await h.penUp(400, 600);
  const s = await lastStroke(page);
  let gap = 0;
  for (let i = 3; i < s.pts.length; i += 3) gap = Math.max(gap, Math.hypot(s.pts[i] - s.pts[i - 3], s.pts[i + 1] - s.pts[i - 2]));
  assert.ok(gap * z <= 10.5, `a resize in the middle of a line made a jump of ${gap * z} px`);
  assert.equal(await count(page), n + 1);
  await until(async () => JSON.stringify(await page.evaluate(() => cleanSlate.store.get(cleanSlate.current()).view)) === JSON.stringify(await view(page)), 2000, 'the view after a resize is kept');
  await page.keyboard.press('Control+z');
}
// The same when the wheel or a zoom key moves the board in the middle of a line (holding the mouse button while
// scrolling for more board is a habit): the line ends there, and draws nothing more until it lifts.
{
  const n = await count(page), vr = await view(page);
  const jump = s => { let g = 0; for (let i = 3; i < s.pts.length; i += 3) g = Math.max(g, Math.hypot(s.pts[i] - s.pts[i - 3], s.pts[i + 1] - s.pts[i - 2])); return g; };
  const mouse = (type, x, y, o = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...o });
  await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
  await mouse('mousePressed', 300, 300);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', 300 + i * 10, 300);
  await mouse('mouseWheel', 380, 300, { deltaX: 0, deltaY: 100, button: 'none' });
  await until(async () => (await view(page)).y === 100, 2000, 'the wheel moves the board with the button held');
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', 380 + i * 10, 300);
  await mouse('mouseReleased', 460, 300);
  assert.equal(await count(page), n + 1, 'a line the wheel moved the board under is kept, as one line');
  assert.ok(jump(await lastStroke(page)) <= 20, `the wheel in the middle of a line made a jump of ${jump(await lastStroke(page))} px`);
  await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
  await h.penDown(300, 500);
  for (let i = 1; i <= 8; i++) await h.penMove(300 + i * 10, 500);
  await page.keyboard.press('Control+=');
  for (let i = 1; i <= 8; i++) await h.penMove(380 + i * 10, 500);
  await h.penUp(460, 500);
  assert.equal(await count(page), n + 2);
  assert.ok(jump(await lastStroke(page)) <= 20, `Ctrl + = in the middle of a line made a jump of ${jump(await lastStroke(page))} px`);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.evaluate(v => cleanSlate.surface.setView(v), vr);
}

// A phone: nothing scrolls sideways, and the colours are behind one button.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');
assert.equal(await page.isVisible('.tools .swatches'), false);
await page.click('#styleBtn');
assert.equal(await page.isVisible('#pop .swatch'), true, 'the colour button opens the colours');
await page.click('#pop [data-color="blue"]');
assert.equal(await page.evaluate(() => cleanSlate.settings.pen.color), 'blue');
await page.setViewportSize({ width: 1024, height: 768 });

// A phone with gesture navigation: a line started near the screen's side can be taken for Android's back gesture (or
// Chrome's swipe to go back), which takes the touch away (pointercancel) and then goes Back. Nothing on the page
// overscrolls sideways and the board takes every touch, so Chrome's own swipe never starts; a Back while a finger is
// on the board, or within a second of a touch on it being taken, leaves the board as it was; later, Back leaves the
// page in one press, as it always has. (The guard's extra history entry goes on when a finger touches the board and
// comes off a second after it lifts, so between strokes there's nothing extra to press Back through.) (The board stays full-bleed: it's a board you can move, so nothing has to be
// drawn at the screen's side, and only taps happen near it.)
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('phone: ' + e.message));
  const ph = hands(p, await c.newCDPSession(p));
  await p.goto('about:blank');
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.evaluate(() => { window.stayed = true; });
  const look = await p.evaluate(() => [getComputedStyle(document.documentElement).overscrollBehaviorX, getComputedStyle(document.body).overscrollBehaviorX, getComputedStyle(document.getElementById('board')).touchAction]);
  assert.deepEqual(look, ['none', 'none', 'none'], 'nothing overscrolls sideways and the board takes every touch');
  const stayed = async what => {
    await wait(300);
    assert.equal(await p.evaluate(() => window.stayed === true && document.body.classList.contains('ready')).catch(() => false), true, what);
  };
  const guarded = () => p.evaluate(() => history.state?.__edgeGuard === true);
  assert.equal(await guarded(), false, 'no extra history entry before anything is drawn');
  await ph.swipe([40, 300], [200, 320]);
  assert.equal(await count(p), 1, 'a finger draws');
  await wait(1300);
  assert.equal(await guarded(), false, 'a second after the finger lifts, the extra entry is gone again');
  // Back in the middle of a line: the line carries on, and letting go keeps it.
  await ph.touch('touchStart', [[30, 400]]);
  assert.equal(await guarded(), true, 'a finger on the board adds the extra entry');
  for (let i = 1; i <= 4; i++) await ph.touch('touchMove', [[30 + i * 30, 400 + i * 4]]);
  await p.evaluate(() => history.back()).catch(() => {}); // (without the guard, the page goes)
  await stayed('Back in the middle of a line should stay on the board');
  for (let i = 5; i <= 8; i++) await ph.touch('touchMove', [[30 + i * 30, 400 + i * 4]]);
  await ph.touch('touchEnd', []);
  assert.equal(await count(p), 2, 'the line drawn across a Back is kept');
  await wait(1300);
  assert.equal(await guarded(), false, 'and a second after letting go, the entry is gone');
  // The browser takes the touch and a Back follows: the half-drawn line goes, the board stays as it was.
  await ph.touch('touchStart', [[20, 500]]);
  for (let i = 1; i <= 4; i++) await ph.touch('touchMove', [[20 + i * 25, 500]]);
  await ph.touch('touchCancel', []);
  await p.goBack({ waitUntil: 'commit', timeout: 2000 }).catch(() => {});
  await stayed('Back just after the touch was taken should stay on the board');
  assert.equal(await count(p), 2, 'the board is as it was');
  assert.deepEqual(await p.evaluate(() => cleanSlate.surface.busy), false);
  // A while later, Back leaves in one press.
  await ph.swipe([100, 600], [250, 620]);
  assert.equal(await count(p), 3);
  await wait(1300);
  assert.equal(await guarded(), false, 'with no stroke going on, there is no extra entry to press Back through');
  await p.goBack({ waitUntil: 'commit', timeout: 2000 }).catch(() => {});
  await until(() => p.url() === 'about:blank', 3000, 'a deliberate Back should leave the page in one press');
  await c.close();
}

// Two tabs drawing on one board at the same moment: each keeps the other's lines, on screen and in storage, so a
// reload of both shows every line.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const tabs = [];
  for (let k = 0; k < 2; k++) {
    const p = await c.newPage();
    p.on('pageerror', e => problems.push('tabs: ' + e.message));
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    tabs.push({ p, h: hands(p, await c.newCDPSession(p)) });
    await wait(400); // (the first tab's new board is written before the second opens)
  }
  assert.equal(await tabs[1].p.evaluate(() => cleanSlate.current()), await tabs[0].p.evaluate(() => cleanSlate.current()), 'both tabs are on one board');
  const N = 12;
  for (let i = 0; i < N; i++) await Promise.all(tabs.map(({ h }, k) => h.pen(line(150 + k * 400, 150 + i * 30, 450 + k * 400, 150 + i * 30, 4))));
  await until(async () => (await Promise.all(tabs.map(t => count(t.p)))).every(n => n === 2 * N), 5000, 'both tabs show both tabs’ lines');
  for (const t of tabs) await t.p.evaluate(() => cleanSlate.store.flush());
  await wait(800);
  // (and the edge guard has taken its entry off again, a second after the last line: a reload as it goes Back is
  // aborted, which is a test's timing, not a person's)
  for (const t of tabs) await until(() => t.p.evaluate(() => !history.state?.__edgeGuard), 3000, 'the edge guard takes its entry off');
  for (const t of tabs) { await t.p.reload(); await t.p.waitForFunction(() => document.body.classList.contains('ready')); }
  assert.deepEqual(await Promise.all(tabs.map(t => count(t.p))), [2 * N, 2 * N], 'and after a reload, every line is still there');
  // The lines above are seldom written at exactly the same moment, so here both tabs add a line and write it at once:
  // one write lands over the other, and the tab whose line it lacks writes the merged board back.
  for (let i = 0; i < 4; i++) {
    await Promise.all(tabs.map(({ p }, k) => p.evaluate(async ([k, i]) => {
      const { makeStroke, addStrokes } = await import('./js/board.js');
      const s = makeStroke({ tool: 'pen', color: 'ink', size: 4, pts: [150 + k * 400, 560 + i * 30, 0.5, 450 + k * 400, 560 + i * 30, 0.5] });
      cleanSlate.store.edit(cleanSlate.current(), b => addStrokes(b, [s]));
      await cleanSlate.store.flush();
    }, [k, i])));
    await wait(300);
  }
  await until(async () => (await Promise.all(tabs.map(t => count(t.p)))).every(n => n === 2 * N + 8), 5000, 'two tabs writing at the same moment keep each other’s lines');
  for (const t of tabs) await t.p.evaluate(() => cleanSlate.store.flush());
  await wait(800);
  for (const t of tabs) { await t.p.reload(); await t.p.waitForFunction(() => document.body.classList.contains('ready')); }
  assert.deepEqual(await Promise.all(tabs.map(t => count(t.p))), [2 * N + 8, 2 * N + 8], 'and keep them after a reload');
  await c.close();
}

// The first pen coming down while a resting hand is drawing (a finger draws until a pen is seen): the hand's line goes,
// and the page says it found the pen once the pen lifts, not while it writes. Then a board deleted just before the
// page is left (the tablet switched to another app) is deleted for good, and its toast with Undo goes too: an Undo
// there on the way back couldn't bring the board back.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('first pen: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  await ph.touch('touchStart', [[600, 600]]);
  for (let i = 1; i <= 6; i++) { await ph.touch('touchMove', [[600 + i * 8, 600 + i * 4]]); await wait(30); }
  let during = null;
  await ph.pen(line(200, 300, 500, 300, 12), { beforeUp: async () => { during = await toastText(p); } });
  await ph.touch('touchEnd', []);
  assert.equal(during, '', 'nothing pops up while the first pen writes, even with a hand down before it');
  assert.equal(await count(p), 1, 'the hand’s line goes and the pen’s stays');
  assert.match(await toastText(p), /^Pen found/, 'and the pen is mentioned once it lifts');
  const gone = await p.evaluate(() => cleanSlate.current());
  await p.evaluate(() => { const b = cleanSlate.store.create('Other'); cleanSlate.open(b.id); });
  await p.click('#boardsBtn');
  await wait(400);
  const bin = p.locator(`[data-del="${gone}"]`);
  await bin.click();
  await wait(450);
  await bin.click();
  assert.match(await toastText(p), /Undo$/);
  await p.evaluate(() => {
    const as = state => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); document.dispatchEvent(new Event('visibilitychange')); };
    as('hidden');
    as('visible');
  });
  assert.equal(await p.evaluate(id => !!cleanSlate.store.get(id), gone), false, 'leaving the page makes the delete final');
  assert.equal(await toastText(p), '', 'and takes its Undo away with it');
  // A backup holding a board just deleted, opened while its Undo is offered, brings it back to stay.
  await p.keyboard.press('Escape'); // (the list stays open after a delete)
  const keep = await p.evaluate(() => { const b = cleanSlate.store.create('Keep'); cleanSlate.open(b.id); return b.id; });
  await ph.pen(line(200, 400, 500, 400, 8));
  const file = await p.evaluate(id => JSON.stringify({ cleanSlate: 1, boards: [cleanSlate.store.get(id)] }), keep);
  await p.evaluate(() => cleanSlate.open(cleanSlate.store.list().find(b => b.name === 'Other').id));
  await p.click('#boardsBtn');
  await wait(400);
  const keepBin = p.locator(`[data-del="${keep}"]`);
  await keepBin.click();
  await wait(450);
  await keepBin.click();
  assert.equal((await p.evaluate(() => cleanSlate.shown())).includes(keep), false);
  await p.keyboard.press('Escape');
  await p.click('#menuBtn');
  await p.setInputFiles('#restoreFile', { name: 'Keep.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await until(async () => (await p.textContent('#boardName')) === 'Keep', 3000, 'the backup opens the board just deleted');
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.deepEqual([await p.evaluate(id => !!cleanSlate.store.get(id) && cleanSlate.shown().includes(id), keep), await count(p)], [true, 1], 'and it stays, with its line');
  await c.close();
}

// Picking a colour, a size, or a board's colour or lines from the keyboard keeps the keyboard on what was picked (the
// buttons are made again for the new choice, and focus used to fall out to the page).
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const focused = () => p.evaluate(() => { const a = document.activeElement; return { ...a.dataset, pressed: a.getAttribute('aria-pressed') }; });
  await p.focus('[data-color="blue"]');
  await p.keyboard.press('Enter');
  assert.deepEqual(await focused(), { color: 'blue', pressed: 'true' }, 'Enter on a colour keeps focus on it');
  await p.keyboard.press('Tab');
  await p.keyboard.press(' ');
  assert.deepEqual(await focused(), { color: 'red', pressed: 'true' }, 'and Tab, Space on the next');
  await p.focus('[data-size="2"]');
  await p.keyboard.press('Enter');
  assert.deepEqual(await focused(), { size: '2', pressed: 'true' });
  await p.keyboard.press('e');
  await p.focus('[data-mode="lines"]');
  await p.keyboard.press('Enter');
  assert.deepEqual(await focused(), { mode: 'lines', pressed: 'true' });
  await p.click('#menuBtn');
  await p.focus('[data-bg="paper"]');
  await p.keyboard.press('Enter');
  assert.deepEqual(await focused(), { bg: 'paper', pressed: 'true' });
  await p.focus('[data-pattern="dots"]');
  await p.keyboard.press(' ');
  assert.deepEqual(await focused(), { pattern: 'dots', pressed: 'true' });
  await c.close();
}

// A backup is named for the day it is where it's saved: at 8 pm in New York, that day, not tomorrow's (the date in UTC).
// The time inside the file stays the exact moment, in UTC.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block', timezoneId: 'America/New_York' });
  await c.clock.setFixedTime(new Date('2026-11-24T01:19:43Z')); // Monday 23 November, 8:19 pm in New York
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.click('#menuBtn');
  const [file] = await Promise.all([p.waitForEvent('download'), p.click('#backup')]);
  assert.equal(file.suggestedFilename(), 'Clean Slate backup 2026-11-23.json', 'the backup is named for the day it is here');
  assert.equal(JSON.parse(await readFile(await file.path(), 'utf8')).saved, '2026-11-24T01:19:43.000Z');
  await c.close();
}

// The list of boards and the menu are dialogs: opening one from the keyboard puts the focus in it (on the open board
// in the list, on the menu itself, never the name box, which would bring up a tablet's keyboard), Tab goes round
// inside it while what's behind is inert, and closing puts the focus back on the button that opened it. Tapped open on
// a phone, the focus is never on the name box either.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const at = () => p.evaluate(() => { const a = document.activeElement; return a === document.body ? 'BODY' : a.id || a.className || a.tagName; });
  const inside = sel => p.evaluate(s => document.querySelector(s).contains(document.activeElement), sel);
  assert.equal(await p.getAttribute('#boards', 'role'), 'dialog');
  assert.equal(await p.getAttribute('#menu', 'aria-label'), 'Menu');
  // The menu has two parts: This board (its name, colour and lines, Show it all, Clear and Save a picture, then How it
  // works), and Settings, for every board on the device (Google Drive, Fingers and Backup).
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#menu h2, #menu h3')].map(e => e.tagName + ' ' + e.textContent)),
    ['H2 This board', 'H3 Save a picture', 'H3 How it works', 'H2 Settings', 'H3 Fingers', 'H3 Backup']);
  assert.deepEqual(await p.evaluate(() => ['#nameInput', '#fit', '#clear', '#savePng', '.help'].map(s => !document.querySelector('#settings').contains(document.querySelector(s)))), [true, true, true, true, true]);
  assert.deepEqual(await p.evaluate(() => ['#drive', 'input[name="fingers"]', '#backup'].map(s => document.querySelector('#settings').contains(document.querySelector(s)))), [true, true, true]);
  await p.focus('#boardsBtn');
  await p.keyboard.press('Enter');
  await until(() => inside('#boards'), 2000, 'Enter on Boards puts the focus in the list');
  assert.equal(await p.evaluate(() => document.activeElement.closest('li')?.classList.contains('here')), true, 'on the open board');
  assert.equal(await p.evaluate(() => document.querySelector('.top').inert && document.querySelector('#board').inert), true, 'what’s behind is inert');
  await p.keyboard.press('Escape');
  assert.equal(await at(), 'boardsBtn', 'Esc puts it back on Boards');
  assert.equal(await p.evaluate(() => document.querySelector('.top').inert), false);
  // Opening a board from the list goes back to Boards too.
  await p.keyboard.press('Enter');
  await until(() => inside('#boards'), 2000, 'open again');
  await p.keyboard.press('Enter');
  await until(() => p.isHidden('#boards'), 2000, 'opening a board closes the list');
  assert.equal(await at(), 'boardsBtn', 'opening a board from the list goes back to Boards');
  await p.focus('#menuBtn');
  await p.keyboard.press('Enter');
  await until(async () => (await at()) === 'menu', 2000, 'Enter on Menu puts the focus on the menu');
  await p.keyboard.press('Shift+Tab');
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Privacy', 'Shift + Tab from the menu goes to its last control');
  await p.keyboard.press('Tab');
  assert.equal(await inside('#menu'), true, 'Tab from the menu’s last control stays in the menu');
  assert.equal(await p.evaluate(() => document.activeElement.hasAttribute('data-close')), true, 'on its first');
  await p.keyboard.press('Shift+Tab');
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Privacy');
  await p.keyboard.press('Escape');
  assert.equal(await at(), 'menuBtn', 'Esc puts it back on Menu');
  // Opened with the mouse, the focus isn't kept on the button after (Space still moves the board).
  await p.click('#menuBtn');
  await p.click('#menu [data-close]');
  assert.equal(await at(), 'BODY');
  await c.close();
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const q = await ph.newPage();
  await q.goto(base);
  await q.waitForFunction(() => document.body.classList.contains('ready'));
  await q.tap('#menuBtn');
  await wait(300);
  assert.equal(await q.evaluate(() => document.activeElement.id), 'menu', 'a tapped-open menu doesn’t focus the name box');
  await q.tap('#menu [data-close]');
  await q.tap('#boardsBtn');
  await wait(300);
  assert.equal(await q.evaluate(() => document.querySelector('#boards').contains(document.activeElement)), true);
  await ph.close();
}

// Show it all, back to 100% and Ctrl + = and − ease the board into place over about a fifth of a second, quick at first
// and slowing at the end, and a touch on the board stops one where it is. The menu and the list of boards slide away
// as they slide in, closed at once though still going, and the pop-up fades in and out. With the system's Reduce motion
// on, all of it is instant.
for (const motion of ['no-preference', 'reduce']) {
  const calm = motion === 'reduce';
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, reducedMotion: motion, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const hh = hands(p, await c.newCDPSession(p));
  await hh.pen(line(100, 100, 900, 650));
  const eased = await p.evaluate(async () => {
    const s = cleanSlate.surface;
    s.setView({ x: 0, y: 0, z: 4 });
    s.fit();
    const first = { easing: s.easing, z: s.view.z }, goal = s.goal, zs = [], t0 = performance.now();
    while (s.easing && performance.now() - t0 < 2000) { await new Promise(r => requestAnimationFrame(r)); zs.push(s.view.z); }
    return { first, ms: performance.now() - t0, zs, there: JSON.stringify(s.view) === JSON.stringify(goal), goal: goal.z };
  });
  assert.ok(eased.there && eased.goal < 1.5, `Show it all gets there (${motion}): ${JSON.stringify(eased)}`);
  if (calm) assert.deepEqual(eased.first, { easing: false, z: eased.goal }, 'with Reduce motion, Show it all is there at once');
  else {
    assert.deepEqual(eased.first, { easing: true, z: 4 }, 'Show it all eases');
    assert.ok(eased.ms >= 150 && eased.ms < 800 && eased.zs.length >= 4, `over about a fifth of a second: ${Math.round(eased.ms)} ms, ${eased.zs.length} frames`);
    assert.ok(eased.zs.every((z, i) => i === 0 || z <= eased.zs[i - 1]), `zooming out steadily: ${eased.zs}`);
    // A finger coming down stops an easing where it is.
    await p.evaluate(async () => { cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }); cleanSlate.surface.zoomTo(3); await new Promise(r => requestAnimationFrame(r)); });
    await hh.touch('touchStart', [[500, 400]]);
    const stopped = await p.evaluate(() => [cleanSlate.surface.easing, cleanSlate.surface.view.z]);
    await hh.touch('touchEnd', []);
    await wait(300);
    assert.ok(!stopped[0] && stopped[1] > 1 && stopped[1] < 3, `a touch stops the easing partway: ${stopped}`);
    assert.equal((await view(p)).z, stopped[1], 'and it stays where it stopped');
  }
  // The menu slides away.
  await p.click('#menuBtn');
  await until(() => p.evaluate(() => document.querySelector('#menu').getBoundingClientRect().right <= innerWidth + 0.5), 2000, 'the menu slides in');
  const rest = await p.evaluate(() => document.querySelector('#menu').getBoundingClientRect().left);
  await p.keyboard.press('Escape');
  await wait(60);
  const going = await p.evaluate(() => { const m = document.querySelector('#menu'); return { hidden: m.hidden, inert: m.inert, left: m.getBoundingClientRect().left, behind: document.querySelector('.top').inert }; });
  if (calm) assert.equal(going.hidden, true, 'with Reduce motion the menu goes at once');
  else assert.ok(!going.hidden && going.inert && going.left > rest + 1 && going.left < 1024 && !going.behind, `the menu slides away, closed while it goes: ${JSON.stringify(going)} from ${rest}`);
  await until(() => p.isHidden('#menu'), 1000, 'and is gone after it has slid away');
  // The pop-up fades in and out.
  await p.click('[data-tool="shape"]');
  const fadingIn = await p.evaluate(() => document.querySelector('#pop').getAnimations().length);
  assert.equal(fadingIn, calm ? 0 : 1, 'the pop-up fades in');
  await wait(200);
  await p.click('[data-tool="shape"]');
  const out = await p.evaluate(() => { const el = document.querySelector('#pop'); return { hidden: el.hidden, out: el.classList.contains('out'), expanded: document.querySelector('[data-tool="shape"]').getAttribute('aria-expanded') }; });
  assert.deepEqual(out, calm ? { hidden: true, out: false, expanded: 'false' } : { hidden: false, out: true, expanded: 'false' }, 'and fades out, closed while it fades');
  await until(() => p.isHidden('#pop'), 1000, 'and is hidden once it has faded');
  await c.close();
}

// The zoom percentage has a small arrow back. A tap takes the board back to 100%, and for two seconds after the chip
// says Show it all: a second tap fits the whole drawing on screen. Left alone, it goes when the two seconds are up.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const hh = hands(p, await c.newCDPSession(p));
  await hh.swipe([60, 200], [330, 600]);
  assert.equal(await count(p), 1);
  const chip = () => p.evaluate(() => { const z = document.querySelector('#zoom'); return z.hidden ? 'hidden' : (z.querySelector('svg') ? 'arrow ' : '') + z.textContent; });
  const away = { x: 900, y: 900, z: 3 };
  await p.evaluate(v => cleanSlate.surface.setView(v), away);
  assert.equal(await chip(), 'arrow 300%', 'the percentage, with its arrow back');
  await p.tap('#zoom');
  await settled(p);
  assert.equal((await view(p)).z, 1, 'a tap goes back to 100%');
  assert.equal(await chip(), 'arrow Show it all', 'and then offers Show it all');
  assert.equal(await p.getAttribute('#zoom', 'title'), 'Show it all');
  await p.tap('#zoom');
  await settled(p);
  const shown = await view(p);
  const all = await p.evaluate(() => { cleanSlate.surface.fit(); return cleanSlate.surface.goal; });
  assert.deepEqual(shown, all, 'a second tap shows it all');
  assert.equal(await chip(), `arrow ${Math.round(all.z * 100)}%`, 'and the chip shows the zoom again');
  await settled(p);
  // Left alone after the first tap, the chip goes once the two seconds are up.
  await p.evaluate(v => cleanSlate.surface.setView(v), away);
  await p.tap('#zoom');
  const t0 = Date.now();
  await until(async () => (await chip()) === 'hidden', 4000, 'the offer goes after two seconds');
  assert.ok(Date.now() - t0 > 1500, `not before: ${Date.now() - t0} ms`);
  assert.equal((await view(p)).z, 1);
  // Moved away again in the two seconds, a tap goes back to 100% rather than showing it all.
  await p.evaluate(v => cleanSlate.surface.setView(v), away);
  await p.tap('#zoom');
  await settled(p);
  await p.evaluate(v => cleanSlate.surface.setView(v), away);
  await p.tap('#zoom');
  await settled(p);
  assert.equal((await view(p)).z, 1, 'zoomed again, the next tap is back to 100%');
  await c.close();
}

// On a computer with no touch screen Fingers isn't in the menu, where it could do nothing; it comes back by itself
// when a touch screen does (a laptop folded into a tablet, say).
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.click('#menuBtn');
  assert.equal(await p.isHidden('#fingers'), true, 'no Fingers with only a mouse');
  assert.equal(await p.isVisible('#settings h2'), true, 'Settings is still there, over Backup');
  await (await c.newCDPSession(p)).send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(() => p.isVisible('#fingers'), 2000, 'a touch screen appearing brings Fingers back');
  await c.close();
}

// A message with Undo waits while the keyboard is on its button, and runs on once it leaves. Once a message has gone it
// leaves nothing behind: no unseen Undo to Tab to, no words for a screen reader.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.evaluate(() => cleanSlate.open(cleanSlate.store.create().id));
  await p.click('#boardsBtn');
  const del = p.locator('#boardList .del').first();
  await del.click();
  await wait(450);
  await del.click();
  assert.equal(await p.textContent('#toast button'), 'Undo');
  await p.focus('#toast button');
  await wait(6600);
  assert.match(await toastText(p), /^Deleted “Board \d”\. Undo$/, 'the message waits while the keyboard is on Undo');
  await p.focus('#newBoard');
  await wait(3500);
  assert.equal(await toastText(p), '', 'and goes 3 s after the keyboard leaves');
  assert.deepEqual(await p.evaluate(() => [document.querySelector('#toast').textContent, document.querySelectorAll('#toast button').length]), ['', 0], 'leaving no Undo behind');
  await c.close();
}

// A screen reader hears which board is open: the Boards button's name starts with the board's name, the board says its
// name and how many lines it has, the open board in the list is marked (aria-current, and an accent bar on screen),
// and Delete's question is heard as well as seen.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const name = sel => p.getAttribute(sel, 'aria-label');
  assert.equal((await p.locator('#boardsBtn').textContent()).trim(), 'Board 1, boards', 'the Boards button is named by the board first');
  assert.equal(await p.getAttribute('#boardsBtn', 'aria-label'), null);
  assert.equal(await name('#board'), 'Board 1: empty. Draw on it with a pen, a finger or the mouse.');
  const cdp = await c.newCDPSession(p);
  await hands(p, cdp).pen(line(200, 300, 500, 300));
  assert.equal(await name('#board'), 'Board 1: 1 line. Draw on it with a pen, a finger or the mouse.');
  await p.click('#boardsBtn');
  assert.equal(await p.getAttribute('#boardList li.here .open', 'aria-current'), 'true');
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('#boardList li.here'), '::before').width), '3px', 'and a bar shows it');
  await p.click('#boardList .del');
  assert.equal(await p.getAttribute('#boardList .del', 'aria-label'), 'Delete Board 1? Press again to delete');
  await wait(4300);
  assert.equal(await p.getAttribute('#boardList .del', 'aria-label'), 'Delete Board 1', 'and back after a few seconds unanswered');
  await c.close();
}

// With a mouse the toolbar's titles say the keys, and the tools, Undo and Redo carry aria-keyshortcuts; on a touch
// screen Undo and Redo's titles say the finger taps. On the Slate the first ink, drawn chalk-white, is called White.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const look = sel => p.evaluate(s => { const el = document.querySelector(s); return [el.title, el.getAttribute('aria-keyshortcuts')]; }, sel);
  assert.deepEqual(await look('[data-tool="pen"]'), ['Pen (P)', 'P']);
  assert.deepEqual(await look('[data-tool="eraser"]'), ['Eraser (E)', 'E']);
  assert.deepEqual(await look('#undo'), ['Undo (Ctrl + Z)', 'Control+Z Meta+Z']);
  assert.equal((await look('#redo'))[0], 'Redo (Ctrl + Shift + Z)');
  assert.equal((await look('[data-tool="shape"]'))[0], 'Shapes (S)');
  assert.equal(await p.getAttribute('#zoom', 'title'), 'Back to 100% (Ctrl + 0)');
  assert.equal(await p.getAttribute('#fit', 'title'), 'Show it all (F)');
  assert.equal((await look('[data-color="blue"]'))[0], 'Blue (2)');
  assert.equal(await p.getAttribute('[data-color="ink"]', 'aria-label'), 'Black');
  await p.click('#menuBtn');
  await p.click('[data-bg="slate"]');
  assert.deepEqual(await look('[data-color="ink"]'), ['White (1)', null], 'chalk-white on the Slate is called White');
  assert.equal(await p.getAttribute('[data-color="ink"]', 'aria-label'), 'White');
  await c.close();
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const q = await ph.newPage();
  await q.goto(base);
  await q.waitForFunction(() => document.body.classList.contains('ready'));
  assert.deepEqual(await q.evaluate(() => [document.querySelector('[data-tool="pen"]').title, document.querySelector('#undo').title]), ['Pen', 'Undo (two-finger tap)']);
  await ph.close();
  // On a Mac the titles say ⌘, the key it takes there.
  const mac = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  await mac.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
  });
  const m = await mac.newPage();
  await m.goto(base);
  await m.waitForFunction(() => document.body.classList.contains('ready'));
  assert.deepEqual(await m.evaluate(() => ['#undo', '#redo', '#zoom'].map(s => document.querySelector(s).title)), ['Undo (⌘ + Z)', 'Redo (⌘ + Shift + Z)', 'Back to 100% (⌘ + 0)']);
  await mac.close();
}

// The menu's Colour and Lines are named groups, and the Fingers choices a radio group named Fingers. The shapes
// pop-up says when it's open (aria-expanded), takes the keyboard to the chosen shape when opened from the keyboard,
// and gives it back to the Shapes tool on Esc, or once a shape is picked. On a phone its colours and sizes are named
// groups too.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const named = sel => p.evaluate(s => { const el = document.querySelector(s); return [el.getAttribute('role'), document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.getAttribute('aria-label')]; }, sel);
  assert.deepEqual(await named('.field:has(#bgs)'), ['group', 'Colour']);
  assert.deepEqual(await named('.field:has(#patterns)'), ['group', 'Lines']);
  assert.deepEqual(await named('[role="radiogroup"]'), ['radiogroup', 'Fingers']);
  const shapes = '[data-tool="shape"]';
  assert.equal(await p.getAttribute(shapes, 'aria-expanded'), 'false');
  await p.focus(shapes);
  await p.keyboard.press('Enter');
  assert.equal(await p.getAttribute(shapes, 'aria-expanded'), 'true');
  assert.deepEqual(await named('#pop'), ['group', 'Shapes']);
  assert.deepEqual(await p.evaluate(() => [document.activeElement.dataset.kind, document.activeElement.getAttribute('aria-pressed')]), [await p.evaluate(() => cleanSlate.settings.shape.kind), 'true'], 'the keyboard goes to the chosen shape');
  await p.keyboard.press('Escape');
  await until(() => p.isHidden('#pop'), 2000, 'the pop-up closes');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.tool), 'shape', 'Esc gives the keyboard back to Shapes');
  assert.equal(await p.getAttribute(shapes, 'aria-expanded'), 'false');
  await p.keyboard.press('Enter');
  await p.focus('[data-kind="arrow"]');
  await p.keyboard.press('Enter');
  await until(() => p.isHidden('#pop'), 2000, 'the pop-up closes');
  assert.deepEqual(await p.evaluate(() => [document.activeElement.dataset.tool, cleanSlate.settings.shape.kind]), ['shape', 'arrow'], 'and so does picking a shape');
  await c.close();
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const q = await ph.newPage();
  await q.goto(base);
  await q.waitForFunction(() => document.body.classList.contains('ready'));
  await q.tap('#styleBtn');
  assert.equal(await q.getAttribute('#styleBtn', 'aria-expanded'), 'true');
  assert.deepEqual(await q.evaluate(() => [...document.querySelectorAll('#pop [role="group"]')].map(g => g.getAttribute('aria-label'))), ['Colour', 'Size']);
  assert.equal(await q.getAttribute('#pop', 'aria-label'), 'Colour and size');
  // With Fingers set to Move the board, the empty board's hint says a finger moves it, before any pen has been used.
  await q.keyboard.press('Escape');
  assert.equal(await q.textContent('#hint'), 'Draw anywhere. Use a pen or a finger. Two fingers move and zoom. Tap with two fingers to undo. More in the\u00a0···\u00a0menu.');
  await q.tap('#menuBtn');
  await q.tap('input[name="fingers"][value="move"]');
  await q.keyboard.press('Escape');
  assert.equal(await q.textContent('#hint'), 'Draw anywhere. A pen or the mouse draws; one finger moves the board. Two fingers move and zoom. Tap with two fingers to undo. More in the\u00a0···\u00a0menu.', 'Move the board says a finger moves it');
  await ph.close();
}

// A tablet turned with the pop-up open: what's in it follows the screen. In landscape the colours and sizes are in the
// toolbar, so the pop-up doesn't show them twice; in portrait the shapes' pop-up takes the colours and sizes in.
{
  const c = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const inPop = () => p.evaluate(() => ({ open: !document.querySelector('#pop').hidden, swatches: document.querySelectorAll('#pop .swatch').length, kinds: document.querySelectorAll('#pop [data-kind]').length }));
  await p.tap('#styleBtn');
  assert.deepEqual(await inPop(), { open: true, swatches: 6, kinds: 0 });
  await p.setViewportSize({ width: 1180, height: 820 });
  await until(async () => !(await inPop()).open, 2000, 'turned to landscape, the colour pop-up goes: its colours are in the toolbar now');
  await p.tap('[data-tool="shape"]');
  assert.deepEqual(await inPop(), { open: true, swatches: 0, kinds: 5 });
  await p.setViewportSize({ width: 820, height: 1180 });
  await until(async () => (await inPop()).swatches === 6, 2000, 'turned to portrait, the shapes pop-up takes in the colours');
  assert.deepEqual(await inPop(), { open: true, swatches: 6, kinds: 5 });
  assert.equal(await p.getAttribute('#pop', 'aria-label'), 'Shapes, colour and size');
  await c.close();
}

// On a tablet or a computer the toolbar is centred on the screen, and stays put: Pen and Undo are where they were
// whichever tool is in hand (the highlighter has five colours, the eraser two ways of erasing) and whatever the
// board is called. A long name ends in an ellipsis instead of pushing the toolbar along.
for (const [width, height] of [[1180, 820], [1024, 1366], [860, 900]]) {
  const c = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const at = () => p.evaluate(() => {
    const x = s => Math.round(document.querySelector(s).getBoundingClientRect().left), t = document.querySelector('#tools').getBoundingClientRect();
    return { pen: x('[data-tool="pen"]'), undo: x('#undo'), centre: Math.round((t.left + t.right) / 2) };
  });
  const first = await at();
  assert.ok(Math.abs(first.centre - width / 2) <= 1, `at ${width} px the toolbar is centred (${first.centre})`);
  for (const name of ['B', 'Kitchen renovation measurements and the list']) {
    await p.click('#menuBtn');
    await p.fill('#nameInput', name);
    await p.keyboard.press('Escape');
    for (const key of ['h', 'e', 's', 'p']) {
      await p.keyboard.press(key);
      assert.deepEqual(await at(), first, `at ${width} px, with the tool on ${key} and the board called ${name}`);
    }
  }
  const name = await p.evaluate(() => { const n = document.querySelector('#boardName'); return [n.textContent, n.scrollWidth > n.clientWidth]; });
  assert.deepEqual(name, ['Kitchen renovation measurements and the list', true], 'the long name ends in an ellipsis');
  await c.close();
}

// On a tablet or a computer the colours and sizes in the toolbar are 44 px tall to tap, with their circles the same size
// as ever, and the zoom percentage, which looks 36 px tall, takes a tap 4 px above or below it too.
{
  const c = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 2 }));
  await until(() => p.isVisible('#zoom'), 2000, 'the zoom shows at 200%');
  const look = await p.evaluate(() => {
    const box = s => document.querySelector(s).getBoundingClientRect();
    const z = box('#zoom'), at = (x, y) => document.elementFromPoint(x, y)?.id;
    return {
      swatch: [box('.tools .swatch').height, getComputedStyle(document.querySelector('.tools .swatch'), '::before').width],
      size: [box('.tools .size').height, document.querySelector('.tools .size i').getBoundingClientRect().width],
      tools: box('#tools').height,
      zoom: [z.height, at(z.left + z.width / 2, z.top - 3), at(z.left + z.width / 2, z.bottom + 3)],
    };
  });
  assert.deepEqual(look, { swatch: [44, '22px'], size: [44, 3.5], tools: 52, zoom: [36, 'zoom', 'zoom'] });
  await p.tap('[data-tool="shape"]');
  const gap = await p.evaluate(() => document.querySelector('#pop').getBoundingClientRect().top - document.querySelector('#tools').getBoundingClientRect().bottom);
  assert.equal(gap, 8, 'the shapes\' pop-up sits 8 px under the taller toolbar, as it did under the shorter one');
  await c.close();
}

// On the narrowest phones (an iPhone SE of 2016 is 320 px wide, a folded Galaxy Fold's cover screen 280 px) the
// toolbar and its pop-ups fit on the screen, every button whole, and none narrower than 32 px. From 390 px (an iPhone
// 12 or later) the toolbar's eight buttons are 44 px square to tap; narrower, they're 44 tall and as wide as there's
// room (42 px on a 375 px iPhone SE of 2020). The lasso's bar fits too.
for (const [width, height] of [[280, 653], [320, 568], [360, 740], [375, 667], [390, 844]]) {
  const c = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const fits = what => p.evaluate(([what, width]) => {
    const out = [];
    for (const el of [document.querySelector(what), ...document.querySelectorAll(`${what} button`)]) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.left < 0 || r.right > width) out.push(`${el.id || el.className || el.dataset.tool} at ${Math.round(r.left)}..${Math.round(r.right)}`);
      if (el.matches('button') && r.width < 32) out.push(`${el.id || el.dataset.tool} only ${r.width} px wide`);
    }
    return out;
  }, [what, width]);
  assert.deepEqual(await fits('#tools'), [], `the toolbar fits at ${width} px`);
  const sizes = await p.evaluate(() => [...new Set([...document.querySelectorAll('#tools button')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return (r.width >= 44 ? 'wide' : 'narrow') + ' ' + Math.round(r.height); }))]);
  assert.deepEqual(sizes, width >= 390 ? ['wide 44'] : ['narrow 44'], `the toolbar's buttons at ${width} px`);
  await p.tap('#styleBtn');
  assert.deepEqual(await fits('#pop'), [], `the colours fit at ${width} px`);
  await p.tap('[data-tool="shape"]');
  assert.deepEqual(await fits('#pop'), [], `the shapes fit at ${width} px`);
  await p.tap('[data-tool="eraser"]');
  await p.tap('[data-tool="eraser"]');
  assert.equal(await p.isVisible('#pop .mode'), true);
  assert.deepEqual(await fits('#pop'), [], `the eraser's pop-up fits at ${width} px`);
  await p.evaluate(() => { const id = cleanSlate.current(); cleanSlate.store.edit(id, b => { b.strokes.push({ id: 'sfit', t: 1, tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [40, 300, 0.5, 200, 300, 0.5] }); }); });
  await p.tap('[data-tool="lasso"]');
  await p.evaluate(() => cleanSlate.surface.select(['sfit']));
  await p.waitForSelector('#lassoBar:not([hidden])');
  assert.deepEqual(await fits('#lassoBar'), [], `the lasso's bar fits at ${width} px`);
  await c.close();
}

// On a phone the colour button's dot is the only sign of the colour, so its edge stands off the toolbar at 3:1 or
// more (WCAG 2.1, 1.4.11 Non-text Contrast) whatever the ink: chalk white on the Slate in light mode, black on the
// White board in dark mode.
for (const [scheme, bg] of [['light', 'slate'], ['dark', 'white']]) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.evaluate(bg => { const id = cleanSlate.current(); cleanSlate.store.edit(id, b => { b.bg = bg; }); cleanSlate.open(id); }, bg);
  const box = await p.locator('#styleBtn').boundingBox();
  const shot = await p.screenshot({ clip: box });
  const ratio = await p.evaluate(async ([png, d, w]) => {
    const img = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.width / w, y = Math.round(img.height / 2), cx = img.width / 2;
    const lum = x => { const [r, gr, b] = g.getImageData(Math.round(x), y, 1, 1).data; const f = v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(gr) + 0.0722 * f(b); };
    const toolbar = lum(2 * k);
    let best = 1;
    for (let x = cx + (d / 2 - 1) * k; x <= cx + (d / 2 + 3) * k; x++) { const l = lum(x); best = Math.max(best, (Math.max(l, toolbar) + 0.05) / (Math.min(l, toolbar) + 0.05)); }
    return best;
  }, [[...shot], parseFloat(await p.evaluate(() => document.querySelector('#styleBtn').style.getPropertyValue('--d'))), box.width]);
  assert.ok(ratio >= 3, `the colour dot's edge is ${ratio.toFixed(2)}:1 on the toolbar (${scheme}, ${bg})`);
  await c.close();
}

// The toolbar, its pop-ups, the zoom percentage and the installed app's bar at the top take the board's look, light on
// White and Paper and dark on the Slate, whether the device is in light or dark mode; the menu and the list of boards
// follow the device.
for (const scheme of ['light', 'dark']) {
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: scheme, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  for (const bg of ['white', 'paper', 'slate']) {
    await p.evaluate(bg => { const id = cleanSlate.current(); cleanSlate.store.edit(id, b => { b.bg = bg; }); cleanSlate.open(id); }, bg);
    const look = await p.evaluate(() => {
      const bgOf = s => getComputedStyle(document.querySelector(s)).backgroundColor;
      return { tools: bgOf('#tools'), pop: bgOf('#pop'), zoom: bgOf('#zoom'), name: getComputedStyle(document.querySelector('#boardsBtn')).color, sheet: bgOf('#menu'), bar: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content) };
    });
    const dark = bg === 'slate', light = 'rgba(255, 255, 255, 0.9)', darkBar = 'rgba(31, 37, 42, 0.9)';
    assert.deepEqual(look, {
      tools: dark ? darkBar : light, pop: dark ? darkBar : light, zoom: dark ? darkBar : light,
      name: dark ? 'rgb(238, 241, 243)' : 'rgb(28, 35, 41)',
      sheet: scheme === 'dark' ? 'rgb(26, 31, 35)' : 'rgb(247, 248, 250)',
      bar: dark ? ['#1b2125', '#1b2125'] : ['#f3f5f7', '#f3f5f7'],
    }, `the toolbar on ${bg} in ${scheme} mode`);
  }
  // (Changing the board's colour in the menu changes them at once.)
  await p.click('#menuBtn');
  await p.click('#bgs [data-bg="white"]');
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('#tools')).backgroundColor), 'rgba(255, 255, 255, 0.9)');
  await c.close();
}

// Opened from the home screen (Chrome's installed app, or Safari's navigator.standalone), How it works doesn't say to
// add it to the home screen. In a browser tab it does.
for (const how of ['tab', 'display-mode', 'navigator.standalone']) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  if (how === 'display-mode') await c.addInitScript(() => { const mm = window.matchMedia; window.matchMedia = q => (q === '(display-mode: standalone)' ? { ...mm.call(window, 'all'), matches: true, media: q } : mm.call(window, q)); });
  if (how === 'navigator.standalone') await c.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  assert.equal(await p.evaluate(() => document.querySelector('#homeScreen').hidden), how !== 'tab', `Add it to your home screen, ${how}`);
  await c.close();
}

// A phone on its side with a notch (simulated here: 47 px at each side, as an iPhone shows): the menu and the list of
// boards grow by the notch's width, so what's in them is as wide as without one, and the four kinds of lines still
// fit on one row.
{
  const c = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const inside = sel => p.evaluate(sel => { const el = document.querySelector(sel), cs = getComputedStyle(el); return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); }, sel);
  const rows = () => p.evaluate(() => new Set([...document.querySelectorAll('#patterns .chip')].map(b => b.offsetTop)).size);
  await p.tap('#menuBtn');
  const plain = await inside('#menu');
  await p.keyboard.press('Escape');
  await p.tap('#boardsBtn');
  const plainList = await inside('#boards');
  await p.keyboard.press('Escape');
  await p.addStyleTag({ content: ':root { --safe-l: 47px; --safe-r: 47px; --safe-b: 21px; }' });
  await p.tap('#menuBtn');
  assert.equal(await inside('#menu'), plain, 'the menu keeps its width inside');
  assert.equal(await rows(), 1, 'Blank, Grid, Lines and Dots on one row');
  await p.keyboard.press('Escape');
  await p.tap('#boardsBtn');
  assert.equal(await inside('#boards'), plainList, 'and so does the list of boards');
  await c.close();
}

// In a Windows Contrast theme (forced colours) the ink swatches keep their colours and the chosen tool shows.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, forcedColors: 'active', serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const look = await p.evaluate(() => {
    const dot = getComputedStyle(document.querySelector('[data-color="blue"]'), '::before').backgroundColor;
    const on = getComputedStyle(document.querySelector('[data-tool="pen"]')).backgroundColor, off = getComputedStyle(document.querySelector('[data-tool="marker"]')).backgroundColor;
    return { dot, chosen: on !== off };
  });
  assert.deepEqual(look, { dot: 'rgb(31, 94, 214)', chosen: true });
  await c.close();
}

// The list of boards draws a board's little picture again only when the board has changed since the list last showed.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const hh = hands(p, await c.newCDPSession(p));
  await hh.pen(line(200, 300, 500, 300));
  await p.click('#boardsBtn');
  await p.click('#newBoard');
  await hh.pen(line(200, 400, 500, 400));
  await p.click('#boardsBtn');
  await p.evaluate(() => document.querySelectorAll('.thumb canvas').forEach(t => { t.dataset.seen = '1'; }));
  await p.click('#boards [data-close]');
  await p.click('#boardsBtn');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('.thumb canvas')].map(t => t.dataset.seen)), ['1', '1'], 'nothing changed: no picture drawn again');
  await p.click('#boards [data-close]');
  await hh.pen(line(200, 500, 500, 500));
  await p.click('#boardsBtn');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('.thumb canvas')].map(t => t.dataset.seen || 'new')), ['new', '1'], 'only the board drawn on is drawn again');
  await c.close();
}

// In dark mode the questions that ask before deleting, clearing or stopping are dark on the salmon warning colour,
// not white (2.28:1, too faint to read).
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: 'dark', serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.click('#boardsBtn');
  await p.click('#boardList .del');
  assert.equal(await p.textContent('#boardList .del'), 'Delete?');
  assert.deepEqual(await p.evaluate(() => { const s = getComputedStyle(document.querySelector('#boardList .del')); return [s.color, s.backgroundColor]; }), ['rgb(59, 9, 7)', 'rgb(255, 138, 128)']);
  await c.close();
}

// On a computer, hovering the Menu button tints its own surface rather than replacing it, so its icon stays at 3:1 or
// more on the button (WCAG 2.1, 1.4.11) in either look on every board. (The tint alone let the board show through: in
// dark mode on the White board the pale icon all but vanished, and in light mode on the Slate the dark one did.)
for (const scheme of ['light', 'dark']) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, serviceWorkers: 'block' });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  for (const bg of ['white', 'paper', 'slate']) {
    await p.evaluate(bg => { const id = cleanSlate.current(); cleanSlate.store.edit(id, b => { b.bg = bg; }); cleanSlate.open(id); }, bg);
    await p.hover('#menuBtn');
    const shot = await p.screenshot({ clip: await p.locator('#menuBtn').boundingBox() });
    const ratio = await p.evaluate(async png => {
      const img = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
      const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const lum = i => { const f = v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(px[i]) + 0.7152 * f(px[i + 1]) + 0.0722 * f(px[i + 2]); };
      // The button, just inside its left edge halfway down, against the icon in its middle (away from the rounded
      // corners, where the board shows): the pixel that stands off it most.
      const at = (x, y) => (y * img.width + x) * 4, w = img.width, h = img.height;
      const button = lum(at(4, Math.round(h / 2)));
      let best = 1;
      for (let y = Math.round(h / 4); y < h * 3 / 4; y++) for (let x = Math.round(w / 4); x < w * 3 / 4; x++) { const l = lum(at(x, y)); best = Math.max(best, (Math.max(l, button) + 0.05) / (Math.min(l, button) + 0.05)); }
      return best;
    }, [...shot]);
    assert.ok(ratio >= 3, `the hovered Menu button's icon is ${ratio.toFixed(2)}:1 on it (${scheme}, ${bg})`);
  }
  await c.close();
}

// On the Slate a highlighter lightens what's under it: bright over the board, and chalk writing under it stays white.
// It looks the same while it's drawn as once it's down, and the same in the PNG and the SVG as on screen. (It was laid
// on 42% see-through, a muddy olive over the board that dimmed the writing under it.)
{
  const c = await browser.newContext({ viewport: { width: 600, height: 400 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('glow: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  await p.evaluate(() => { const id = cleanSlate.current(); cleanSlate.store.edit(id, b => { b.bg = 'slate'; b.pattern = 'blank'; }); cleanSlate.open(id); cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }); });
  await p.keyboard.press(']'); await p.keyboard.press(']'); // (the boldest pen)
  await ph.pen(line(300, 120, 300, 280, 8, () => 1));
  await p.keyboard.press('h');
  // The colour of a pixel in a PNG, in the page.
  const at = (png, x, y) => p.evaluate(async ([png, x, y]) => {
    const img = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    const g = new OffscreenCanvas(img.width, img.height).getContext('2d');
    g.drawImage(img, 0, 0);
    return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
  }, [[...png], x, y]);
  const screen = async () => { const s = await p.screenshot(); return [await at(s, 200, 200), await at(s, 300, 200)]; };
  let drawing;
  await ph.pen(line(150, 200, 450, 200, 12), { beforeUp: async () => { drawing = await screen(); } });
  await wait(100);
  const [board, chalk] = await screen();
  const near = (a, b, d = 6) => a.every((v, i) => Math.abs(v - b[i]) <= d);
  // (Yellow on the Slate is #fff176, and the Slate #2a3236: screened, 1 − (1 − a)(1 − b) for each channel, that's
  // about 255, 244, 147.)
  assert.ok(near(board, [255, 244, 147]), `a yellow highlight over the Slate is bright: ${board}`);
  assert.ok(chalk.every(v => v >= 245), `and the chalk writing under it stays white: ${chalk}`);
  assert.ok(near(drawing[0], board, 3) && near(drawing[1], chalk, 3), `it looks the same while it's drawn (${drawing}) as once it's down (${board}, ${chalk})`);
  const files = await p.evaluate(async () => {
    const { picture, frame, visibleBounds } = await import('./js/ink.js');
    const { toSVG } = await import('./js/svg.js');
    const b = cleanSlate.store.get(cleanSlate.current());
    const look = async (canvas, k, x0, y0) => { const g = canvas.getContext('2d'); return [[200, 200], [300, 200]].map(([x, y]) => [...g.getImageData(Math.round((x - x0) * k), Math.round((y - y0) * k), 1, 1).data.slice(0, 3)]); };
    const f = frame(visibleBounds(b.strokes));
    const png = await look(picture(b), f.k, f.x, f.y);
    const text = toSVG(b), [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(text)[1].split(' ').map(Number);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = vw; cv.height = vh;
    cv.getContext('2d').drawImage(img, 0, 0, vw, vh);
    return { png, svg: await look(cv, 1, vx, vy) };
  });
  for (const [what, [b, k]] of Object.entries(files)) {
    assert.ok(near(b, board) && near(k, chalk), `the ${what} is the same as the screen: ${b} and ${k}, against ${board} and ${chalk}`);
  }
  await c.close();
}

// On a board full of lines, lifting the pen draws just the new line, not every line on screen again, and what's on
// screen then is exactly what a whole new frame draws: a pen line, a highlighter and a rub-out, on a light board and
// on the Slate (where a rub-out, which paints the board back, still draws the whole frame). Each lift drew every line
// again: on a 2,000-line board at a quarter speed, the next line waited about 0.4 s for it.
{
  const c = await browser.newContext({ viewport: { width: 800, height: 600 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('lift: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  const frames = () => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // (Every fill and stroke on any canvas, counted.)
  await p.evaluate(() => {
    window.calls = 0;
    for (const k of ['fill', 'stroke']) { const f = CanvasRenderingContext2D.prototype[k]; CanvasRenderingContext2D.prototype[k] = function (...a) { window.calls++; return f.apply(this, a); }; }
  });
  for (const bg of ['white', 'slate']) {
    await p.evaluate(async bg => {
      const B = await import('./js/board.js');
      const b = cleanSlate.store.create('Full ' + bg);
      let sv = 3; const rnd = () => (sv = (sv * 16807) % 2147483647) / 2147483647;
      const strokes = [];
      for (let i = 0; i < 300; i++) {
        const x = 20 + rnd() * 700, y = 80 + rnd() * 480, pts = [];
        for (let k = 0; k < 20; k++) pts.push(x + k * 3, y + Math.sin(k / 3 + i) * 8, 0.3 + rnd() * 0.6);
        const tool = i % 10 === 9 ? 'rub' : i % 5 === 3 ? 'marker' : 'pen';
        strokes.push(B.makeStroke({ tool, color: tool === 'marker' ? 'yellow' : 'blue', size: tool === 'rub' ? 14 : tool === 'marker' ? 12 : 4, sim: 0, pts }, Date.now() - 1e6 + i));
      }
      cleanSlate.store.edit(b.id, x => { x.bg = bg; B.addStrokes(x, strokes); });
      cleanSlate.open(b.id);
      cleanSlate.surface.setView({ x: 0, y: 0, z: 1 });
    }, bg);
    await frames();
    for (const key of ['p', 'h', 'e']) {
      await p.keyboard.press(key);
      await frames();
      await ph.pen(line(150, 300, 650, 340, 20), { beforeUp: () => p.evaluate(() => { window.calls = 0; }) });
      await frames();
      const calls = await p.evaluate(() => window.calls);
      const whole = bg === 'slate' && key === 'e';
      assert.ok(whole ? calls > 200 : calls < 10, `lifting the ${key === 'p' ? 'pen' : key === 'h' ? 'highlighter' : 'eraser'} on ${bg} filled or stroked ${calls} times`);
      const grab = () => p.evaluate(() => { const cv = document.querySelector('#board canvas.main'); return [...cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data]; });
      const asLifted = await grab();
      await p.evaluate(() => cleanSlate.surface.redraw());
      await frames();
      const redrawn = await grab();
      const differ = asLifted.reduce((n, v, i) => n + (v !== redrawn[i]), 0);
      assert.equal(differ, 0, `after the ${key} on ${bg}, the screen is what a whole frame draws`);
    }
    assert.equal(await count(p), 303);
  }
  await c.close();
}

// While fingers, a wheel or the mouse move or zoom a board full of lines, its ink slides and scales as a picture
// instead of every line being drawn at each step; once they stop, the whole board is drawn, exactly as a whole frame
// draws it. (Each step of a pinch drew every line again: on a 2,000-line board at a quarter speed, about 0.3 s a step.)
{
  const c = await browser.newContext({ viewport: { width: 800, height: 600 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('slide: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  const frames = () => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate(() => {
    window.calls = 0;
    for (const k of ['fill', 'stroke']) { const f = CanvasRenderingContext2D.prototype[k]; CanvasRenderingContext2D.prototype[k] = function (...a) { window.calls++; return f.apply(this, a); }; }
  });
  const grab = () => p.evaluate(() => { const cv = document.querySelector('#board canvas.main'); return [...cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data]; });
  // The screen once the board has stopped, against a whole redraw of it.
  const settled = async what => {
    const now = await grab();
    await p.evaluate(() => cleanSlate.surface.redraw());
    await frames();
    const whole = await grab();
    assert.equal(now.reduce((n, v, i) => n + (v !== whole[i]), 0), 0, `once ${what} stops, the screen is what a whole frame draws`);
  };
  for (const bg of ['white', 'slate']) {
    await p.evaluate(async bg => {
      const B = await import('./js/board.js');
      const b = cleanSlate.store.create('Full ' + bg);
      let sv = 5; const rnd = () => (sv = (sv * 16807) % 2147483647) / 2147483647;
      const strokes = [];
      for (let i = 0; i < 300; i++) {
        const x = 20 + rnd() * 700, y = 80 + rnd() * 480, pts = [];
        for (let k = 0; k < 20; k++) pts.push(x + k * 3, y + Math.sin(k / 3 + i) * 8, 0.3 + rnd() * 0.6);
        const tool = i % 10 === 9 ? 'rub' : i % 5 === 3 ? 'marker' : 'pen';
        strokes.push(B.makeStroke({ tool, color: tool === 'marker' ? 'green' : 'red', size: tool === 'rub' ? 14 : tool === 'marker' ? 12 : 4, sim: 0, pts }, Date.now() - 1e6 + i));
      }
      cleanSlate.store.edit(b.id, x => { x.bg = bg; B.addStrokes(x, strokes); });
      cleanSlate.settings.penSeen = true; // (a finger moves the board)
      cleanSlate.open(b.id);
      cleanSlate.surface.setView({ x: 0, y: 0, z: 1 });
    }, bg);
    await frames();
    // Two fingers pinching out.
    await p.evaluate(() => { window.calls = 0; });
    await ph.touch('touchStart', [[350, 300], [450, 300]]);
    for (let i = 1; i <= 10; i++) { await ph.touch('touchMove', [[350 - i * 8, 300 - i * 2], [450 + i * 8, 300 + i * 2]]); await frames(); }
    const pinching = await p.evaluate(() => window.calls);
    assert.ok(pinching < 40, `pinching filled or stroked ${pinching} times in 10 steps on ${bg}`);
    assert.ok(await p.evaluate(() => cleanSlate.surface.view.z) > 1.2, 'and it zoomed');
    await ph.touch('touchEnd', []);
    await frames();
    await settled(`a pinch on ${bg}`);
    // One finger moving the board.
    await ph.swipe([500, 400], [380, 330], 10);
    await frames();
    await settled(`a finger on ${bg}`);
    // A trackpad or wheel: drawn whole once it has been still a moment.
    await p.mouse.move(400, 300);
    await p.evaluate(() => { window.calls = 0; });
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(30, 20); await frames(); }
    const wheeling = await p.evaluate(() => window.calls);
    assert.ok(wheeling < 30, `scrolling filled or stroked ${wheeling} times in 6 steps on ${bg}`);
    await wait(300);
    await frames();
    await settled(`scrolling on ${bg}`);
    // The mouse's right button.
    await p.mouse.move(300, 300);
    await p.mouse.down({ button: 'right' });
    for (let i = 1; i <= 6; i++) await p.mouse.move(300 + i * 15, 300 + i * 10);
    await p.mouse.up({ button: 'right' });
    await frames();
    await settled(`the mouse on ${bg}`);
    // And a line drawn after it all is drawn on top, as before.
    await ph.pen(line(200, 200, 500, 250, 12));
    await frames();
    await settled(`a line after all that on ${bg}`);
  }
  await c.close();
}

// The line being drawn goes straight to the screen where the browser can (Chrome's desynchronized hint), and still
// looks the same while it's drawn as once it's down, on each board colour with its lines, pen and highlighter; the
// eraser's circle shows; and nothing of it is left on top once the pen lifts.
{
  const c = await browser.newContext({ viewport: { width: 600, height: 400 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('live: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  assert.equal(await p.evaluate(() => document.querySelector('#board canvas.live').getContext('2d').getContextAttributes().desynchronized), true, 'the line being drawn is desynchronized');
  // (Clearing a canvas that goes straight to the screen can flicker: each frame is copied on whole instead.)
  await p.evaluate(() => { const g = document.querySelector('#board canvas.live').getContext('2d'); window.liveClears = 0; const f = g.clearRect; g.clearRect = function (...a) { window.liveClears++; return f.apply(this, a); }; });
  const at = async (xy) => {
    const png = await p.screenshot();
    return p.evaluate(async ([png, xy]) => {
      const img = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
      const g = new OffscreenCanvas(img.width, img.height).getContext('2d');
      g.drawImage(img, 0, 0);
      return xy.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
    }, [[...png], xy]);
  };
  const liveEmpty = () => p.evaluate(() => { const cv = document.querySelector('#board canvas.live'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true; });
  // (A pen line is laid on the board as it's drawn and multiplied into it once it's down, a few levels darker on Paper.)
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
  for (const bg of ['white', 'paper', 'slate']) {
    await p.evaluate(bg => { const b = cleanSlate.store.create(bg); cleanSlate.store.edit(b.id, x => { x.bg = bg; x.pattern = 'lines'; }); cleanSlate.open(b.id); cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }); }, bg);
    for (const [key, y] of [['p', 150], ['h', 250]]) {
      await p.keyboard.press(key);
      // (on the line, and where it crosses the board's ruled line at y = 160 or 256)
      const spots = [[200, y + (key === 'p' ? 5 : 3)], [300, y + (key === 'p' ? 10 : 6)]];
      let drawing;
      await ph.pen(line(100, y, 500, y + (key === 'p' ? 20 : 12), 16), { beforeUp: async () => { drawing = await at(spots); } });
      await wait(100);
      const down = await at(spots);
      assert.ok(drawing.every((v, i) => near(v, down[i])), `the ${key === 'p' ? 'pen' : 'highlighter'} on ${bg} looks the same while drawn (${drawing.join(' / ')}) as down (${down.join(' / ')})`);
      assert.equal(await liveEmpty(), true, `and nothing of it is left on top on ${bg}`);
    }
    await p.keyboard.press('e');
    await p.mouse.move(300, 330);
    await wait(100);
    const [ring, board] = await at([[300 - 7, 330], [300, 380]]);
    assert.ok(!near(ring, board), `the eraser's circle shows on ${bg}: ${ring} against ${board}`);
    await p.keyboard.press('p');
    await wait(100);
    assert.equal(await liveEmpty(), true, `and goes once the pen is picked on ${bg}`);
  }
  assert.equal(await p.evaluate(() => window.liveClears), 0, 'the canvas on screen is never cleared, only copied on whole');
  await c.close();
}

// A browser that isn't keeping boards (a private window, say) says so once, and the menu says what to do.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  await c.addInitScript(() => { IDBFactory.prototype.open = () => { throw new Error('blocked'); }; });
  const p = await c.newPage();
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  assert.equal(await toastText(p), 'This browser isn’t keeping boards (a private window, perhaps). Save a backup before you close it.');
  await p.click('#menuBtn');
  assert.equal(await p.textContent('#kept'), 'This browser isn’t keeping boards (a private window, perhaps). Save a backup before you close it.');
  assert.equal(await p.isVisible('#kept'), true);
  await c.close();
}

// Printing prints the whole drawing, fitted to the page, not the part of it on screen; and nothing extra stays on the
// page after.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('print: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  await ph.pen(line(100, 200, 900, 200, 16));
  await ph.pen(line(100, 200, 100, 600, 16));
  await p.evaluate(() => cleanSlate.surface.setView({ x: 500, y: 300, z: 2 })); // (most of it off screen)
  await p.evaluate(() => dispatchEvent(new Event('beforeprint')));
  await p.emulateMedia({ media: 'print' });
  const look = await p.evaluate(async () => {
    const { contentBounds } = await import('./js/ink.js');
    const el = document.querySelector('.print-copy'), r = el?.getBoundingClientRect();
    const d = contentBounds(cleanSlate.store.get(cleanSlate.current()).strokes);
    return { shows: !!el && getComputedStyle(el).display !== 'none', board: getComputedStyle(document.querySelector('#board')).display, aspect: el && el.width / el.height, drawing: (d.x1 - d.x0 + 80) / (d.y1 - d.y0 + 80), w: r?.width, h: r?.height, vw: innerWidth, vh: innerHeight };
  });
  assert.equal(look.shows, true, 'printing shows a copy of the whole drawing');
  assert.equal(look.board, 'none', 'in place of the board on screen');
  assert.ok(Math.abs(look.aspect - look.drawing) < 0.02, `the copy has the drawing's shape: ${JSON.stringify(look)}`);
  assert.ok(look.w <= look.vw + 1 && look.h <= look.vh + 1, `and fits the page: ${JSON.stringify(look)}`);
  await p.emulateMedia({ media: 'screen' });
  await p.evaluate(() => dispatchEvent(new Event('afterprint')));
  assert.equal(await p.locator('.print-copy').count(), 0, 'and goes after printing');
  await c.close();
}

// A Clean Slate SVG dropped on the board opens as a board, as Open a file does; a photo dropped there goes on the board
// (rather than nothing happening, or the browser leaving the page to show the file).
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('drop: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const pc = await c.newCDPSession(p);
  const { makeBoard: mb, makeStroke: ms, addStrokes: as } = await import('../js/board.js');
  const { toSVG } = await import('../js/svg.js');
  const dropped = mb('Dropped');
  as(dropped, [ms({ tool: 'pen', color: 'blue', size: 4, pts: [100, 100, 0.5, 300, 200, 0.5] })]);
  const dir = await mkdtemp(join(tmpdir(), 'clean-slate-'));
  const file = join(dir, 'Dropped.svg');
  await writeFile(file, toSVG(dropped));
  const drop = async files => {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await pc.send('Input.dispatchDragEvent', { type, x: 500, y: 400, data: { items: [], files, dragOperationsMask: 1 } });
  };
  try {
    await drop([file]);
    await until(async () => (await p.textContent('#boardName')) === 'Dropped', 3000, 'a dropped SVG opens as a board');
    assert.equal(await count(p), 1);
    assert.equal(await toastText(p), 'Opened “Dropped”.');
    await drop([join(root, 'icon-192.png')]);
    await until(async () => (await lastStroke(p)).tool === 'photo', 3000, 'a dropped picture goes on the board');
    assert.equal(await toastText(p), 'Photo added. Drag it to move it, or its corner to resize it. Pick the pen to write on it.');
    assert.match(await p.evaluate(() => Object.values(cleanSlate.store.get(cleanSlate.current()).photos)[0].slice(0, 22)), /^data:image\/png;base64,/, 'a picture with see-through parts stays a PNG');
    assert.equal(p.url(), base, 'and the page stays');
    // Pasted: a backup opens, unless it's pasted in the name box.
    const paste = (sel, text) => p.evaluate(([sel, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'backup.json', { type: 'application/json' }));
      document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [sel, text]);
    const pasted = JSON.stringify({ cleanSlate: 1, boards: [{ ...dropped, id: 'bpasted', name: 'Pasted' }] });
    await paste('#nameInput', pasted);
    await wait(300);
    assert.equal(await p.textContent('#boardName'), 'Dropped', 'a file pasted in the name box opens nothing');
    await paste('#board', pasted);
    await until(async () => (await p.textContent('#boardName')) === 'Pasted', 3000, 'a pasted backup opens');
  } finally { await rm(dir, { recursive: true, force: true }); }
  await c.close();
}

// A board moved and then left for another within the moment its place is kept in: it keeps its own place, not the
// other board's.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('view: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const first = await p.evaluate(() => cleanSlate.current());
  const shed = await p.evaluate(() => { const b = cleanSlate.store.create('Shed'); cleanSlate.store.setView(b.id, { x: 3000, y: 3000, z: 2 }); return b.id; });
  await p.mouse.move(500, 400);
  await p.mouse.wheel(0, 200);
  await until(async () => (await view(p)).y > 0, 2000, 'the wheel moves the board');
  const moved = await view(p);
  await p.evaluate(id => cleanSlate.open(id), shed);
  await wait(700);
  assert.deepEqual(await p.evaluate(id => cleanSlate.store.get(id).view, first), moved, 'the first board keeps where it was moved to');
  assert.deepEqual(await p.evaluate(id => cleanSlate.store.get(id).view, shed), { x: 3000, y: 3000, z: 2 });
  await c.close();
}

// The browser's storage stopping partway through (Safari drops its connection after the tablet has been put down for a
// while: "Connection to Indexed Database server lost"). When the failure passes, the page opens the storage again and
// writes what failed, so a reload still has the line drawn after it. When it doesn't, the page says so at once and
// offers a backup, and asks before the page is left.
{
  const lose = (p, times) => p.evaluate(times => {
    const tx = IDBDatabase.prototype.transaction;
    let left = times;
    IDBDatabase.prototype.transaction = function (...a) {
      if (left-- > 0) throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
      return tx.apply(this, a);
    };
    // (and while it lasts, the storage can't be opened again either)
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...a) { if (left > 0) throw new DOMException('Connection lost', 'UnknownError'); return open.apply(this, a); };
  }, times);
  const unkept = 'This browser has stopped keeping boards. Save a backup now, then reload the page. Save a backup';
  for (const lasts of [false, true]) {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push('storage lost: ' + e.message));
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    const ph = hands(p, await c.newCDPSession(p));
    await ph.pen(line(200, 300, 500, 300, 8));
    await p.evaluate(() => cleanSlate.store.flush());
    await p.evaluate(() => document.querySelector('#toast').classList.remove('on')); // (the pen-found word)
    await lose(p, lasts ? 1e9 : 1);
    await ph.pen(line(200, 400, 500, 400, 8));
    if (lasts) {
      await until(async () => (await toastText(p)) === unkept, 3000, 'the page says it has stopped keeping boards');
      assert.equal(await p.evaluate(() => cleanSlate.store.isKept()), false);
      const [file] = await Promise.all([p.waitForEvent('download'), p.click('#toast button')]);
      const saved = JSON.parse(await readFile(await file.path(), 'utf8'));
      assert.equal(saved.boards[0].strokes.length, 2, 'Save a backup saves the boards, the line drawn since included');
      await p.click('#menuBtn');
      assert.equal(await p.isVisible('#kept'), true, 'and the menu says so too');
    } else {
      await p.evaluate(() => cleanSlate.store.flush());
      await wait(500);
      assert.equal(await toastText(p), '', 'a failure that passes says nothing');
      assert.equal(await p.evaluate(() => cleanSlate.store.isKept()), true, 'and the boards are kept again');
      await p.reload();
      await p.waitForFunction(() => document.body.classList.contains('ready'));
      assert.equal(await count(p), 2, 'the line drawn when the storage failed is still there after a reload');
    }
    await c.close();
  }
}

// ---------- the lasso ----------
// A loop round lines picks them up; the box moves them (with what was rubbed out of them, and rubbing out nothing they
// land on), its corner resizes them, and its buttons duplicate, recolour and delete them, each one undo step.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('lasso: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  // How dark the board is round (x, y): the darkest of a 5 x 5 patch (255 is the White board, ink is under 100).
  const ink = (x, y) => p.evaluate(([x, y]) => { const d = document.querySelector('#board canvas.main').getContext('2d').getImageData(x - 2, y - 2, 5, 5).data; let m = 255; for (let i = 0; i < d.length; i += 4) m = Math.min(m, d[i]); return m; }, [x, y]);
  const strokes = () => p.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes);
  const selected = () => p.evaluate(() => cleanSlate.surface.selected.length);
  const loop = (cx, cy, rx, ry) => Array.from({ length: 33 }, (_, i) => { const t = i / 32 * Math.PI * 2.1; return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, 0.5]; });
  const frame = () => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate(() => document.fonts.ready);
  await ph.pen(line(200, 300, 400, 300));
  await ph.pen(line(200, 340, 400, 340));
  await ph.pen(line(600, 430, 600, 530)); // where the first line is going
  await p.click('[data-tool="eraser"]');
  await ph.pen(line(300, 280, 300, 360)); // a rub-out through both lines
  await p.evaluate(() => document.querySelector('#toast').classList.remove('on'));
  await p.keyboard.press('v');
  assert.equal(await p.getAttribute('[data-tool="lasso"]', 'aria-pressed'), 'true', 'V picks the lasso');
  assert.equal(await p.textContent('#tools .swatches'), 'Draw round lines to pick them up', 'and says how it works where the colours were');
  assert.equal(await p.isDisabled('#styleBtn'), true);
  await ph.pen(loop(300, 300, 130, 22));
  await frame();
  assert.equal(await selected(), 1, 'a loop round the first line picks it up, and not the rub-out');
  assert.equal(await p.isVisible('#lassoBar'), true, 'with its buttons by it');
  assert.deepEqual(await p.$$eval('#lassoBar button', bs => bs.map(b => b.textContent)), ['Duplicate', 'Colour', 'Delete', 'Copy picture']);
  const bar = await p.locator('#lassoBar').boundingBox(), box = await p.evaluate(() => cleanSlate.surface.box);
  assert.ok(bar.y + bar.height <= box.y, 'over the box');
  const n0 = (await strokes()).length;
  // Dragged by the box: down and to the right, so its gap lands on the upright line.
  await ph.pen(line(250, 300, 550, 480, 12));
  await frame();
  let s = await strokes();
  assert.equal(s.length, n0 + 1, 'the line and a copy of its rub-out where it went; the rub-out stays for the line left behind');
  assert.equal(await selected(), 1, 'what was moved is still picked up');
  assert.ok(await ink(530, 480) < 100, 'the line is where it was dragged');
  assert.ok(await ink(250, 300) > 200, 'and not where it was');
  assert.ok(await ink(588, 480) > 200, 'its gap went with it');
  assert.ok(await ink(600, 470) < 100, 'and doesn’t rub out the line it landed on');
  assert.ok(await ink(300, 340) > 200 && await ink(250, 340) < 100, 'the line left behind keeps its gap');
  // One undo step, and back.
  await p.keyboard.press('Control+z');
  await frame();
  assert.ok(await ink(250, 300) < 100 && await ink(300, 300) > 200, 'Undo puts it back where it was, gap and all');
  assert.equal(await selected(), 0, 'and puts nothing down picked up');
  assert.equal(await p.isHidden('#lassoBar'), true);
  await p.keyboard.press('Control+Shift+z');
  await frame();
  assert.ok(await ink(530, 480) < 100 && await ink(588, 480) > 200, 'Redo moves it again');
  // Resized by its corner: twice the size, from the corner opposite.
  await ph.pen(loop(560, 480, 120, 24));
  await frame();
  assert.equal(await selected(), 1);
  const b0 = await p.evaluate(() => cleanSlate.surface.box);
  const size0 = (await strokes()).filter(x => x.tool === 'pen' && x.grp).pop().size;
  const corner = [b0.x + b0.w, b0.y + b0.h];
  await ph.pen(line(corner[0], corner[1], corner[0] + (b0.w - 20), corner[1] + (b0.h - 20), 10));
  await frame();
  const pen1 = (await strokes()).filter(x => x.tool === 'pen' && x.grp).pop();
  assert.ok(Math.abs(pen1.size / size0 - 2) < 0.1, `twice as thick: ${pen1.size} from ${size0}`);
  const b1 = await p.evaluate(() => cleanSlate.surface.box);
  assert.ok(Math.abs((b1.w - 20) / (b0.w - 20) - 2) < 0.1 && Math.abs(b1.x - b0.x) < 2, 'twice as big, from the corner held still');
  await p.keyboard.press('Control+z');
  await frame();
  await ph.pen(loop(560, 480, 120, 24));
  await frame();
  // Duplicate: a copy beside it, picked up instead.
  const before = (await strokes()).length, picked = await p.evaluate(() => cleanSlate.surface.selected);
  await p.click('#lassoBar [data-act="copy"]');
  s = await strokes();
  assert.equal(s.length, before + 2, 'a copy of the line and of its rub-out');
  const now = await p.evaluate(() => cleanSlate.surface.selected);
  assert.equal(now.length, 1);
  assert.notEqual(now[0], picked[0], 'the copy is what’s picked up');
  // Colour: the six inks, and the pen lines take the one tapped.
  await p.click('#lassoBar [data-act="colour"]');
  assert.equal(await p.locator('#lassoBar .swatch').count(), 6);
  await p.click('#lassoBar [data-ink="red"]');
  const red = await p.evaluate(() => cleanSlate.surface.selected);
  assert.equal((await strokes()).find(x => x.id === red[0])?.color, 'red', 'the copy is red, and still picked up');
  assert.equal(await p.locator('#lassoBar .swatch').count(), 0, 'and the bar is back to its buttons');
  // Delete (the key or the button): the copy and its rub-out go, in one step.
  await p.keyboard.press('Delete');
  assert.equal((await strokes()).length, before, 'gone, with the rub-out that only cleared it');
  assert.equal(await selected(), 0);
  await p.keyboard.press('Control+z');
  assert.equal((await strokes()).length, before + 2, 'one Undo brings both back');
  // Put down: by Esc, by a tap outside the box, or by picking another tool.
  for (const how of ['Esc', 'tap', 'tool']) {
    await ph.pen(loop(560, 480, 120, 24));
    await frame();
    assert.equal(await selected(), 1, how);
    if (how === 'Esc') await p.keyboard.press('Escape');
    else if (how === 'tap') await ph.pen([[900, 650, 0.5]]);
    else await p.click('[data-tool="pen"]');
    await frame();
    assert.equal(await selected(), 0, `put down by ${how}`);
    assert.equal(await p.isHidden('#lassoBar'), true);
    if (how === 'tool') { await p.keyboard.press('v'); }
  }
  // Nothing in the loop picks up nothing.
  await ph.pen(loop(850, 200, 60, 40));
  assert.equal(await selected(), 0);
  // The one-step undo went into the board's kept undo, and the board saved with the moved lines opens again after a reload.
  const kept = (await strokes()).map(x => x.id + (x.grp || ''));
  await p.evaluate(() => cleanSlate.store.flush());
  await p.reload();
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  assert.deepEqual((await strokes()).map(x => x.id + (x.grp || '')), kept, 'groups are kept on the device');
  await c.close();
}

// ---------- photos ----------
// Add a photo puts one in the middle of the screen, under the ink, picked up with the lasso. The eraser rubs it out;
// Whole lines takes the lines on it and leaves it; it moves, resizes, undoes, and comes through a reload, the SVG, the
// PNG and a backup.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block', acceptDownloads: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('photos: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const ph = hands(p, await c.newCDPSession(p));
  // (A pixel of the board on screen, as [r, g, b].)
  const px = (x, y) => p.evaluate(([x, y]) => [...document.querySelector('#board canvas.main').getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)], [x, y]);
  const reddish = ([r, g, b]) => r > 150 && g < 110 && b < 110;
  const frame = () => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const strokes = () => p.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes);
  // An 800 x 600 photo, all one red, as a PNG file.
  const png = Buffer.from(await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d'); x.fillStyle = '#c84040'; x.fillRect(0, 0, 800, 600); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  await ph.pen(line(300, 384, 724, 384)); // a line across the middle, drawn before the photo
  await p.click('#menuBtn');
  assert.equal(await p.isVisible('#addPhoto'), true, 'This board offers Add a photo');
  await p.setInputFiles('#photoFile', { name: 'red.png', mimeType: 'image/png', buffer: png });
  await until(async () => (await strokes()).some(s => s.tool === 'photo'), 3000, 'the photo goes on the board');
  await p.waitForFunction(() => document.querySelector('#scrim').hidden); // (the menu closed)
  let b = await p.evaluate(() => cleanSlate.store.get(cleanSlate.current()));
  const photo = b.strokes.find(s => s.tool === 'photo');
  assert.match(Object.values(b.photos)[0], /^data:image\/jpeg;base64,/, 'an opaque picture is kept as a JPEG');
  assert.ok(Object.values(b.photos)[0].length < 60000, 'and small');
  const [x0, y0, , x1, y1] = photo.pts;
  assert.ok(Math.abs((x0 + x1) / 2 - 512) < 1 && Math.abs((y0 + y1) / 2 - 384) < 1, 'in the middle of the screen');
  assert.ok(Math.abs((x1 - x0) / (y1 - y0) - 4 / 3) < 0.01 && y1 - y0 <= 0.7 * 768 + 1, `its own shape, no bigger than most of the screen: ${photo.pts}`);
  assert.equal(await p.getAttribute('[data-tool="lasso"]', 'aria-pressed'), 'true', 'picked up with the lasso');
  assert.deepEqual(await p.evaluate(() => cleanSlate.surface.selected), [photo.id]);
  await frame();
  assert.ok(reddish(await px(450, 300)), 'drawn');
  assert.ok((await px(500, 384))[0] < 100, 'under the line drawn before it');
  assert.equal(await p.getAttribute('#board', 'aria-label'), 'Board 1: 1 line, 1 photo. Draw on it with a pen, a finger or the mouse.');
  // Written on, then rubbed out: the rub-out clears the photo too.
  await p.click('[data-tool="pen"]');
  await ph.pen(line(400, 300, 620, 300));
  await frame();
  assert.ok((await px(500, 300))[0] < 100, 'ink on the photo');
  await p.click('[data-tool="eraser"]');
  await ph.pen(line(560, 250, 560, 450));
  await frame();
  const gap = await px(560, 340);
  assert.ok(gap[0] > 240 && gap[1] > 240, `the rub-out clears the photo, down to the board: ${gap}`);
  assert.ok(reddish(await px(450, 340)), 'and only where it went');
  // Whole lines takes the line written on the photo, and leaves the photo.
  await p.click('[data-mode="lines"]');
  const n = (await strokes()).length;
  await ph.pen(line(450, 290, 450, 310, 4));
  b = await p.evaluate(() => cleanSlate.store.get(cleanSlate.current()));
  assert.equal(b.strokes.length, n - 1);
  assert.ok(b.strokes.some(s => s.tool === 'photo'), 'the photo stays');
  // A swipe that touches only the photo takes it; Undo brings it back.
  await ph.pen(line(450, 450, 470, 450, 4));
  assert.ok(!(await strokes()).some(s => s.tool === 'photo'), 'a swipe on just the photo takes it');
  await p.keyboard.press('Control+z');
  assert.ok((await strokes()).some(s => s.tool === 'photo'));
  await p.click('[data-mode="rub"]');
  // Moved and resized with the lasso, with the rub-out's gap.
  await p.keyboard.press('v');
  const r = await p.evaluate(() => { const s = cleanSlate.store.get(cleanSlate.current()).strokes.find(s => s.tool === 'photo'); return s.pts; });
  const m = 12, round = [[r[0] - m, r[1] - m, 0.5], ...line(r[0] - m, r[1] - m, r[3] + m, r[1] - m, 6), ...line(r[3] + m, r[1] - m, r[3] + m, r[4] + m, 6), ...line(r[3] + m, r[4] + m, r[0] - m, r[4] + m, 6), ...line(r[0] - m, r[4] + m, r[0] - m, r[1] - m, 6)];
  await ph.pen(round);
  const picked = await p.evaluate(() => cleanSlate.surface.selected.length);
  assert.ok(picked >= 2, `a loop round the photo picks it up, with the line on it: ${picked}`);
  await ph.pen(line(450, 340, 350, 340, 10));
  await frame();
  assert.ok(reddish(await px(350, 340)), 'moved');
  assert.ok((await px(460, 340))[0] > 240, 'its gap with it');
  const box = await p.evaluate(() => cleanSlate.surface.box);
  await ph.pen(line(box.x + box.w, box.y + box.h, box.x + box.w - (box.w - 20) / 2, box.y + box.h - (box.h - 20) / 2, 8));
  const half = (await strokes()).find(s => s.tool === 'photo').pts;
  assert.ok(Math.abs((half[3] - half[0]) / (r[3] - r[0]) - 0.5) < 0.05, `half the size: ${half} from ${r}`);
  // Through a reload: the picture is kept, and drawn once it's decoded.
  await p.evaluate(() => cleanSlate.store.flush());
  await p.reload();
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await until(async () => reddish(await px(Math.round(half[0] + 5), Math.round(half[1] + 5))), 3000, 'the photo is drawn after a reload');
  // The SVG has the picture once, and opens again with it; so does a backup. The PNG has the photo in it.
  await p.click('#menuBtn');
  const [svgFile] = await Promise.all([p.waitForEvent('download'), p.click('#saveSvg')]);
  const svgText = await readFile(await svgFile.path(), 'utf8');
  assert.equal((svgText.match(/<image /g) || []).length, 1);
  assert.match(svgText, /<image id="p[\w-]+" width="1" height="1" preserveAspectRatio="none" xlink:href="data:image\/jpeg;base64,/);
  const [backupFile] = await Promise.all([p.waitForEvent('download'), p.click('#backup')]);
  const saved = JSON.parse(await readFile(await backupFile.path(), 'utf8'));
  assert.match(Object.values(saved.boards[0].photos)[0], /^data:image\/jpeg/, 'a backup has the picture');
  const [pngFile] = await Promise.all([p.waitForEvent('download'), p.click('#savePng')]);
  const pngPx = await p.evaluate(async b64 => { const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(Math.round(img.width * 0.2), Math.round(img.height * 0.5), 1, 1).data; return [...d.slice(0, 3)]; }, (await readFile(await pngFile.path())).toString('base64'));
  assert.ok(reddish(pngPx), `the PNG has the photo: ${pngPx}`);
  const dir = await mkdtemp(join(tmpdir(), 'clean-slate-')), svgPath = join(dir, 'Board 1.svg');
  await writeFile(svgPath, svgText);
  await c.close();
  // Opened on a device that never had it.
  const c2 = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  const q = await c2.newPage();
  q.on('pageerror', e => problems.push('photos 2: ' + e.message));
  await q.goto(base);
  await q.waitForFunction(() => document.body.classList.contains('ready'));
  await q.setInputFiles('#restoreFile', svgPath);
  await until(() => q.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes.some(s => s.tool === 'photo')), 3000, 'the SVG opens with its photo');
  assert.match(await q.evaluate(() => Object.values(cleanSlate.store.get(cleanSlate.current()).photos)[0].slice(0, 23)), /^data:image\/jpeg;base64,/);
  await c2.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------- Google Drive, with two devices ----------
{
  const g = fakeGoogle();
  const origin = base.slice(0, -1);
  const device = async () => {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
    await g.install(c, { rewrite: { '**/js/sync.js': s => s.replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${origin}']`) } });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push('drive: ' + e.message));
    const d = { c, p, google: 0 };
    p.on('request', r => { if (r.url().startsWith('https://accounts.google.com/')) d.google++; });
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    d.h = hands(p, await c.newCDPSession(p));
    return d;
  };
  // Google's sign-in script loads once the menu (with the Drive option) is open, not just for visiting the page.
  const openMenu = async d => {
    await wait(300);
    assert.equal(d.google, 0, 'nothing is loaded from Google before the Drive option is on screen');
    await d.p.click('#menuBtn');
    await d.p.waitForFunction(() => window.__cfg, null, { timeout: 5000 }); // (the stand-in sign-in is ready)
    assert.equal(d.google, 1);
  };
  const state = p => p.evaluate(() => cleanSlate.syncState());
  const settle = async (p, what) => {
    await p.evaluate(() => cleanSlate.sync());
    await until(async () => (await state(p)).status === 'ok', 5000, what);
  };
  const boardFiles = () => g.files().filter(f => f.appProperties?.cleanslate === 'board');
  const A = await device(), B = await device();

  // Device A draws, then turns Drive on.
  await A.h.pen(line(200, 300, 500, 300));
  await A.h.pen(line(200, 340, 500, 340));
  await openMenu(A);
  assert.equal(await A.p.isVisible('#drive .btn.primary'), true, 'the menu offers Google Drive');
  assert.match(await A.p.textContent('#drive p.small'), /Turn on Save to Google Drive on your other devices too, and the same boards show up on each/);
  await A.p.click('#drive .btn.primary');
  await until(async () => (await state(A.p)).status === 'ok', 5000, 'device A saved to Drive');
  assert.equal(await A.p.isVisible('#cloud'), true, 'the cloud button shows once Drive is on');
  assert.equal(g.files().filter(f => f.mimeType === 'application/vnd.google-apps.folder').length, 1, 'one Clean Slate folder');
  assert.equal(boardFiles().length, 1, 'one file for the one board');
  assert.equal(boardFiles()[0].name, 'Board 1.svg');
  assert.match(boardFiles()[0].body, /^<svg/, 'the file is a picture');
  const boardId = await A.p.evaluate(() => cleanSlate.current());

  // Device B, with its own empty board, turns Drive on: A's board arrives, B's empty one stays home.
  await openMenu(B);
  await B.p.click('#drive .btn.primary');
  await until(async () => (await state(B.p)).status === 'ok', 5000, 'device B synced');
  assert.equal(boardFiles().length, 1, 'an empty board isn’t saved to Drive');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id)?.strokes.length, boardId), 2, 'A’s board is on B');
  assert.equal(await B.p.evaluate(() => cleanSlate.store.list().length), 1, 'B’s empty starter board made way for it');
  assert.equal(await B.p.textContent('#boardName'), 'Board 1');
  assert.equal(await B.p.evaluate(() => cleanSlate.current()), boardId, 'B is showing A’s board');
  assert.equal(await toastText(B.p), 'Brought one board from Google Drive.', 'and says where it came from');

  // Both draw on the same board at once: both drawings are kept on both.
  await B.p.click('#menu [data-close]');
  await B.p.evaluate(id => cleanSlate.open(id), boardId);
  await B.h.pen(line(200, 400, 500, 400));
  await A.p.click('#menu [data-close]');
  await A.h.pen(line(200, 450, 500, 450));
  await settle(A.p, 'A saved its line');
  await settle(B.p, 'B merged and saved');
  await settle(A.p, 'A picked up B’s line');
  assert.equal(await A.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 4, 'A has both new lines');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 4, 'B has both new lines');
  assert.equal(await A.p.evaluate(() => document.querySelector('#board canvas') !== null), true);

  // A renames it and erases a line; B gets both.
  await A.p.click('#menuBtn');
  await A.p.fill('#nameInput', 'Plans');
  await A.p.press('#nameInput', 'Enter');
  await A.p.click('#menu [data-close]');
  await A.p.click('[data-tool="eraser"]');
  await A.p.click('[data-mode="lines"]');
  await A.h.pen(line(300, 290, 300, 310, 4));
  await settle(A.p, 'A saved the rename');
  await settle(B.p, 'B read the rename');
  assert.equal(boardFiles()[0].name, 'Plans.svg', 'the Drive file is renamed too');
  assert.equal(await B.p.textContent('#boardName'), 'Plans', 'B shows the new name');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 3, 'the erased line is gone on B');

  // An expired sign-in waits for a tap; local drawing carries on meanwhile.
  await A.p.evaluate(() => { const t = JSON.parse(localStorage.getItem('junkdrawer.google')); t.token = 'tok-expired'; localStorage.setItem('junkdrawer.google', JSON.stringify(t)); });
  await A.p.click('[data-tool="pen"]');
  await A.h.pen(line(200, 500, 500, 500));
  await A.p.evaluate(() => cleanSlate.sync());
  await until(async () => (await state(A.p)).status === 'tap', 5000, 'an expired sign-in asks for a tap');
  assert.equal(await A.p.getAttribute('#cloud', 'data-s'), 'tap');
  await A.p.click('#cloud');
  await until(async () => (await state(A.p)).status === 'ok', 5000, 'one tap signs back in and saves');

  // B deletes the board: it goes to the Drive trash, and A deletes it too.
  await B.p.click('#boardsBtn');
  const row = B.p.locator(`#boardList [data-del="${boardId}"]`);
  // A delete that's undone never reaches Drive.
  await row.click();
  await wait(450);
  await row.click();
  await settle(B.p, 'B synced with the delete still undoable');
  assert.equal(!!boardFiles()[0].trashed, false, 'nothing is binned while Undo is offered');
  await B.p.click('#toast button');
  await settle(B.p, 'B synced after Undo');
  assert.equal(!!boardFiles()[0].trashed, false, 'an undone delete leaves the Drive file');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id)?.strokes.length, boardId), 4, 'the board is back on B');
  // Leaving the page makes a delete final at once.
  await row.click();
  await wait(450);
  await row.click();
  await B.p.evaluate(() => dispatchEvent(new Event('pagehide')));
  await settle(B.p, 'B saved the deletion');
  assert.equal(boardFiles()[0].trashed, true, 'the file went to the Drive trash');
  await settle(A.p, 'A saw the deletion');
  assert.equal(await A.p.evaluate(id => !!cleanSlate.store.get(id), boardId), false, 'the board is gone on A too');

  // Stopping leaves the boards and Drive as they are, and never revokes the sign-in.
  await A.h.pen(line(200, 300, 500, 300));
  await A.p.click('#menuBtn');
  await A.p.click('#drive .btn.quiet');
  assert.equal(await A.p.textContent('#drive .btn.quiet'), 'Tap again to stop', 'Stop asks first');
  assert.equal(await A.p.evaluate(() => document.querySelector('#drive .btn.quiet').classList.contains('armed')), true, 'in red, like Clear');
  assert.equal((await state(A.p)).on, true);
  await wait(450);
  await A.p.click('#drive .btn.quiet');
  assert.equal((await state(A.p)).on, false, 'stopped');
  assert.equal(await A.p.evaluate(() => !!window.__revoked), false, 'nothing was revoked');
  assert.equal(await A.p.isHidden('#cloud'), true);
  await A.c.close();
  await B.c.close();

  // When Google's script can't load (offline, a blocker), the menu says nothing about it until Save to Google Drive is
  // tapped; then it says why.
  {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
    await c.route('**/js/sync.js', async route => { const r = await route.fetch(); route.fulfill({ response: r, body: (await r.text()).replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${origin}']`) }); });
    let tries = 0;
    await c.route('https://accounts.google.com/**', r => { tries++; r.abort(); });
    const p = await c.newPage();
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    await p.click('#menuBtn');
    await until(() => tries === 1, 3000, 'opening the menu tries to load Google’s sign-in');
    await wait(300);
    assert.equal(await p.locator('#drive .err').count(), 0, 'and says nothing when it can’t');
    await p.click('#drive .btn.primary');
    await until(async () => (await p.locator('#drive .err').textContent().catch(() => '')) === 'Google sign-in didn’t load. Check the connection.', 3000, 'a tap on Save to Google Drive says why nothing happened');
    assert.equal(tries, 2, 'trying again on the tap');
    await c.close();
  }
}

// ---------- Google Drive: lines moved with the lasso ----------
// A move is the lines taken away and put back where they went, with copies of their rub-outs: two devices, one moving
// while the other draws, end up with the same board whichever reaches Drive first, the gap where it went on both.
{
  const g = fakeGoogle();
  const origin = base.slice(0, -1);
  const device = async () => {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
    await g.install(c, { rewrite: { '**/js/sync.js': s => s.replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${origin}']`) } });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push('lasso drive: ' + e.message));
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    return { c, p, h: hands(p, await c.newCDPSession(p)) };
  };
  const state = p => p.evaluate(() => cleanSlate.syncState());
  const settle = async (p, what) => { await p.evaluate(() => cleanSlate.sync()); await until(async () => (await state(p)).status === 'ok', 5000, what); };
  const turnOn = async d => {
    await d.p.click('#menuBtn');
    await d.p.waitForFunction(() => window.__cfg, null, { timeout: 5000 });
    await d.p.click('#drive .btn.primary');
    await until(async () => (await state(d.p)).status === 'ok', 5000, 'Drive on');
    await d.p.click('#menu [data-close]');
  };
  const ink = (p, x, y) => p.evaluate(([x, y]) => { const d = document.querySelector('#board canvas.main').getContext('2d').getImageData(x - 2, y - 2, 5, 5).data; let m = 255; for (let i = 0; i < d.length; i += 4) m = Math.min(m, d[i]); return m; }, [x, y]);
  const board = p => p.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); return { key: b.strokes.map(s => s.id).join(), gone: Object.keys(b.gone).sort().join(), n: b.strokes.length }; });
  const loop = (cx, cy, rx, ry) => Array.from({ length: 33 }, (_, i) => { const t = i / 32 * Math.PI * 2.1; return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, 0.5]; });
  const A = await device(), B = await device();
  await A.h.pen(line(200, 300, 400, 300));
  await A.h.pen(line(200, 340, 400, 340));
  await A.p.click('[data-tool="eraser"]');
  await A.h.pen(line(300, 280, 300, 360));
  await turnOn(A);
  await turnOn(B);
  const id = await A.p.evaluate(() => cleanSlate.current());
  await B.p.evaluate(id => cleanSlate.open(id), id);
  // (B opened it fitted to its screen, as a board new to a device does: both at 100% here, to point at the same places.)
  for (const p of [A.p, B.p]) await p.evaluate(() => { document.querySelector('#toast').classList.remove('on'); cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }); });
  // Round one: A moves the first line while B draws; A reaches Drive first. Round two: B moves the second line while A
  // draws; A's line reaches Drive first, then B's move.
  for (const [mover, drawer, y, first] of [[A, B, 300, A], [B, A, 340, A]]) {
    await mover.p.click('[data-tool="lasso"]');
    await mover.h.pen(loop(300, y, 130, 18));
    assert.equal(await mover.p.evaluate(() => cleanSlate.surface.selected.length), 1);
    await mover.h.pen(line(250, y, 250 + 300, y + 200, 10));
    await drawer.p.click('[data-tool="pen"]');
    await drawer.h.pen(line(200, 650 + (y - 300), 400, 650 + (y - 300)));
    const second = first === A ? B : A;
    await settle(first.p, 'the first device saved');
    await settle(second.p, 'the second merged and saved');
    await settle(first.p, 'the first picked up the second');
    const [a, b] = [await board(A.p), await board(B.p)];
    assert.deepEqual(a, b, 'both devices have the same board, line by line');
    for (const d of [A, B]) {
      await d.p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.ok(await ink(d.p, 530, y + 200) < 100, 'the moved line is where it went, on both');
      assert.ok(await ink(d.p, 600, y + 200) > 200, 'with its gap, on both');
      assert.ok(await ink(d.p, 250, y) > 200, 'and gone from where it was');
    }
  }
  assert.equal((await board(A.p)).n, 6, 'two moved lines and their two rub-outs, and the two lines drawn meanwhile (the old rub-out, clearing nothing now, went with the second move)');
  // An undo of the move on B reaches A too.
  await B.p.keyboard.press('Control+z');
  await settle(B.p, 'B saved the undo');
  await settle(A.p, 'A picked up the undo');
  await A.p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.ok(await ink(A.p, 250, 340) < 100 && await ink(A.p, 300, 340) > 200, 'the second line is back where it was on A, gap and all');
  assert.deepEqual(await board(A.p), await board(B.p));
  // A photo pasted on A goes to Drive inside the board's file, and B draws it.
  await A.p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const x = c.getContext('2d'); x.fillStyle = '#c84040'; x.fillRect(0, 0, 400, 300);
    const dt = new DataTransfer(); dt.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'red.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await until(() => A.p.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes.some(s => s.tool === 'photo')), 3000, 'A has the photo');
  await settle(A.p, 'A saved the photo');
  assert.match(g.files().find(f => f.appProperties?.cleanslate === 'board').body, /<image id="p[\w-]+" [^>]*xlink:href="data:image\/jpeg;base64,/, 'the picture is in the board’s Drive file');
  await settle(B.p, 'B picked up the photo');
  await until(async () => { const [r, g2] = await B.p.evaluate(() => [...document.querySelector('#board canvas.main').getContext('2d').getImageData(512, 384, 1, 1).data]); return r > 150 && g2 < 110; }, 3000, 'B draws the photo');
  await A.c.close();
  await B.c.close();
}

// ---------- Google Drive: saving that keeps going ----------
// Each part has its own stand-in Drive and devices. `wait` makes a request time out sooner than the half minute a real
// one is given, so a request that never answers is given up on within the test's time. `slow` (bytes a second, each
// way) reaches the Drive over a real connection that Chrome holds to that speed.
{
  const origin = base.slice(0, -1);
  const world = () => {
    const g = fakeGoogle(), devices = [];
    const device = async ({ skew = 0, wait: ms = 0, phone = false, slow = 0 } = {}) => {
      const c = await browser.newContext({ ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true } : { viewport: { width: 1024, height: 768 } }), hasTouch: true, serviceWorkers: 'block' });
      if (skew) await c.addInitScript(k => { const now = Date.now; Date.now = () => now() + k; }, skew);
      await g.install(c, { rewrite: { '**/js/sync.js': s => {
        s = s.replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${origin}']`);
        if (ms && !/const WAIT = \d+;/.test(s)) throw new Error('sync.js has no const WAIT for the test to shorten');
        if (slow && !s.includes("const API = 'https://www.googleapis.com/';")) throw new Error('sync.js has no const API for the test to point at a real connection');
        if (slow) s = s.replace("const API = 'https://www.googleapis.com/';", `const API = '${base}googleapis/';`);
        return ms ? s.replace(/const WAIT = \d+;/, `const WAIT = ${ms};`) : s;
      } } });
      if (slow) drive = g;
      const p = await c.newPage();
      p.on('pageerror', e => problems.push('drive: ' + e.message));
      await p.goto(base);
      await p.waitForFunction(() => document.body.classList.contains('ready'));
      if (slow) {
        const net = await c.newCDPSession(p);
        await net.send('Network.enable');
        await net.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: slow, uploadThroughput: slow });
      }
      const d = { c, p, h: hands(p, await c.newCDPSession(p)) };
      devices.push(d);
      return d;
    };
    return { g, device, boardFiles: () => g.files().filter(f => f.appProperties?.cleanslate === 'board'), close: async () => { g.release(); drive = null; for (const d of devices) await d.c.close(); } };
  };
  const state = d => d.p.evaluate(() => cleanSlate.syncState());
  const turnOn = async d => {
    await d.p.click('#menuBtn');
    await d.p.waitForFunction(() => window.__cfg, null, { timeout: 5000 });
    await d.p.click('#drive .btn.primary');
    await until(async () => (await state(d)).status === 'ok', 8000, 'Drive turned on');
    await d.p.click('#menu [data-close]');
  };
  // One sync, to its end; it should end 'ok' unless told otherwise.
  const settle = async (d, what, end = 'ok') => {
    await d.p.evaluate(() => cleanSlate.sync());
    await until(async () => (await state(d)).status !== 'busy', 8000, what);
    assert.equal((await state(d)).status, end, what);
  };
  const boards = d => d.p.evaluate(() => cleanSlate.store.list().map(b => ({ id: b.id, name: b.name, n: b.strokes.length })));
  const newBoard = async (d, name) => {
    await d.p.click('#boardsBtn');
    await d.p.click('#newBoard');
    if (name) {
      await d.p.click('#menuBtn');
      await d.p.fill('#nameInput', name);
      await d.p.press('#nameInput', 'Enter');
      await d.p.click('#menu [data-close]');
    }
    return d.p.evaluate(() => cleanSlate.current());
  };

  // One board that won't upload (here Drive turns its file away as too big) doesn't stop the boards after it from
  // saving, and the note names it.
  {
    const w = world();
    const A = await w.device();
    const ids = [await A.p.evaluate(() => cleanSlate.current())];
    await A.h.pen(line(200, 300, 500, 300));
    for (const name of ['Big notes', '', '']) { ids.push(await newBoard(A, name)); await A.h.pen(line(200, 300, 500, 300)); }
    await turnOn(A);
    const file = id => w.boardFiles().find(f => f.appProperties.board === id);
    assert.deepEqual(ids.map(id => file(id)?.version), [1, 1, 1, 1], 'four boards in Drive');
    w.g.faults.push({ match: new RegExp(`^PATCH /upload/drive/v3/files/${file(ids[1]).id}\\b`), status: 413, reason: 'uploadTooLarge' });
    for (const id of ids) { await A.p.evaluate(id => cleanSlate.open(id), id); await A.h.pen(line(200, 400, 500, 400)); }
    await settle(A, 'a sync with one board turned away', 'error');
    assert.deepEqual(ids.map(id => file(id).version), [2, 1, 2, 2], 'the other three boards were saved');
    assert.equal((await state(A)).note, '“Big notes” couldn’t be saved to Google Drive; your other boards are saved.');
    w.g.faults.length = 0;
    await settle(A, 'the next sync saves it');
    assert.deepEqual(ids.map(id => file(id).version), [2, 2, 2, 2]);
    await w.close();
  }

  // The cloud button says what's happening, each state its own way: offline (no connection) isn't signed out, and
  // signed out with changes waiting isn't signed out with nothing waiting. Saving starts again as soon as the
  // connection is back, and a tap on the cloud that tries again and fails says why, as a tablet shows no titles.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    const cloud = () => A.p.evaluate(() => { const c = document.querySelector('#cloud'); return { s: c.dataset.s, title: c.title }; });
    const version = () => w.boardFiles()[0].version;
    assert.equal((await cloud()).s, 'ok');
    // Every request fails as it does with no connection.
    w.g.faults.push({ match: /./, abort: true });
    await A.h.pen(line(200, 350, 500, 350));
    await settle(A, 'a sync with no connection', 'offline');
    assert.deepEqual(await cloud(), { s: 'offline', title: 'Offline. Your boards are kept here and go to Drive when you’re back.' });
    await A.p.evaluate(() => document.querySelector('#toast').classList.remove('on'));
    await A.p.click('#cloud');
    await until(async () => (await toastText(A.p)) === 'Offline. Your boards are kept here and go to Drive when you’re back.', 5000, 'a tap that tries again and fails says why');
    const v = version();
    w.g.faults.length = 0;
    await A.p.evaluate(() => dispatchEvent(new Event('online')));
    await until(() => version() > v, 1500, 'the line drawn offline goes to Drive as soon as the connection is back');
    await until(async () => (await state(A)).status === 'ok', 3000, 'and the cloud says saved');
    // The browser saying it's offline: nothing is tried.
    const calls = w.g.calls.length;
    await A.p.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }));
    await settle(A, 'a sync with the browser offline', 'offline');
    assert.equal(w.g.calls.length, calls, 'no request is made while the browser is offline');
    await A.p.evaluate(() => { delete navigator.onLine; });
    await settle(A, 'back online');
    // Google's hour runs out with nothing waiting: back on the page, the cloud says so at once (not at the next timer),
    // and differently from offline.
    await A.p.evaluate(() => { const t = JSON.parse(localStorage.getItem('junkdrawer.google')); t.exp = Date.now() - 1000; localStorage.setItem('junkdrawer.google', JSON.stringify(t)); });
    await A.p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.deepEqual(await cloud(), { s: 'out', title: 'Sign in again to bring in changes from your other devices' }, 'signed out with nothing waiting');
    // The card in the menu: its first button signs in, and the line says to tap it.
    const card = () => A.p.evaluate(() => { const b = document.querySelector('#drive [data-a="now"]'); return [b.textContent, b.classList.contains('primary'), document.querySelector('#drive [data-k="line"]').textContent]; });
    assert.deepEqual(await card(), ['Sign in again', true, 'Google signs this page out after an hour. Tap Sign in again to bring in changes from your other devices.']);
    assert.match(await A.p.textContent('#drive p.small'), /Turn on Save to Google Drive on another device and the same boards show up there\./);
    await A.h.pen(line(200, 400, 500, 400));
    assert.deepEqual(await cloud(), { s: 'tap', title: 'Tap to sign in to Google again and save' }, 'signed out with a line waiting');
    assert.deepEqual(await card(), ['Sign in again', true, 'Google signs this page out after an hour. Tap Sign in again to save; your boards wait safely here meanwhile.']);
    await A.p.click('#cloud');
    await until(async () => (await state(A)).status === 'ok', 5000, 'a tap signs back in and saves');
    assert.deepEqual((await card()).slice(0, 2), ['Save now', false], 'signed in again, it saves');
    await w.close();
  }

  // A request that never answers (a captive wifi, a train in a tunnel) is given up on, here after 1.5 s, a real one
  // after half a minute: the sync ends there as it does with the connection dropped, without making each board after it
  // wait as long, and the cloud shows the grey dash. Saving isn't stuck on 'Saving' until a reload: with Drive
  // answering again, the next sync saves every line.
  {
    const w = world();
    const A = await w.device({ wait: 1500 });
    const first = await A.p.evaluate(() => cleanSlate.current());
    await A.h.pen(line(200, 300, 500, 300));
    await newBoard(A);
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    await A.h.pen(line(200, 350, 500, 350));
    await A.p.evaluate(id => cleanSlate.open(id), first);
    await A.h.pen(line(200, 350, 500, 350));
    const uploads = () => w.g.calls.filter(c => c.startsWith('PATCH /upload/')).length;
    const n = uploads();
    w.g.faults.push({ match: /^PATCH \/upload\//, hang: true });
    const t0 = Date.now();
    await A.p.evaluate(() => { cleanSlate.sync(); });
    await until(async () => (await state(A)).status === 'busy', 3000, 'saving');
    await until(async () => (await state(A)).status !== 'busy', 6000, 'a request that never answers is given up on');
    const took = Date.now() - t0;
    assert.ok(took >= 1400, `given up on after the time allowed, not before (${took} ms)`);
    assert.equal(uploads() - n, 1, 'one upload never answered, and the other board wasn\u2019t tried');
    assert.deepEqual([(await state(A)).status, (await state(A)).note], ['offline', 'Offline. Your boards are kept here and go to Drive when you\u2019re back.']);
    assert.equal(await A.p.getAttribute('#cloud', 'data-s'), 'offline', 'the cloud shows the grey dash');
    w.g.faults.length = 0;
    w.g.release();
    await settle(A, 'the next sync, with Drive answering again');
    for (const b of await A.p.evaluate(() => cleanSlate.store.list().map(b => ({ id: b.id, strokes: b.strokes.map(s => s.id) })))) {
      const file = w.boardFiles().find(f => f.appProperties.board === b.id);
      assert.equal(b.strokes.length, 2);
      assert.ok(b.strokes.every(id => file.body.includes(id)), 'Drive holds every line of both boards');
    }
    assert.equal(await A.p.getAttribute('#cloud', 'data-s'), 'ok');
    await w.close();
  }

  // A big board going to or coming from Drive slowly but surely (mobile data on a weak signal) isn't given up on for
  // taking long: the wait is for a connection that has stopped, so it starts again with every piece sent or received.
  // Here the wait is 1.5 s, and the board, about 200 KB, takes five seconds or so each way.
  {
    const w = world();
    const A = await w.device({ wait: 1500, slow: 40000 });
    await turnOn(A);
    const id = await A.p.evaluate(async () => {
      const { makeStroke, addStrokes, nextT } = await import(new URL('js/board.js', location.href));
      const id = cleanSlate.current();
      cleanSlate.store.edit(id, b => addStrokes(b, Array.from({ length: 100 }, (_, i) => makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0,
        pts: Array.from({ length: 30 }, (_, k) => [100 + k * 3.3 + i % 10 * 90, 100 + Math.sin(k / 2 + i) * 9.7 + Math.floor(i / 10) * 40, 0.3 + k % 7 / 10]).flat() }, nextT(b)))));
      return id;
    });
    const t0 = Date.now();
    await A.p.evaluate(() => { cleanSlate.sync(); });
    await until(async () => (await state(A)).status !== 'busy', 30000, 'the slow upload ends');
    const took = Date.now() - t0;
    assert.equal((await state(A)).status, 'ok', `the slow upload was kept going (${took} ms)`);
    const file = w.boardFiles().find(f => f.appProperties.board === id);
    assert.ok(file.body.length > 150000 && took > 3000, `a big board, slowly: ${file.body.length} bytes in ${took} ms`);
    assert.equal(w.g.calls.filter(c => /^(PATCH|POST) \/upload\//.test(c)).length, 1, 'sent once, not cut off and sent again');
    const B = await w.device({ wait: 1500, slow: 40000 });
    const t1 = Date.now();
    await B.p.click('#menuBtn');
    await B.p.waitForFunction(() => window.__cfg, null, { timeout: 5000 });
    await B.p.click('#drive .btn.primary');
    await until(async () => !['off', 'busy'].includes((await state(B)).status), 30000, 'the slow download ends');
    assert.equal((await state(B)).status, 'ok', `the slow download was kept going (${Date.now() - t1} ms)`);
    assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id)?.strokes.length, id), 100, 'and the board came, every line');
    await w.close();
  }

  // Drive full (403 storageQuotaExceeded) says so, and nothing more is sent (each try would send whole boards again)
  // until a tap. Google being busy (429, a rate limit, 5xx) is tried again within the sync, after 1, 2 and 4 s, and
  // when it stays busy the sync ends there, saying so without blaming a board, rather than trying every board.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    const second = await newBoard(A);
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    const FULL = 'Your Google Drive is full, so new changes aren’t reaching it. Your boards are safe here. Free some space in Drive, then tap to try again.';
    const uploads = () => w.g.calls.filter(c => c.startsWith('PATCH /upload/')).length;
    w.g.faults.push({ match: /^PATCH \/upload\//, status: 403, reason: 'storageQuotaExceeded' });
    await A.h.pen(line(200, 350, 500, 350));
    await settle(A, 'a sync with Drive full', 'full');
    assert.equal((await state(A)).note, FULL);
    assert.equal(await A.p.getAttribute('#cloud', 'data-s'), 'full');
    assert.equal(await A.p.getAttribute('#cloud', 'title'), FULL);
    const n = uploads();
    await A.h.pen(line(200, 400, 500, 400));
    await A.p.evaluate(() => dispatchEvent(new Event('online')));
    await wait(4600); // (past the save a few seconds after drawing stops)
    await A.p.evaluate(() => cleanSlate.sync());
    assert.equal(uploads(), n, 'nothing more is sent to a full Drive before a tap');
    assert.equal((await state(A)).status, 'full');
    await A.p.evaluate(() => document.querySelector('#toast').classList.remove('on'));
    await A.p.click('#cloud');
    await until(async () => (await toastText(A.p)) === FULL, 5000, 'a tap tries again, and says why when Drive is still full');
    assert.equal(uploads(), n + 1, 'the tap tried again');
    w.g.faults.length = 0;
    await A.p.click('#cloud');
    await until(async () => (await state(A)).status === 'ok', 5000, 'with space in Drive again, a tap saves');
    // A 429 twice, then Drive answers: saved in the same sync, with nothing said.
    w.g.faults.push({ match: /^PATCH \/upload\//, status: 429, reason: 'rateLimitExceeded', count: 2 });
    await A.h.pen(line(200, 450, 500, 450));
    const t0 = Date.now();
    await settle(A, 'a sync that Drive answered with 429 twice');
    assert.equal((await state(A)).note, '');
    assert.ok(Date.now() - t0 > 2500, 'after waiting about 1 and 2 s');
    assert.equal(w.g.faults.length, 0);
    // Busy every time: the sync ends after three more tries, without trying the other board.
    w.g.faults.push({ match: /^PATCH \/upload\//, status: 503, reason: 'backendError' });
    await A.h.pen(line(200, 500, 500, 500));
    await A.p.evaluate(id => cleanSlate.open(id), second);
    await A.h.pen(line(200, 500, 500, 500));
    const m = uploads();
    await A.p.evaluate(() => cleanSlate.sync());
    await until(async () => (await state(A)).status !== 'busy', 15000, 'a sync with Drive busy every time ends');
    assert.deepEqual([(await state(A)).status, (await state(A)).note], ['error', 'Google Drive is busy right now. Clean Slate will try again in a minute.']);
    assert.equal(uploads() - m, 4, 'one board tried four times, and the other not at all');
    // Stop on this device while a busy request waits to be tried again: nothing more is sent.
    await A.h.pen(line(200, 550, 500, 550));
    const k = uploads();
    A.p.evaluate(() => cleanSlate.sync());
    await until(() => uploads() > k, 5000, 'the save started');
    await A.p.click('#menuBtn');
    await A.p.click('#drive .btn.quiet');
    await wait(450);
    await A.p.click('#drive .btn.quiet');
    await wait(3500);
    assert.equal(uploads(), k + 1, 'Stop on this device ends the tries');
    await w.close();
  }

  // The Drive card keeps its buttons through a save: Stop waiting for its second tap still asks, and the keyboard
  // stays where it was. A failure's note is in red, on its own line, with 'Last saved …' kept beside it.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    await A.p.click('#menuBtn');
    await A.p.click('#drive .btn.quiet');
    assert.equal(await A.p.textContent('#drive .btn.quiet'), 'Tap again to stop');
    // (Read as the save starts and as it ends: a save can take less time than a timer's shortest tick.)
    assert.deepEqual(await A.p.evaluate(async () => { const going = cleanSlate.sync(), s = [cleanSlate.syncState().status]; await going; return [...s, cleanSlate.syncState().status]; }), ['busy', 'ok']);
    assert.equal(await A.p.textContent('#drive .btn.quiet'), 'Tap again to stop', 'a save in between doesn’t forget the question');
    await wait(450);
    await A.p.click('#drive .btn.quiet');
    assert.equal((await state(A)).on, false, 'and the second tap stops');
    await A.p.click('#drive .btn.primary');
    await until(async () => (await state(A)).status === 'ok', 5000, 'on again');
    // The keyboard on Save now stays there through the save it starts.
    await A.p.focus('#drive [data-a="now"]');
    await A.p.keyboard.press('Enter');
    await until(async () => (await state(A)).status === 'ok', 5000, 'saved from the keyboard');
    assert.equal(await A.p.evaluate(() => document.activeElement.dataset.a), 'now', 'focus stays on Save now');
    // A failure: its note in red, and when it was last saved beside it.
    w.g.faults.push({ match: /^PATCH \/upload\//, status: 413, reason: 'uploadTooLarge' });
    await A.p.click('#menu [data-close]');
    await A.h.pen(line(200, 350, 500, 350));
    await settle(A, 'a save turned away', 'error');
    assert.equal(await A.p.textContent('#drive p.small.err'), '“Board 1” couldn’t be saved to Google Drive.');
    assert.match(await A.p.textContent('#drive p.small:not(.err)'), /Last saved just now\.$/);
    await w.close();
  }

  // Each device draws on its own first board, then both save to Drive: the two 'Board 1's settle on different names,
  // the same on both devices and in Drive.
  {
    const w = world();
    const A = await w.device(), B = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    await B.h.pen(line(200, 400, 500, 400));
    await turnOn(A);
    await turnOn(B);
    await settle(B, 'B saved the new name');
    await settle(A, 'A has it');
    const names = async d => (await boards(d)).map(b => b.id + ' ' + b.name).sort();
    assert.deepEqual((await boards(A)).map(b => b.name).sort(), ['Board 1', 'Board 2']);
    assert.deepEqual(await names(A), await names(B));
    assert.deepEqual(w.boardFiles().map(f => f.name).sort(), ['Board 1.svg', 'Board 2.svg']);
    // The board on screen shows its new name at once, in the header and the tab's title.
    for (const d of [A, B]) {
      const [shown, title, name] = await d.p.evaluate(() => [document.querySelector('#boardName').textContent, document.title, cleanSlate.store.get(cleanSlate.current()).name]);
      assert.equal(shown, name, 'the header shows the open board’s name');
      assert.equal(title, `${name} · Clean Slate`, 'and so does the title');
    }
    await w.close();
  }

  // A device that stopped saving to Drive (Stop on this device) and turns it on again after another device deleted
  // boards meanwhile: they stay deleted on both, as Drive's trash says, rather than coming back as new files. One that
  // was drawn on here meanwhile comes back, on both.
  {
    const w = world();
    const A = await w.device();
    const ids = [await A.p.evaluate(() => cleanSlate.current())];
    await A.h.pen(line(200, 300, 500, 300));
    for (const name of ['Shed', 'Plans', 'Garden']) { ids.push(await newBoard(A, name)); await A.h.pen(line(200, 300, 500, 300)); }
    const [, shed, plans] = ids;
    await turnOn(A);
    const B = await w.device();
    await turnOn(B);
    assert.equal((await boards(B)).length, 4);
    await A.p.click('#menuBtn');
    await A.p.click('#drive .btn.quiet');
    await wait(450);
    await A.p.click('#drive .btn.quiet');
    await A.p.click('#menu [data-close]');
    assert.equal((await state(A)).on, false, 'A stopped');
    const backup = await B.p.evaluate(id => JSON.stringify({ cleanSlate: 1, boards: [cleanSlate.store.get(id)] }), shed);
    for (const id of [shed, plans]) await B.p.evaluate(id => cleanSlate.store.remove(id), id);
    await settle(B, 'B binned the two boards');
    await A.p.evaluate(id => cleanSlate.open(id), plans);
    await A.h.pen(line(200, 400, 500, 400));
    await turnOn(A);
    const live = id => w.boardFiles().filter(f => f.appProperties.board === id && !f.trashed).length;
    assert.deepEqual((await boards(A)).map(b => b.name).sort(), ['Board 1', 'Garden', 'Plans'], 'the board deleted on B stays deleted on A');
    assert.equal(live(shed), 0, 'and gets no new Drive file');
    assert.deepEqual([live(plans), (await boards(A)).find(b => b.id === plans).n], [1, 2], 'the one drawn on meanwhile comes back with both lines');
    await settle(B, 'B synced after A came back');
    assert.deepEqual((await boards(B)).map(b => b.name).sort(), ['Board 1', 'Garden', 'Plans'], 'and on B, only that one is back');
    // A board deleted and then brought back from a backup file on purpose stays.
    await B.p.click('#menuBtn');
    await B.p.setInputFiles('#restoreFile', { name: 'Shed.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await until(async () => (await boards(B)).some(b => b.id === shed), 3000, 'the backup opened'); // (the file is read first)
    await settle(B, 'B saved the board brought back from a backup');
    assert.deepEqual([(await boards(B)).some(b => b.id === shed), live(shed)], [true, 1], 'a board brought back from a backup stays, with a new Drive file');
    const listed = JSON.parse(w.g.files().find(f => f.appProperties?.cleanslate === 'deleted' && !f.trashed).body).deleted;
    assert.deepEqual(listed, {}, 'and both boards that came back are off the list of deleted boards');
    await w.close();
  }

  // A device left unopened for over a month, while Google emptied the Drive trash, deleted boards' files and all: the
  // list of deleted boards in the Clean Slate folder tells it. The boards deleted on the other device meanwhile go here
  // too (the one on screen saying so) and get no new file; one drawn on here as it comes back is kept, on both, and comes
  // off the list. The list holds only each board's id and when it was deleted.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    const shed = await newBoard(A, 'Shed');
    await A.h.pen(line(200, 300, 500, 300));
    const plans = await newBoard(A, 'Plans');
    await A.h.pen(line(200, 300, 500, 300));
    const garden = await newBoard(A, 'Garden');
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    const B = await w.device();
    await turnOn(B);
    assert.equal((await boards(B)).length, 4);
    await A.p.evaluate(id => cleanSlate.open(id), shed);
    await A.p.evaluate(() => document.querySelector('#toast').classList.remove('on'));
    const t0 = Date.now();
    for (const id of [shed, plans, garden]) await B.p.evaluate(id => cleanSlate.store.remove(id), id);
    await settle(B, 'B binned the three boards');
    const lists = () => w.g.files().filter(f => f.appProperties?.cleanslate === 'deleted' && !f.trashed);
    assert.equal(lists().length, 1, 'one list of deleted boards');
    const [file] = lists(), folder = w.g.files().find(f => f.mimeType === 'application/vnd.google-apps.folder');
    assert.deepEqual([file.name, file.mimeType, file.parents], ['Deleted boards.json', 'application/json', [folder.id]], 'in the Clean Slate folder');
    const held = JSON.parse(file.body);
    assert.deepEqual(Object.keys(held), ['cleanSlate', 'deleted']);
    assert.deepEqual(Object.keys(held.deleted).sort(), [shed, plans, garden].sort(), 'it holds the three boards’ ids');
    assert.ok(Object.values(held.deleted).every(t => t >= t0 && t <= Date.now()), 'and when each was deleted, and nothing else');
    // A month and more on: Google has emptied the trash.
    for (const f of w.g.files()) if (f.trashed) delete w.g.drive.files[f.id];
    const live = id => w.boardFiles().filter(f => f.appProperties.board === id).length;
    assert.equal(live(shed) + live(plans) + live(garden), 0, 'no trace of the boards’ files in Drive');
    // A comes back, and Garden is drawn on as it does.
    await A.p.evaluate(id => cleanSlate.store.edit(id, b => { b.name = 'Garden plan'; b.nameAt = Date.now(); }), garden);
    await settle(A, 'A synced after a month');
    assert.deepEqual((await boards(A)).map(b => b.name).sort(), ['Board 1', 'Garden plan'], 'the boards deleted on B stay deleted on A');
    assert.equal(live(shed) + live(plans), 0, 'and get no new Drive file');
    assert.notEqual(await A.p.evaluate(() => cleanSlate.current()), shed, 'A moved off the deleted board');
    assert.equal(await toastText(A.p), '“Shed” was deleted on another device.', 'and said so, without sending anyone to an emptied trash');
    assert.equal(live(garden), 1, 'the board drawn on comes back');
    assert.deepEqual(Object.keys(JSON.parse(lists()[0].body).deleted).sort(), [shed, plans].sort(), 'and comes off the list');
    await settle(B, 'B synced');
    assert.deepEqual((await boards(B)).map(b => [b.name, b.n]).sort(), [['Board 1', 1], ['Garden plan', 1]], 'on B too');
    await w.close();
  }

  // A board drawn on a tablet opens on a phone with all of it on screen (where a board is on screen is kept on each
  // device, so a board new here has none yet), and opens that way again next time.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    await A.h.pen(line(350, 150, 350, 450));
    await turnOn(A);
    const B = await w.device({ phone: true });
    await turnOn(B);
    const where = () => B.p.evaluate(async () => {
      const { contentBounds } = await import('./js/ink.js');
      const v = cleanSlate.surface.view, b = cleanSlate.store.get(cleanSlate.current());
      return { v, saved: b.view, w: innerWidth, h: innerHeight, boxes: b.strokes.map(s => contentBounds([s])) };
    });
    const { v, saved, w: vw, h: vh, boxes } = await where();
    assert.equal(boxes.length, 2, 'the tablet’s board is open on the phone');
    for (const c of boxes) assert.ok((c.x0 - v.x) * v.z >= 0 && (c.x1 - v.x) * v.z <= vw && (c.y0 - v.y) * v.z >= 0 && (c.y1 - v.y) * v.z <= vh, `a line is off the phone's screen: ${JSON.stringify({ c, v })}`);
    assert.ok(v.z <= 1, 'without zooming in past 100%');
    assert.deepEqual(saved, v, 'and it opens that way next time');
    assert.equal(await toastText(B.p), 'Brought one board from Google Drive.');
    await w.close();
  }

  // A sync that finds the open board deleted on another device while a line is being drawn on it waits: the line is
  // kept, and the next sync brings the board back on both. A sync that finds it deleted otherwise says so as it goes.
  {
    const w = world();
    const A = await w.device();
    const plans = await A.p.evaluate(() => cleanSlate.current());
    await A.h.pen(line(200, 300, 500, 300));
    const shed = await newBoard(A, 'Shed');
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    const B = await w.device();
    await turnOn(B);
    await A.p.evaluate(id => cleanSlate.open(id), plans);
    await A.p.evaluate(() => document.querySelector('#toast').classList.remove('on'));
    await B.p.evaluate(id => cleanSlate.store.remove(id), plans);
    await settle(B, 'B binned the board');
    await A.h.penDown(200, 400);
    for (let i = 1; i <= 5; i++) await A.h.penMove(200 + i * 30, 400);
    await settle(A, 'A synced with the pen down');
    for (let i = 6; i <= 10; i++) await A.h.penMove(200 + i * 30, 400);
    await A.h.penUp(500, 400);
    assert.equal(await A.p.evaluate(() => cleanSlate.current()), plans, 'the board stays open under the pen');
    assert.equal(await count(A.p), 2, 'and the line drawn as the deletion arrived is kept');
    assert.equal(await toastText(A.p), '');
    await settle(A, 'A saved the board again');
    assert.equal(w.boardFiles().filter(f => f.appProperties.board === plans && !f.trashed).length, 1, 'the board is back in Drive');
    await settle(B, 'B synced');
    assert.equal((await boards(B)).find(b => b.id === plans)?.n, 2, 'and on B, with both lines');
    assert.equal(await toastText(B.p), '“Board 1” is back: it was drawn on on another device after you deleted it.', 'and B says why');
    // The open board deleted on another device, with no pen on it.
    await A.p.evaluate(id => cleanSlate.open(id), shed);
    await B.p.evaluate(id => cleanSlate.store.remove(id), shed);
    await settle(B, 'B binned Shed');
    await settle(A, 'A synced');
    assert.equal(await A.p.evaluate(() => cleanSlate.current()), plans, 'A moved to another board');
    assert.equal(await toastText(A.p), '“Shed” was deleted on another device. It’s in the Drive trash for 30 days.', 'and said why');
    await w.close();
  }

  // A Drive file Clean Slate can't read (an SVG edited in another app, which dropped the board inside it) is downloaded
  // once, not again on every sync, until it changes.
  {
    const w = world();
    const A = await w.device();
    await A.h.pen(line(200, 300, 500, 300));
    await turnOn(A);
    const id = 'f' + w.g.drive.next++;
    w.g.drive.files[id] = { owner: 'mark', name: 'Edited.svg', mimeType: 'image/svg+xml', appProperties: { cleanslate: 'board', board: 'bedited' }, version: 1, created: w.g.drive.next, modified: Date.now(), body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h9"/></svg>' };
    const gets = () => w.g.calls.filter(c => c === `GET /drive/v3/files/${id}?alt=media`).length;
    await settle(A, 'A synced with a file it can’t read');
    await settle(A, 'and again');
    assert.equal(gets(), 1, 'a file that can’t be read is downloaded once');
    assert.equal((await state(A)).note, 'One board file in your Drive couldn’t be read, so Clean Slate left it alone.', 'and the note still says so');
    w.g.drive.files[id].version++;
    await settle(A, 'A synced after the file changed');
    assert.equal(gets(), 2, 'and again once it has changed');
    await w.close();
  }

  // A device whose clock is two minutes slow writes across a rub-out made on the other device: the new line goes on
  // top, not under the rub-out (which would cut a gap in it).
  {
    const w = world();
    const A = await w.device(), B = await w.device({ skew: -120000 });
    await A.h.pen(line(150, 300, 700, 300));
    await turnOn(A);
    await turnOn(B);
    await A.p.click('[data-tool="eraser"]');
    await A.p.click('[data-mode="rub"]');
    await A.h.pen(line(400, 200, 400, 600, 20));
    await settle(A, 'A saved its rub-out');
    await settle(B, 'B has the rub-out');
    await B.h.pen(line(150, 450, 700, 450));
    const order = d => d.p.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes.map(s => s.tool));
    assert.deepEqual(await order(B), ['pen', 'rub', 'pen'], 'the slow device’s new line goes on top of the rub-out');
    await settle(B, 'B saved its line');
    await settle(A, 'A has B’s line');
    assert.deepEqual(await order(A), ['pen', 'rub', 'pen'], 'and on the other device too');
    await w.close();
  }
}

// Undo and Redo carry on after a reload: each board's last 50 steps are kept with it on the device.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('undo kept: ' + e.message));
  const ready = async () => { await p.waitForFunction(() => document.body.classList.contains('ready')); };
  const draw = async y => { await p.mouse.move(200, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(200 + i * 40, y); await p.mouse.up(); };
  await p.goto(base);
  await ready();
  for (let i = 0; i < 3; i++) await draw(300 + i * 60);
  await p.keyboard.press('Control+z');
  assert.equal(await count(p), 2);
  await p.evaluate(() => cleanSlate.store.flush());
  await p.reload();
  await ready();
  assert.deepEqual([await count(p), await p.isEnabled('#undo'), await p.isEnabled('#redo')], [2, true, true], 'after a reload, Undo and Redo are both there');
  await p.click('#redo');
  assert.equal(await count(p), 3, 'Redo puts back the line undone before the reload');
  for (let i = 0; i < 3; i++) await p.click('#undo');
  assert.deepEqual([await count(p), await p.isEnabled('#undo')], [0, false], 'and Undo takes away all three lines drawn before it');
  // The steps are kept in the board's own record, so a board deleted takes them with it (and a backup has none).
  assert.equal(await p.evaluate(() => cleanSlate.store.get(cleanSlate.current()).undo.redo.length), 3);
  await c.close();
}

// Make a copy, in the menu: another board with the same drawing, colour and lines, opened and named so.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('make a copy: ' + e.message));
  const draw = async y => { await p.mouse.move(200, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(200 + i * 40, y); await p.mouse.up(); };
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.click('#menuBtn');
  assert.equal(await p.isDisabled('#copyBoard'), true, 'nothing to copy on an empty board');
  await p.fill('#nameInput', 'Garden plan');
  await p.press('#nameInput', 'Enter');
  await p.click('[data-bg="paper"]');
  await p.click('#menu [data-close]');
  await until(() => p.isHidden('#menu'), 2000, 'the menu closes');
  await draw(300);
  await draw(400);
  const first = await p.evaluate(() => cleanSlate.current());
  await p.click('#menuBtn');
  await p.click('#copyBoard');
  await until(() => p.isHidden('#menu'), 2000, 'Make a copy closes the menu');
  const [was, now] = await p.evaluate(id => [cleanSlate.store.get(id), cleanSlate.store.get(cleanSlate.current())], first);
  assert.notEqual(now.id, was.id, 'and opens the copy');
  assert.deepEqual([now.name, now.bg, now.pattern, await p.textContent('#boardName')], ['Garden plan copy', 'paper', 'grid', 'Garden plan copy']);
  assert.deepEqual(now.strokes.map(s => s.pts.join()), was.strokes.map(s => s.pts.join()), 'with the same drawing');
  assert.equal(await toastText(p), 'Opened “Garden plan copy”, a copy of “Garden plan”.');
  assert.equal(await p.isDisabled('#undo'), true, 'with nothing to undo on it yet');
  await draw(500);
  assert.deepEqual([await count(p), await p.evaluate(id => cleanSlate.store.get(id).strokes.length, first)], [3, 2], 'drawing on the copy leaves the board it came from as it was');
  await c.close();
}

// Save a picture of just what's on screen: PNG (and Share and Copy) follow the choice, kept on the device; SVG doesn't.
{
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('on screen: ' + e.message));
  const draw = async y => { await p.mouse.move(300, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(300 + i * 40, y); await p.mouse.up(); };
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await draw(300);
  await p.evaluate(() => cleanSlate.surface.setView({ x: 3000, y: 2000, z: 1 }));
  await draw(400); // a second note far away, at (3000 + 300, 2000 + 400) on the board
  await p.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
  // The picture saved, as [width, height, how dark it is where the first note is, and below it].
  const saved = async () => {
    const [file] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('#savePng')]);
    const png = await readFile(await file.path());
    return p.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const k = img.width / innerWidth, cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const x = cv.getContext('2d');
      x.drawImage(img, 0, 0);
      const at = (px, py) => x.getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data[0];
      return [img.width, img.height, at(460, 300), at(460, 500)];
    }, png.toString('base64'));
  };
  await p.click('#menuBtn');
  assert.equal(await p.getAttribute('[data-picture="all"]', 'aria-pressed'), 'true', 'the whole drawing to start with');
  const whole = await saved();
  assert.ok(whole[0] > 3000, `the whole drawing takes in both notes (${whole[0]} wide)`);
  await p.click('[data-picture="screen"]');
  assert.match(await p.textContent('#pictureSays'), /^Just what’s on screen/);
  const shown = await saved();
  assert.deepEqual(shown.slice(0, 2), [2048, 1536], 'what’s on screen, at twice its size');
  assert.ok(shown[2] < 100 && shown[3] > 200, `with the note where it is on screen (${shown.slice(2)})`);
  const [svg] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('#saveSvg')]);
  assert.match(await readFile(await svg.path(), 'utf8'), /viewBox="[-\d.]+ [-\d.]+ (3\d{3}|[4-9]\d{3})/, 'the SVG is still the whole drawing');
  await p.reload();
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.evaluate(() => cleanSlate.surface.setView({ x: -5000, y: 0, z: 1 }));
  await p.click('#menuBtn');
  assert.equal(await p.getAttribute('[data-picture="screen"]', 'aria-pressed'), 'true', 'the choice is kept after a reload');
  await p.click('#savePng');
  assert.equal(await toastText(p), 'None of the drawing is on screen. Show it all, or save the whole drawing.');
  await c.close();
}

// A board renamed from the list of boards: its pencil turns the name into a text box. Enter or leaving the box keeps
// the name typed, Esc or an empty box the one it had, and a tap on another board that ends it opens that board.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push('rename in the list: ' + e.message));
  await p.goto(base);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  const first = await p.evaluate(() => cleanSlate.current());
  // New board on a board that's still empty and unnamed goes back to it, rather than making another empty one.
  await p.click('#boardsBtn');
  await p.click('#newBoard');
  await until(() => p.isHidden('#boards'), 2000, 'New board on an empty board closes the list');
  assert.deepEqual([await toastText(p), await p.evaluate(() => cleanSlate.store.list().length)], ['This board is still empty.', 1], 'and says so, with no second board');
  await p.evaluate(() => cleanSlate.store.edit(cleanSlate.current(), b => { b.strokes.push({ id: 's1', t: 1, tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [10, 10, 0.5, 90, 40, 0.5] }); }));
  await p.click('#boardsBtn');
  await p.click('#newBoard');
  const second = await p.evaluate(() => cleanSlate.current());
  await p.click('#boardsBtn');
  const row = id => `#boardList [data-row="${id}"]`;
  const right = await p.evaluate(() => { const s = document.querySelector('#boards').getBoundingClientRect(), d = document.querySelector('#boardList .del').getBoundingClientRect(); return [s.right, d.right]; });
  assert.ok(right[1] <= right[0], `the pencil and the bin fit in the list on a phone (${right})`);
  await p.click(`${row(first)} [data-ren]`);
  assert.deepEqual(await p.evaluate(() => { const r = document.activeElement; return [r.className, r.value, r.selectionStart, r.selectionEnd, r.maxLength]; }), ['rename', 'Board 1', 0, 7, 80], 'the name, chosen, in a box as long as the menu’s');
  await p.keyboard.type('Garden plan');
  await p.keyboard.press('Enter');
  assert.deepEqual(await p.evaluate(id => [cleanSlate.store.get(id).name, cleanSlate.store.get(id).nameAt > 0, document.activeElement.dataset.id], first), ['Garden plan', true, first], 'Enter keeps it, and the keyboard goes back to the board');
  assert.equal(await p.textContent(`${row(first)} .what b`), 'Garden plan');
  assert.equal(await p.textContent('#boardName'), 'Board 2', 'the open board keeps its name');
  // The open board: the top button follows, and a tap elsewhere in the list keeps the name.
  await p.click(`${row(second)} [data-ren]`);
  await p.keyboard.type('Sh');
  // (A sync that redraws the list meanwhile leaves the typing where it was.)
  await p.evaluate(id => cleanSlate.store.edit(id, b => { b.bg = 'paper'; }, 'sync'), first);
  await p.keyboard.type('ed');
  await p.click('#boardsTitle');
  assert.deepEqual([await p.textContent('#boardName'), await p.isVisible('#boards')], ['Shed', true], 'leaving the box keeps it, and the list stays open');
  // Esc and an empty box keep the name it had.
  await p.click(`${row(second)} [data-ren]`);
  await p.keyboard.type('Nope');
  await p.keyboard.press('Escape');
  assert.deepEqual([await p.textContent('#boardName'), await p.isVisible('#boards')], ['Shed', true], 'Esc keeps the name it had, and leaves the list open');
  await p.click(`${row(second)} [data-ren]`);
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Enter');
  assert.equal(await p.textContent(`${row(second)} .what b`), 'Shed', 'so does an empty box');
  // A tap on another board while renaming keeps the name and opens that board, in one tap.
  await p.click(`${row(second)} [data-ren]`);
  await p.keyboard.type('Shed roof');
  await p.tap(`${row(first)} .open`);
  await until(() => p.isHidden('#boards'), 2000, 'a tap on another board opens it');
  assert.deepEqual([await p.evaluate(() => cleanSlate.current()), await p.evaluate(id => cleanSlate.store.get(id).name, second)], [first, 'Shed roof']);
  // Closing the list keeps a name being typed too.
  await p.click('#boardsBtn');
  await p.click(`${row(first)} [data-ren]`);
  await p.keyboard.type('Allotment');
  await p.click('#boards [data-close]');
  assert.equal(await p.textContent('#boardName'), 'Allotment', 'closing the list keeps it');
  await c.close();
}

// The one-file copy (npm run build makes dist/clean-slate.html, for sharing as a single page) opens from the file and
// draws, fetching nothing from anywhere, with no Google Drive. Opened as a file it saves pictures and backups; shown
// inside another page, in a frame, it leaves them out.
{
  execSync('node scripts/build.mjs', { cwd: root, stdio: 'ignore' });
  const c = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p = await c.newPage();
  const fetched = [];
  p.on('pageerror', e => problems.push('one file: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push('one file: ' + m.text()); });
  p.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) fetched.push(r.url()); });
  await p.goto(pathToFileURL(join(root, 'dist/clean-slate.html')).href);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.mouse.move(200, 300);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(200 + i * 30, 300 + i * 5);
  await p.mouse.up();
  assert.equal(await count(p), 1, 'the one-file copy draws');
  assert.equal(await p.evaluate(() => 'single' in document.documentElement.dataset), true, 'and knows it is the one-file copy');
  assert.equal(await p.isHidden('#drive'), true, 'with no Google Drive');
  assert.equal(await p.isHidden('#homeScreen'), true, 'and nothing to add to a home screen');
  await p.click('#menuBtn');
  for (const [btn, name] of [['#savePng', 'Board 1.png'], ['#saveSvg', 'Board 1.svg'], ['#backup', /^Clean Slate backup .*\.json$/]]) {
    const [file] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click(btn)]);
    assert.match(file.suggestedFilename(), name instanceof RegExp ? name : new RegExp(`^${name.replace('.', '\\.')}$`), `the one-file copy saves ${name}`);
  }
  assert.deepEqual([await p.isVisible('#restore'), await p.isVisible('#settings')], [true, true], 'and opens files, under Settings');
  assert.deepEqual(fetched, [], 'and fetches nothing from anywhere');
  await c.close();
  const f = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const q = await f.newPage();
  q.on('pageerror', e => problems.push('one file, framed: ' + e.message));
  await q.setContent(`<iframe src="${base}dist/clean-slate.html" style="width:1000px;height:740px;border:0"></iframe>`);
  const inner = q.frames()[1];
  await inner.waitForFunction(() => document.body.classList.contains('ready'));
  await inner.click('#menuBtn');
  assert.deepEqual(await inner.evaluate(() => ['#savePng', '#saveSvg', '#backup', '#restore', '#settings'].map(s => !!document.querySelector(s).closest('[hidden]'))),
    [true, true, true, true, true], 'framed in another page, it leaves out pictures, backups and files, and so Settings on a computer');
  await f.close();
}

// It can be installed (as Chrome sees it), and its manifest has no errors.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'it can be installed');
assert.deepEqual((await cdp.send('Page.getAppManifest')).errors, [], 'its manifest has no errors');

// Nothing went wrong while using it: no errors, and no request that failed (a missing icon, image or font).
assert.deepEqual(problems, [], 'problems while using it');

// Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
// browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
const title = await page.title();
net = 'down';
await ctx.setOffline(true);
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 5000 });
assert.equal(await page.title(), title, 'the page did not open offline');
assert.equal(await count(page), before, 'the board is there offline');
// A file the copy hasn't got fails, as it would with no worker, rather than coming back as the page (HTML, with a
// 200); the big icons the manifest names are in the copy.
assert.deepEqual(await page.evaluate(() => Promise.all(['nope.png', 'icon-512.png', 'icon-512-maskable.png'].map(u => fetch(u).then(r => `${r.status} ${r.headers.get('content-type')}`, () => 'failed')))),
  ['failed', '200 image/png', '200 image/png'], 'offline, a missing file fails and the icons are there');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
release = false;

// (Offline, and with the connection stalled, requests fail and the browser says so: that's expected there.)
assert.deepEqual(problems.filter(p => !p.startsWith('failed:') && !p.startsWith('Failed to load resource')), [], 'problems offline');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
