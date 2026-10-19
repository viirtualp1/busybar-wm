import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { BusyBar } from '@busy-app/busy-lib';
import { createMockBar, type MockBar } from '../src/mock-bar.js';
import { ProxyServer } from '../src/proxy/server.js';
import { Upstream } from '../src/bar/upstream.js';
import { Compositor } from '../src/wm/compositor.js';
import { OWNER } from '../src/wm/canvas.js';
import { Scene } from '../src/wm/scene.js';
import type { AppManifest } from '../src/manifest.js';

/**
 * The end to end that matters: two unmodified apps, talking to what they think
 * is a Bar, and exactly one of them on the screen at a time.
 *
 * The device sees one application, `OWNER`, whatever the apps call themselves;
 * whose frame is up is told by the element ids, which carry the app's name.
 */

const quiet = { info: () => undefined, warn: () => undefined };

function manifest(name: string, rank: number): AppManifest {
  return { name, rank, args: [], env: {}, autostart: false, restart: false };
}

let bar: MockBar;
let proxy: ProxyServer;
let scene: Scene;
let compositor: Compositor;
let low: BusyBar;
let high: BusyBar;

before(async () => {
  bar = await createMockBar();
  const upstream = new Upstream({ addr: bar.url, timeoutMs: 2000 });

  scene = new Scene([manifest('low', 10), manifest('high', 50)], {
    staleMs: 60_000,
    onChange: () => compositor.wake(),
  });
  compositor = new Compositor(scene, upstream, {
    minHoldMs: 0,
    pinTimeoutMs: 0,
    tickMs: 50,
    logger: quiet,
  });
  proxy = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    upstream,
    scene,
    logger: quiet,
  });

  await proxy.listen();
  // Both apps are supervised as far as the scene is concerned; here the
  // test plays the supervisor.
  scene.setRunning('low', true);
  scene.setRunning('high', true);
  compositor.start();

  const addr = `http://127.0.0.1:${proxy.port}`;
  low = new BusyBar({ addr, timeout: 2000 });
  high = new BusyBar({ addr, timeout: 2000 });
});

after(async () => {
  await compositor.stop();
  await proxy.close();
  await bar.close();
});

function draw(client: BusyBar, name: string, text: string) {
  return client.DisplayDraw({
    application_name: name,
    priority: 50,
    elements: [
      {
        type: 'text',
        id: 'line',
        x: 0,
        y: 0,
        display: 'front',
        font: 'normal',
        color: '#ffffff',
        text,
      },
    ],
  });
}

/** Whose elements the canvas holds — one app's, or something is wrong. */
function onScreen(): string | null {
  const apps = new Set([...bar.canvas.keys()].map((id) => id.split('/')[0]));
  assert.ok(apps.size <= 1, `one app on the canvas, not ${[...apps].join(', ')}`);

  return [...apps][0] ?? null;
}

function text(id = 'low/legacy:line'): unknown {
  return bar.canvas.get(id)?.['text'];
}

async function until(what: string, predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('an app draws at the proxy and its frame reaches the device', async () => {
  await draw(low, 'low', 'hello');

  await until('low on screen', () => onScreen() === 'low');
  assert.equal(bar.draws.at(-1)?.application_name, OWNER);
  assert.equal(text(), 'hello');
});

test('a higher-ranked app takes the screen, and the old one’s elements go by id', async () => {
  const clearsBefore = bar.clears.length;
  await draw(high, 'high', 'urgent');

  await until('high on screen', () => onScreen() === 'high');
  assert.equal(text('high/legacy:line'), 'urgent');
  const clears = bar.clears.slice(clearsBefore);
  assert.deepEqual(
    clears.map((clear) => clear.element_ids),
    [['low/legacy:line']],
    'elements persist by id, so they are deleted by id — and the canvas is never cleared whole',
  );
});

test('the app that lost the screen keeps drawing, and nothing reaches the device', async () => {
  const before = bar.draws.length;
  await draw(low, 'low', 'still here');
  await draw(low, 'low', 'and here');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bar.draws.length, before, 'the device saw none of it');
  assert.equal(onScreen(), 'high');
});

test('when the winner yields, the loser is replayed without being asked again', async () => {
  await high.DisplayClear({ application_name: 'high' });

  await until('low back on screen', () => onScreen() === 'low');
  // The frame it drew while off screen — the app was never told to redraw.
  assert.equal(text(), 'and here');
});

test('when the Bar drops the canvas by itself, the frame comes back', async () => {
  // A short BACK on the device: everything of ours is gone, and nothing about
  // the app's frame changed to say so.
  bar.drop();
  compositor.deviceDropped();

  await until('low redrawn', () => text() === 'and here');
});

test('a DELETE naming elements takes only those off the device', async () => {
  await low.DisplayDraw({
    application_name: 'low',
    priority: 50,
    elements: [
      {
        type: 'text',
        id: 'extra',
        x: 0,
        y: 8,
        display: 'front',
        font: 'small',
        color: '#ffffff',
        text: 'extra',
      },
    ],
  });
  await until('extra drawn', () => bar.canvas.has('low/legacy:extra'));

  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/display/draw`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ application_name: 'low', element_ids: ['extra'] }),
  });
  assert.equal(response.status, 200);

  await until('extra gone', () => !bar.canvas.has('low/legacy:extra'));
  assert.equal(text(), 'and here', 'and the rest stays');
});

test('a Bar that stops answering is given up on, and the app is told', async () => {
  // Accepts the connection and never says a word, the way a hung device does.
  const silent = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const address = silent.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const stuck = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new Upstream({ addr: `http://127.0.0.1:${port}` }),
    scene: new Scene([], { staleMs: 1000 }),
    logger: quiet,
    timeoutMs: 150,
  });
  await stuck.listen();

  try {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${stuck.port}/api/system/status`);

    assert.equal(response.status, 504);
    assert.ok(Date.now() - started < 2000, 'not left to the app’s own timeout');
  } finally {
    await stuck.close();
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test('an unreachable Bar is a 502 straight away', async () => {
  const gone = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    // Nothing listens on port 9 here.
    upstream: new Upstream({ addr: 'http://127.0.0.1:9' }),
    scene: new Scene([], { staleMs: 1000 }),
    logger: quiet,
  });
  await gone.listen();

  try {
    const response = await fetch(`http://127.0.0.1:${gone.port}/api/system/status`);
    assert.equal(response.status, 502);
  } finally {
    await gone.close();
  }
});

test('an upload goes to the device, into the folder the daemon draws from', async () => {
  await low.AssetsUpload({
    application_name: 'low',
    file: 'cover.png',
    data: Buffer.from('not really a png'),
  });

  assert.deepEqual(bar.assets.at(-1), {
    application_name: OWNER,
    file: 'low/cover.png',
    size: 16,
  });
});

test('an image is drawn from where its upload went', async () => {
  await low.DisplayDraw({
    application_name: 'low',
    priority: 50,
    elements: [
      {
        type: 'image',
        id: 'art',
        x: 0,
        y: 0,
        display: 'back',
        path: 'cover.png',
        opacity: 100,
      },
    ],
  });

  await until('the image on the canvas', () => bar.canvas.has('low/legacy:art'));
  assert.equal(bar.canvas.get('low/legacy:art')?.['path'], 'low/cover.png');
});

test('a sound an app uploaded is played from where its upload went', async () => {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/audio/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ application_name: 'low', path: 'ding.wav' }),
  });
  await low.AudioPlay({ application_name: 'low', stock_path: 'sounds/ding' });

  assert.equal(response.status, 200);
  assert.deepEqual(bar.sounds, [
    { application_name: OWNER, path: 'low/ding.wav' },
    { application_name: 'low', stock_path: 'sounds/ding' },
  ]);
});

test('an app deleting its assets is answered here, and nobody else’s go', async () => {
  const response = await fetch(
    `http://127.0.0.1:${proxy.port}/api/assets/upload?application_name=low`,
    { method: 'DELETE' },
  );

  assert.equal(response.status, 200, 'the mock has no such route; the proxy answered');
});

test('a Bar busy with its own session is waited out, not crashed on', async () => {
  bar.lowPriority = true;
  await draw(low, 'low', 'rejected');
  await new Promise((resolve) => setTimeout(resolve, 200));

  bar.lowPriority = false;
  await until('the frame arrives once the Bar is free', () => {
    const last = bar.draws.at(-1);

    return (last?.elements as { text?: string }[]).some(
      (element) => element.text === 'rejected',
    );
  });
});

test('every app is told its draw landed, so none of them back off', async () => {
  // The apps never learn they are off screen; that is what keeps them
  // unmodified and their last frame replayable.
  const response = await draw(high, 'high', 'off screen');

  assert.ok(response !== undefined);
});

test('the supervisor’s placeholder password is not sent to a Bar that wants none', async () => {
  const seen: (string | undefined)[] = [];
  const device = createServer((req, res) => {
    const token = req.headers['x-api-token'];
    seen.push(Array.isArray(token) ? token[0] : token);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => device.listen(0, '127.0.0.1', resolve));
  const address = device.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const usb = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    // No password: a Bar on USB.
    upstream: new Upstream({ addr: `http://127.0.0.1:${port}` }),
    scene: new Scene([], { staleMs: 1000 }),
    logger: quiet,
  });
  await usb.listen();

  try {
    for (const token of ['managed-by-wm', 'the-real-one']) {
      await fetch(`http://127.0.0.1:${usb.port}/api/status/system`, {
        headers: { 'x-api-token': token },
      });
    }
    assert.deepEqual(
      seen,
      [undefined, 'the-real-one'],
      'a real password from an app still goes',
    );
  } finally {
    await usb.close();
    device.closeAllConnections();
    await new Promise<void>((resolve) => device.close(() => resolve()));
  }
});
