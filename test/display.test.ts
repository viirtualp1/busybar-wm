import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { BusyBar } from '@busy-app/busy-lib';
import { Upstream } from '../src/bar/upstream.js';
import type { AppManifest } from '../src/manifest.js';
import { createMockBar, type MockBar } from '../src/mock-bar.js';
import { DISPLAY_PATH } from '../src/protocol/messages.js';
import { DisplayServer } from '../src/protocol/server.js';
import { Tokens } from '../src/protocol/tokens.js';
import { ProxyServer } from '../src/proxy/server.js';
import { Compositor } from '../src/wm/compositor.js';
import { Scene } from '../src/wm/scene.js';

/**
 * The display protocol end to end: apps on the socket, the scene, the
 * compositor, and a Bar that behaves like the real canvas.
 */

const quiet = { info: () => undefined, warn: () => undefined };

function manifest(name: string, rank: number): AppManifest {
  return { name, rank, args: [], env: {}, autostart: false, restart: false };
}

let bar: MockBar;
let scene: Scene;
let tokens: Tokens;
let display: DisplayServer;
let compositor: Compositor;
let proxy: ProxyServer;
const open: WebSocket[] = [];

beforeEach(async () => {
  bar = await createMockBar();
  const upstream = new Upstream({ addr: bar.url, timeoutMs: 2000 });
  scene = new Scene([manifest('np', 50), manifest('dota', 30), manifest('clock', 10)], {
    staleMs: 60_000,
    onChange: () => compositor.wake(),
  });
  tokens = new Tokens();
  display = new DisplayServer({ scene, tokens, frameMs: 50, logger: quiet });
  compositor = new Compositor(scene, upstream, {
    minHoldMs: 0,
    pinTimeoutMs: 0,
    tickMs: 50,
    logger: quiet,
    onShow: (name) => display.show(name),
  });
  proxy = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    upstream,
    scene,
    display,
    logger: quiet,
  });
  await proxy.listen();
  compositor.start();
});

afterEach(async () => {
  for (const ws of open.splice(0)) {
    ws.close();
  }
  await display.close();
  await compositor.stop();
  await proxy.close();
  await bar.close();
});

type Message = { type: string; [key: string]: unknown };

/** An app on the display socket, keeping everything it was told. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}${DISPLAY_PATH}`);
  open.push(ws);
  const messages: Message[] = [];
  let closed: { code: number } | null = null;
  ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as Message);
  ws.onclose = (event) => {
    closed = { code: event.code };
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('could not connect'));
  });

  return {
    messages,
    send: (message: object) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    closed: () => closed,
    of: (type: string) => messages.filter((message) => message.type === type),
    last: (type: string) => messages.filter((message) => message.type === type).at(-1),
  };
}

async function until(what: string, predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const text = (id: string, value: string) => ({
  id,
  type: 'text',
  text: value,
  x: 0,
  y: 0,
  font: 'small',
});

async function hello(app: string, token?: string) {
  const client = await connect();
  client.send({ type: 'hello', protocol: 1, app, ...(token ? { token } : {}) });
  await until(
    'welcome',
    () => client.of('welcome').length > 0 || client.closed() !== null,
  );

  return client;
}

test('a hello is answered with the panels, the frame rate and the budget', async () => {
  const client = await hello('np');

  assert.deepEqual(client.of('welcome')[0], {
    type: 'welcome',
    protocol: 1,
    displays: [
      { id: 'front', width: 72, height: 16 },
      { id: 'back', width: 160, height: 80 },
    ],
    frameMs: 50,
    budget: 100,
  });
});

test('a protocol this side does not speak ends the session, saying so', async () => {
  const client = await connect();
  client.send({ type: 'hello', protocol: 2, app: 'np' });

  await until('closed', () => client.closed() !== null);
  assert.equal(client.last('error')?.['code'], 'protocol');
  assert.equal(client.closed()?.code, 4000);
});

test('anything before hello ends the session', async () => {
  const client = await connect();
  client.send({ type: 'surface.create', surface: 'strip' });

  await until('closed', () => client.closed() !== null);
  assert.equal(client.last('error')?.['code'], 'not_ready');
});

test('an app the supervisor gave a token must show it', async () => {
  const token = tokens.issue('dota');

  const impostor = await hello('dota');
  await until('closed', () => impostor.closed() !== null);
  assert.equal(impostor.last('error')?.['code'], 'auth');
  assert.equal(impostor.closed()?.code, 4001);

  const real = await hello('dota', token);
  assert.equal(real.of('welcome').length, 1);
  assert.equal(real.closed(), null);
});

test('a surface starts hidden, wins the screen with its first frame, and is told', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip', display: 'front' });
  await until('configure', () => client.of('configure').length === 1);
  assert.equal(client.last('configure')?.['visible'], false);
  assert.equal(client.last('configure')?.['width'], 72);

  client.send({
    type: 'surface.commit',
    surface: 'strip',
    ack: 1,
    elements: [{ ...text('title', 'Song'), display: 'back' }],
  });

  await until('shown', () => client.last('configure')?.['visible'] === true);
  await until('a frame asked for', () => client.of('frame').length > 0);
  await until('on the device', () => bar.canvas.has('np/strip:title'));
  assert.equal(
    bar.canvas.get('np/strip:title')?.display,
    'front',
    'a surface is one panel, whatever its elements say',
  );
});

test('frames come no faster than frameMs, and only when answered', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip' });
  client.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', '0')] });
  await until('first frame', () => client.of('frame').length === 1);

  // Answer every frame for a while.
  let answered = 0;
  const started = Date.now();
  while (Date.now() - started < 400) {
    if (client.of('frame').length > answered) {
      answered = client.of('frame').length;
      client.send({
        type: 'surface.commit',
        surface: 'strip',
        elements: [text('t', String(answered))],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const frames = client.of('frame').length;
  assert.ok(frames >= 4 && frames <= 10, `${frames} frames in 400ms at 50ms`);

  // Then stop answering: no more frames come.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = client.of('frame').length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.of('frame').length, after);
});

test('a hidden surface keeps its frame but gets no frames, and is shown again as it was', async () => {
  const np = await hello('np');
  np.send({ type: 'surface.create', surface: 'strip' });
  np.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'np')] });
  await until('np shown', () => np.last('configure')?.['visible'] === true);

  // np asks for less than the legacy app behind the proxy.
  np.send({ type: 'surface.want', surface: 'strip', level: 'idle' });
  const legacy = new BusyBar({ addr: `http://127.0.0.1:${proxy.port}`, timeout: 2000 });
  await legacy.DisplayDraw({
    application_name: 'clock',
    priority: 50,
    elements: [
      {
        id: 'c',
        type: 'text',
        text: '12:00',
        x: 0,
        y: 0,
        display: 'front',
        font: 'small',
        color: '#ffffff',
      },
    ],
  });

  await until('np hidden', () => np.last('configure')?.['visible'] === false);
  await until('clock on the device', () => bar.canvas.has('clock/legacy:c'));
  assert.ok(!bar.canvas.has('np/strip:t'));
  const frames = np.of('frame').length;

  np.send({
    type: 'surface.commit',
    surface: 'strip',
    elements: [text('t', 'np, later')],
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(np.of('frame').length, frames, 'nobody asks a hidden surface to draw');

  np.send({ type: 'surface.want', surface: 'strip', level: 'normal' });
  await until('np back', () => bar.canvas.get('np/strip:t')?.['text'] === 'np, later');
  assert.equal(np.last('configure')?.['visible'], true);
});

test('an empty commit is nothing to show, and the screen goes back', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip' });
  client.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'x')] });
  await until('drawn', () => bar.canvas.has('np/strip:t'));

  client.send({ type: 'surface.commit', surface: 'strip', elements: [] });
  await until('released', () => bar.showing() === null);
});

test('a commit over the budget is refused, and the session goes on', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip' });
  client.send({
    type: 'surface.commit',
    surface: 'strip',
    elements: Array.from({ length: 101 }, (_, index) => text(`e${index}`, '.')),
  });

  await until('error', () => client.of('error').length > 0);
  assert.equal(client.last('error')?.['code'], 'too_many_elements');
  assert.equal(client.last('error')?.['surface'], 'strip');
  assert.equal(client.closed(), null);
  assert.equal(bar.canvas.size, 0);
});

test('the session is the app’s life: when it closes, its surfaces go', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip' });
  client.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'x')] });
  await until('drawn', () => bar.canvas.has('np/strip:t'));

  client.close();
  await until('released', () => bar.showing() === null);
  assert.equal(scene.get('np')?.connected, false);
});

test('a second session under the same name replaces the first', async () => {
  const first = await hello('np');
  first.send({ type: 'surface.create', surface: 'strip' });
  first.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'old')] });
  await until('drawn', () => bar.canvas.has('np/strip:t'));

  const second = await hello('np');
  await until('first closed', () => first.closed() !== null);
  assert.equal(first.last('error')?.['code'], 'replaced');
  assert.equal(first.closed()?.code, 4002);

  second.send({ type: 'surface.create', surface: 'strip' });
  second.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'new')] });
  await until('the new frame', () => bar.canvas.get('np/strip:t')?.['text'] === 'new');
  assert.equal(scene.get('np')?.connected, true);
});

test('a surface the app destroys is gone, and the other keeps going', async () => {
  const client = await hello('np');
  client.send({ type: 'surface.create', surface: 'strip' });
  client.send({ type: 'surface.create', surface: 'cover', display: 'back' });
  client.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'x')] });
  client.send({ type: 'surface.commit', surface: 'cover', elements: [text('art', 'y')] });
  await until('both drawn', () => bar.canvas.size === 2);
  assert.equal(bar.canvas.get('np/cover:art')?.display, 'back');

  client.send({ type: 'surface.destroy', surface: 'cover' });
  await until('cover gone', () => !bar.canvas.has('np/cover:art'));
  assert.ok(bar.canvas.has('np/strip:t'));

  client.send({ type: 'surface.commit', surface: 'cover', elements: [] });
  await until('error', () => client.of('error').length > 0);
  assert.equal(client.last('error')?.['code'], 'unknown_surface');
});

test('the socket path without an upgrade says what it is', async () => {
  const response = await fetch(`http://127.0.0.1:${proxy.port}${DISPLAY_PATH}`);

  assert.equal(response.status, 426);
});

const knob = { kind: 'encoder', delta: 1 } as const;
const start = { kind: 'button', button: 'start', action: 'press' } as const;

test('a key grabbed while focused reaches the app only while it is on screen', async () => {
  const np = await hello('np');
  np.send({ type: 'input.grab', keys: ['start'], when: 'focused' });
  np.send({ type: 'surface.create', surface: 'strip' });
  np.send({ type: 'surface.commit', surface: 'strip', elements: [text('t', 'np')] });
  await until('np shown', () => np.last('configure')?.['visible'] === true);

  assert.equal(display.deliver(start), 'np');
  await until('input', () => np.of('input').length === 1);
  assert.deepEqual(np.last('input'), { type: 'input', event: start });
  assert.equal(display.deliver(knob), null, 'the knob was not asked for');

  np.send({ type: 'surface.want', surface: 'strip', level: 'idle' });
  const clock = await hello('clock');
  clock.send({ type: 'surface.create', surface: 'face' });
  clock.send({ type: 'surface.commit', surface: 'face', elements: [text('c', '12:00')] });
  await until('np hidden', () => np.last('configure')?.['visible'] === false);

  assert.equal(
    display.deliver(start),
    null,
    'clock did not ask for START, np is not on screen',
  );
});

test('a key grabbed always reaches its app whoever is on screen', async () => {
  const np = await hello('np');
  np.send({ type: 'input.grab', keys: ['encoder'], when: 'always' });
  const dota = await hello('dota');
  dota.send({ type: 'input.grab', keys: ['encoder', 'start'], when: 'focused' });
  dota.send({ type: 'surface.create', surface: 'main' });
  dota.send({ type: 'surface.commit', surface: 'main', elements: [text('s', '1:0')] });
  await until('dota shown', () => dota.last('configure')?.['visible'] === true);

  assert.equal(display.deliver(knob), 'np', 'the volume, whatever is showing');
  assert.equal(display.deliver(start), 'dota');
  await until('np got the knob', () => np.of('input').length === 1);
  assert.equal(dota.of('input').length, 1);
});

test('one app per always-grabbed key, freed when it lets go or leaves', async () => {
  const np = await hello('np');
  np.send({ type: 'input.grab', keys: ['encoder'], when: 'always' });
  const dota = await hello('dota');
  await new Promise((resolve) => setTimeout(resolve, 30));

  dota.send({ type: 'input.grab', keys: ['start', 'encoder'], when: 'always' });
  await until('refused', () => dota.of('error').length === 1);
  assert.equal(dota.last('error')?.['code'], 'grab_taken');
  assert.match(String(dota.last('error')?.['message']), /held by np/);
  assert.equal(display.deliver(start), null, 'all of the keys or none of them');

  np.close();
  await until('np gone', () => scene.get('np')?.connected === false);
  dota.send({ type: 'input.grab', keys: ['encoder'], when: 'always' });
  await until('dota holds it', () => display.deliver(knob) === 'dota');

  dota.send({ type: 'input.release', keys: ['encoder'] });
  await until('released', () => display.deliver(knob) === null);
});

test('BACK cannot be asked for', async () => {
  const np = await hello('np');
  np.send({ type: 'input.grab', keys: ['back'], when: 'always' });

  await until('refused', () => np.of('error').length === 1);
  assert.equal(np.last('error')?.['code'], 'reserved_key');
  assert.equal(np.closed(), null);
});
