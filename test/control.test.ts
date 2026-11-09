import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createMockBar } from '../src/mock-bar.js';
import { DISPLAY_PATH } from '../src/protocol/messages.js';
import { CONTROL_PATH } from '../src/wm/control.js';
import { Daemon } from '../src/wm/daemon.js';

type Message = { type: string; event?: object };

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) {
    await delay(15);
  }

  assert.ok(check(), 'expected WM state was not reached');
}

test('control routes app input and timed overlays through the live WM', async (t) => {
  const bar = await createMockBar();
  const profile = await mkdtemp(join(tmpdir(), 'busybar-wm-test-'));
  const oldToken = process.env['WM_API_TOKEN'];
  process.env['WM_API_TOKEN'] = 'test-token';
  const { config } = loadConfig(
    {
      BUSY_ADDR: bar.url,
      WM_INPUT: '0',
      WM_TICK_MS: '50',
    },
    undefined,
    profile,
  );
  let addr = '';
  const daemon = new Daemon({
    config: { ...config, port: 0 },
    manifest: {
      apps: ['clock', 'weather'].map((name, rank) => ({
        name,
        rank,
        args: [],
        env: {},
        autostart: false,
        restart: false,
      })),
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
    if (oldToken === undefined) {
      delete process.env['WM_API_TOKEN'];
    } else {
      process.env['WM_API_TOKEN'] = oldToken;
    }

    await daemon.stop();
    await bar.close();
    await rm(profile, { recursive: true, force: true });
  });

  await daemon.start();
  assert.ok(addr);
  assert.equal((await fetch(addr + CONTROL_PATH)).status, 401);

  const request = (command?: object) =>
    fetch(addr + CONTROL_PATH, {
      method: command ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });

  const snapshot = async () =>
    (await (await request()).json()) as {
      activeApp: string | null;
      pinnedApp: string | null;
      apps: { name: string; ready: boolean }[];
    };

  assert.equal((await request({ action: 'switch', app: 'unknown' })).status, 404);
  assert.equal((await request({ action: 'switch', app: 'weather' })).status, 409);
  assert.equal((await request({ action: 'message', durationSeconds: -1 })).status, 400);

  const socket = new WebSocket(addr.replace(/^http/, 'ws') + DISPLAY_PATH);
  t.after(() => socket.close());
  const messages: Message[] = [];
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as Message),
  );
  await once(socket, 'open');
  const send = (message: object) => socket.send(JSON.stringify(message));

  send({ type: 'hello', protocol: 1, app: 'clock' });
  await waitFor(() => messages.some(({ type }) => type === 'welcome'));
  send({ type: 'surface.create', surface: 'strip', display: 'front' });
  await waitFor(() => messages.some(({ type }) => type === 'configure'));
  send({
    type: 'surface.commit',
    surface: 'strip',
    ack: 1,
    elements: [{ id: 'time', type: 'text', text: 'Clock' }],
  });
  send({ type: 'input.grab', keys: ['ok'], when: 'focused' });
  await waitFor(() => bar.canvas.has('clock/strip:time'));

  assert.equal((await request({ action: 'switch', app: 'clock' })).status, 200);
  const state = await snapshot();
  assert.equal(state.activeApp, 'clock');
  assert.equal(state.pinnedApp, 'clock');
  assert.deepEqual(
    state.apps.map(({ name, ready }) => [name, ready]),
    [
      ['clock', true],
      ['weather', false],
    ],
  );

  const message = await request({
    action: 'message',
    text: 'Build done',
    durationSeconds: 1,
    display: 'front',
  });
  assert.equal(message.status, 202);
  await waitFor(() => bar.canvas.get('wm-overlay-front-text')?.['text'] === 'Build done');
  assert.ok(bar.canvas.has('clock/strip:time'));

  const input = await request({ action: 'input', key: 'ok' });
  assert.deepEqual(await input.json(), { deliveredTo: 'clock' });
  await waitFor(() => messages.filter(({ type }) => type === 'input').length === 2);
  assert.deepEqual(
    messages.filter(({ type }) => type === 'input').map(({ event }) => event),
    [
      { kind: 'button', button: 'ok', action: 'press' },
      { kind: 'button', button: 'ok', action: 'release' },
    ],
  );
  assert.equal((await request({ action: 'input', key: 'start' })).status, 409);

  await waitFor(() => !bar.canvas.has('wm-overlay-front-text'));
  assert.equal(bar.canvas.get('clock/strip:time')?.['text'], 'Clock');
  assert.equal((await snapshot()).pinnedApp, 'clock');
  assert.equal((await request({ action: 'auto' })).status, 200);
  assert.equal((await snapshot()).pinnedApp, null);

  assert.equal(
    (await request({ action: 'timer', display: 'front', text: '', durationSeconds: 3 }))
      .status,
    202,
  );
  await waitFor(() => bar.canvas.get('wm-overlay-front-text')?.['text'] === '0:02');
  assert.equal((await request({ action: 'clear', display: 'front' })).status, 200);
  await waitFor(() => !bar.canvas.has('wm-overlay-front-text'));
  assert.ok(bar.canvas.has('clock/strip:time'));
});
