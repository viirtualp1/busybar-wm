import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BusyBar } from '@busy-app/busy-lib';
import { createMockBar, type MockBar } from '../src/mock-bar.js';
import { ProxyServer } from '../src/proxy/server.js';
import { Upstream } from '../src/bar/upstream.js';
import { Compositor } from '../src/wm/compositor.js';
import { Registry } from '../src/wm/registry.js';
import type { AppManifest } from '../src/manifest.js';

/**
 * The end to end that matters: two unmodified apps, talking to what they think
 * is a Bar, and exactly one of them on the screen at a time.
 */

const quiet = { info: () => undefined, warn: () => undefined };

function manifest(name: string, rank: number): AppManifest {
  return { name, rank, args: [], env: {}, autostart: false, restart: false };
}

let bar: MockBar;
let proxy: ProxyServer;
let registry: Registry;
let compositor: Compositor;
let low: BusyBar;
let high: BusyBar;

before(async () => {
  bar = await createMockBar();
  const upstream = new Upstream({ addr: bar.url, timeoutMs: 2000 });

  registry = new Registry([manifest('low', 10), manifest('high', 50)], {
    staleMs: 60_000,
    onChange: () => compositor.wake(),
  });
  compositor = new Compositor(registry, upstream, {
    minHoldMs: 0,
    pinTimeoutMs: 0,
    tickMs: 50,
    logger: quiet,
  });
  proxy = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    upstream,
    registry,
    logger: quiet,
  });

  await proxy.listen();
  // Both apps are supervised as far as the registry is concerned; here the
  // test plays the supervisor.
  registry.setRunning('low', true);
  registry.setRunning('high', true);
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

  await until('low on screen', () => bar.showing() === 'low');
  assert.equal(bar.draws.at(-1)?.application_name, 'low');
  assert.deepEqual((bar.draws.at(-1)?.elements as { text: string }[])[0]?.text, 'hello');
});

test('a higher-ranked app takes the screen, and the old one is cleared first', async () => {
  await draw(high, 'high', 'urgent');

  await until('high on screen', () => bar.showing() === 'high');
  const cleared = bar.clears.at(-1);
  const drawn = bar.draws.at(-1);
  assert.equal(cleared?.application_name, 'low', 'elements persist by id, so it must go');
  assert.ok(
    (cleared?.at ?? 0) <= (drawn?.at ?? 0),
    'and it must go before the new frame lands',
  );
});

test('the app that lost the screen keeps drawing, and nothing reaches the device', async () => {
  const before = bar.draws.length;
  await draw(low, 'low', 'still here');
  await draw(low, 'low', 'and here');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bar.draws.length, before, 'the device saw none of it');
  assert.equal(bar.showing(), 'high');
});

test('when the winner yields, the loser is replayed without being asked again', async () => {
  await high.DisplayClear({ application_name: 'high' });

  await until('low back on screen', () => bar.showing() === 'low');
  // The frame it drew while off screen — the app was never told to redraw.
  assert.equal((bar.draws.at(-1)?.elements as { text: string }[])[0]?.text, 'and here');
});

test('anything that is not a draw goes straight to the device', async () => {
  await low.AssetsUpload({
    application_name: 'low',
    file: 'cover.png',
    data: Buffer.from('not really a png'),
  });

  assert.deepEqual(bar.assets.at(-1), {
    application_name: 'low',
    file: 'cover.png',
    size: 16,
  });
});

test('a Bar busy with its own session is waited out, not crashed on', async () => {
  bar.lowPriority = true;
  await draw(low, 'low', 'rejected');
  await new Promise((resolve) => setTimeout(resolve, 200));

  bar.lowPriority = false;
  await until('the frame arrives once the Bar is free', () => {
    const last = bar.draws.at(-1);

    return (last?.elements as { text: string }[])[0]?.text === 'rejected';
  });
});

test('every app is told its draw landed, so none of them back off', async () => {
  // The apps never learn they are off screen; that is what keeps them
  // unmodified and their last frame replayable.
  const response = await draw(high, 'high', 'off screen');

  assert.ok(response !== undefined);
});
