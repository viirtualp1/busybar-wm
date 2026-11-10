import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createMockBar } from '../src/mock-bar.js';
import { DISPLAY_PATH } from '../src/protocol/messages.js';
import { CONTROL_PATH } from '../src/wm/control.js';
import { Daemon } from '../src/wm/daemon.js';
import type { WmEvent } from '../src/wm/events.js';
import { EVENTS_PATH } from '../src/wm/inspector.js';

type Message = { type: string; surface?: string; visible?: boolean };

async function waitFor(check: () => boolean, what = 'expected state') {
  const end = Date.now() + 3000;

  while (!check() && Date.now() < end) {
    await delay(15);
  }

  assert.ok(check(), `${what} was not reached`);
}

async function startDaemon(t: TestContext, env: Record<string, string>) {
  const bar = await createMockBar();
  // A profile of its own: without one the supervisor keeps its note of
  // children in the working directory, and sweeps other tests' processes.
  const profile = await mkdtemp(join(tmpdir(), 'busybar-wm-inspector-'));
  const { config } = loadConfig(
    {
      BUSY_ADDR: bar.url,
      WM_INPUT: '0',
      WM_TICK_MS: '50',
      WM_MIN_HOLD_MS: '0',
      ...env,
    },
    undefined,
    profile,
  );
  let addr = '';
  const daemon = new Daemon({
    config: { ...config, port: 0 },
    manifest: {
      apps: [
        { name: 'dota', rank: 2, args: [], env: {}, autostart: false, restart: false },
        {
          name: 'nowplaying',
          rank: 1,
          args: [],
          env: {},
          autostart: false,
          restart: false,
        },
      ],
    },
    logger: {
      info(message) {
        if (message.includes('proxying')) {
          addr = message.split(' on ')[1] ?? '';
        }
      },
      warn() {},
    },
  });

  t.after(async () => {
    await daemon.stop();
    await bar.close();
    await rm(profile, { recursive: true, force: true });
  });

  await daemon.start();
  assert.ok(addr);

  return { bar, addr };
}

/** Every event the stream sends, as it sends it. */
async function listen(t: TestContext, addr: string) {
  const events: WmEvent[] = [];
  const abort = new AbortController();
  const response = await fetch(addr + EVENTS_PATH, { signal: abort.signal });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  t.after(() => abort.abort());

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function read() {
    try {
      for (;;) {
        const chunk = await reader?.read();

        if (!chunk || chunk.done) {
          return;
        }

        buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });

        const blocks = buffer.split('\n\n');

        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const data = block
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length);

          if (data) {
            events.push(JSON.parse(data) as WmEvent);
          }
        }
      }
    } catch {
      // Aborted when the test ends.
    }
  }

  void read();

  return events;
}

async function socketApp(t: TestContext, addr: string, app: string) {
  const socket = new WebSocket(addr.replace(/^http/, 'ws') + DISPLAY_PATH);
  const messages: Message[] = [];

  t.after(() => socket.close());
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as Message),
  );
  await once(socket, 'open');

  const send = (message: object) => socket.send(JSON.stringify(message));

  send({ type: 'hello', protocol: 1, app });
  await waitFor(() => messages.some(({ type }) => type === 'welcome'), 'welcome');
  send({ type: 'surface.create', surface: 'strip', display: 'front' });
  await waitFor(() => messages.some(({ type }) => type === 'configure'), 'configure');

  return { messages, send };
}

function legacyDraw(addr: string, app: string, priority: number, text: string) {
  return fetch(`${addr}/api/display/draw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      application_name: app,
      priority,
      elements: [{ id: 'score', type: 'text', text, x: 0, y: 0, display: 'front' }],
    }),
  });
}

function control(addr: string, command: object, headers: Record<string, string> = {}) {
  return fetch(addr + CONTROL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(command),
  });
}

function lastConfigure(messages: Message[]) {
  return messages.filter(({ type }) => type === 'configure').at(-1);
}

test('tap mode lets the apps fight; switching to manage settles it live', async (t) => {
  const { bar, addr } = await startDaemon(t, { WM_MODE: 'tap' });
  const events = await listen(t, addr);

  await waitFor(
    () => events.some((e) => e.type === 'mode' && e.mode === 'tap'),
    'tap mode',
  );

  // An app behind the proxy draws to the Bar under its own name.
  assert.equal((await legacyDraw(addr, 'dota', 50, '1:0')).status, 200);
  assert.equal(bar.showing(), 'dota');
  assert.ok(bar.canvas.has('score'));

  // An app on the socket is shown, as it would be with no window manager...
  const nowplaying = await socketApp(t, addr, 'nowplaying');

  assert.equal(lastConfigure(nowplaying.messages)?.visible, true);

  // ...and its frame meets the device's own rule: same priority, refused.
  const commit = (text: string) =>
    nowplaying.send({
      type: 'surface.commit',
      surface: 'strip',
      elements: [{ id: 'title', type: 'text', text, x: 0, y: 8, display: 'front' }],
    });

  commit('song');
  await waitFor(
    () =>
      events.some((e) => e.type === 'response' && e.status === 409) &&
      events.some(
        (e) => e.type === 'request' && e.app === 'nowplaying' && e.to === 'bar',
      ),
    'a 409 for nowplaying',
  );
  assert.equal(bar.showing(), 'dota');

  // Once dota lets go, nowplaying's next frame lands under its own name.
  const cleared = await fetch(`${addr}/api/display/draw?application_name=dota`, {
    method: 'DELETE',
  });

  assert.equal(cleared.status, 200);
  commit('song ');
  await waitFor(() => bar.showing() === 'nowplaying', 'nowplaying on the Bar');
  assert.ok(bar.canvas.has('strip:title'));

  // A louder draw takes the canvas, and the answer says what it cost.
  assert.equal((await legacyDraw(addr, 'dota', 60, '2:0')).status, 200);
  await waitFor(
    () =>
      events.some(
        (e) => e.type === 'response' && e.note === "nowplaying's elements wiped",
      ),
    'the wipe noted',
  );

  // Now decide. The apps keep their address and do not restart.
  const switched = await control(addr, { action: 'mode', mode: 'manage' });

  assert.equal(switched.status, 200);
  await waitFor(() => bar.showing() === 'busybar-wm', 'the Bar owned by the wm');
  // The scene was kept while listening: dota's last frame is up at once.
  await waitFor(() => bar.canvas.has('dota/legacy:score'), "dota's frame from the scene");
  await waitFor(
    () => lastConfigure(nowplaying.messages)?.visible === false,
    'nowplaying hidden',
  );

  const decision = events.findLast((e) => e.type === 'decision');

  assert.equal(decision?.type === 'decision' && decision.winner, 'dota');
  assert.ok(
    events.some((e) => e.type === 'diff' && e.cause === 'switch' && e.to === 'dota'),
  );

  // Draws now stop at the wm.
  assert.equal((await legacyDraw(addr, 'dota', 60, '3:0')).status, 200);
  await waitFor(
    () => events.some((e) => e.type === 'request' && e.app === 'dota' && e.to === 'wm'),
    'a draw answered by the wm',
  );

  // And back to listening: the wm's elements go, nowplaying is shown again.
  assert.equal((await control(addr, { action: 'mode', mode: 'tap' })).status, 200);
  await waitFor(() => !bar.canvas.has('dota/legacy:score'), 'the wm canvas cleared');
  await waitFor(
    () => lastConfigure(nowplaying.messages)?.visible === true,
    'nowplaying shown again',
  );
});

test('a page may switch modes and listen only from its own origin', async (t) => {
  const { addr } = await startDaemon(t, {});
  const own = new URL(addr).origin;

  assert.equal(
    (await control(addr, { action: 'mode', mode: 'tap' }, { origin: 'http://evil.test' }))
      .status,
    401,
  );
  assert.equal(
    (await control(addr, { action: 'mode', mode: 'tap' }, { origin: own })).status,
    200,
  );
  assert.equal((await control(addr, { action: 'mode', mode: 'loud' })).status, 400);

  const state = (await (await fetch(addr + CONTROL_PATH)).json()) as { mode: string };

  assert.equal(state.mode, 'tap');

  // A page opened after an app connected still sees how its session began.
  const nowplaying = await socketApp(t, addr, 'nowplaying');

  nowplaying.send({ type: 'input.grab', keys: ['encoder'], when: 'always' });
  await delay(50);

  const late = await listen(t, addr);

  await waitFor(
    () =>
      ['hello', 'welcome', 'surface.create', 'input.grab', 'configure'].every((message) =>
        late.some((e) => e.type === 'protocol' && e.message === message),
      ),
    'the handshake replayed',
  );

  const foreign = await fetch(addr + EVENTS_PATH, {
    headers: { origin: 'http://evil.test' },
  });

  assert.equal(foreign.status, 403);
});

test('the inspector page is served from its build, and nothing outside it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'busybar-inspector-'));
  const dist = join(root, 'dist');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<p>inspector</p>');
  await writeFile(join(dist, 'assets', 'app.js'), 'export {};');
  await writeFile(join(root, 'secret.txt'), 'no');

  const { addr } = await startDaemon(t, { WM_INSPECTOR_DIR: dist });
  const bare = await fetch(`${addr}/inspector`, { redirect: 'manual' });

  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), '/inspector/?source=live');

  const page = await fetch(`${addr}/inspector/?source=live`);

  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<p>inspector</p>');

  const script = await fetch(`${addr}/inspector/assets/app.js`);

  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal((await fetch(`${addr}/inspector/%2e%2e/secret.txt`)).status, 404);
  assert.equal((await fetch(`${addr}/inspector/..%2fsecret.txt`)).status, 404);
});
