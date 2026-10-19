import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Upstream } from '../src/bar/upstream.js';
import { createMockBar, type MockBar } from '../src/mock-bar.js';
import { OWNER } from '../src/wm/canvas.js';
import { Compositor } from '../src/wm/compositor.js';
import { Scene, type Element } from '../src/wm/scene.js';

/**
 * The compositor against a Bar that behaves like the real canvas: one owner,
 * upserts by id, deletes that fail whole on one unknown id.
 */

const quiet = { info: () => undefined, warn: () => undefined };

let bar: MockBar;
let scene: Scene;
let compositor: Compositor;

beforeEach(async () => {
  bar = await createMockBar();
  scene = new Scene([], { staleMs: 60_000, onChange: () => compositor.wake() });
  compositor = new Compositor(scene, new Upstream({ addr: bar.url, timeoutMs: 2000 }), {
    minHoldMs: 0,
    pinTimeoutMs: 0,
    tickMs: 50,
    logger: quiet,
  });
  compositor.start();
});

afterEach(async () => {
  await compositor.stop();
  await bar.close();
});

const text = (id: string, value: string, extra: Partial<Element> = {}): Element => ({
  id,
  type: 'text',
  text: value,
  ...extra,
});

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('a frame that did not change is not sent again', async () => {
  scene.commit('dota', 'main', { elements: [text('a', '1')], priority: 50 });
  await until('drawn', () => bar.canvas.has('dota/main:a'));
  const draws = bar.draws.length;

  await settle();
  compositor.wake();
  await settle();

  assert.equal(bar.draws.length, draws);
});

test('only the element that changed is drawn', async () => {
  scene.commit('dota', 'main', {
    elements: [text('a', '1'), text('b', '2')],
    priority: 50,
  });
  await until('drawn', () => bar.canvas.size === 2);

  scene.commit('dota', 'main', {
    elements: [text('a', '1'), text('b', '3')],
    priority: 50,
  });
  await until('b updated', () => bar.canvas.get('dota/main:b')?.['text'] === '3');

  assert.deepEqual(
    (bar.draws.at(-1)?.elements as Element[]).map((element) => element.id),
    ['dota/main:b'],
  );
});

test('an app that lowers its priority is still drawn', async () => {
  scene.commit('dota', 'main', { elements: [text('a', 'loud')], priority: 80 });
  await until('drawn', () => bar.canvas.get('dota/main:a')?.['text'] === 'loud');

  // The device refuses its owner a lower priority than the last draw, so the
  // canvas has to be emptied first.
  scene.commit('dota', 'main', { elements: [text('a', 'calm')], priority: 40 });
  await until('redrawn', () => bar.canvas.get('dota/main:a')?.['text'] === 'calm');
  assert.equal(bar.clears.at(-1)?.application_name, OWNER);
});

test('a canvas that is not what it was believed to be is started over', async () => {
  scene.commit('dota', 'main', {
    elements: [text('a', '1'), text('b', '2')],
    priority: 50,
  });
  await until('drawn', () => bar.canvas.size === 2);

  // Something removed b behind the compositor's back — an element timeout on
  // the device, say. Deleting it by id now fails the whole request.
  bar.canvas.delete('dota/main:b');
  scene.commit('dota', 'main', { elements: [text('a', '1')], priority: 50 });

  await until('the canvas back in step', () => {
    const last = bar.clears.at(-1);

    return last?.element_ids === undefined && last?.application_name === OWNER;
  });
  await until('a redrawn', () => bar.canvas.has('dota/main:a'));
  assert.deepEqual([...bar.canvas.keys()], ['dota/main:a']);
});

test('the LED goes out once per frame that asks for it', async () => {
  scene.commit('np', 'main', {
    elements: [text('t', '0:01')],
    priority: 50,
    led: '#00ff00',
  });
  await until('drawn', () => bar.draws.length > 0);
  await settle();

  const withLed = () => bar.draws.filter((draw) => draw.led_notification_color).length;
  assert.equal(withLed(), 1);

  compositor.wake();
  await settle();
  assert.equal(withLed(), 1, 'not again for the same frame');
});

test('nobody drawing hands the canvas back', async () => {
  scene.commit('dota', 'main', { elements: [text('a', '1')], priority: 50 });
  await until('drawn', () => bar.showing() === OWNER);

  scene.release('dota', 'main');
  await until('released', () => bar.showing() === null);
});
