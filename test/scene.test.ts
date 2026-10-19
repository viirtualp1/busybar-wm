import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppManifest } from '../src/manifest.js';
import { LEGACY_SURFACE, legacyClear, legacyDraw } from '../src/proxy/legacy.js';
import { Scene, UNMANAGED_RANK, type Frame } from '../src/wm/scene.js';

function manifest(name: string, over: Partial<AppManifest> = {}): AppManifest {
  return {
    name,
    rank: 10,
    command: 'npm',
    args: ['start'],
    env: {},
    autostart: true,
    restart: true,
    ...over,
  };
}

function frame(ids: string[], priority = 50): Frame {
  return { elements: ids.map((id) => ({ id })), priority };
}

function elements(scene: Scene, name: string, surface = LEGACY_SURFACE) {
  return scene
    .get(name)
    ?.surfaces.get(surface)
    ?.frame?.elements.map((e) => e.id);
}

test('drawing is the request for the screen, and a DELETE is the release', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  scene.setRunning('dota', true);

  assert.deepEqual(scene.candidates(), [], 'nothing drawn yet');

  legacyDraw(scene, { application_name: 'dota', elements: [{ id: 'clock' }] }, 100);
  assert.deepEqual(
    scene.candidates(100).map((client) => client.name),
    ['dota'],
  );

  legacyClear(scene, 'dota', undefined, 200);
  assert.deepEqual(scene.candidates(200), []);
});

test('an app taken out is gone, and a new rank is a change once', () => {
  let changes = 0;
  const scene = new Scene([manifest('dota'), manifest('mydota', { rank: 50 })], {
    staleMs: 1000,
    onChange: () => {
      changes += 1;
    },
  });

  scene.setRank('dota', 90);
  scene.setRank('dota', 90);
  assert.equal(scene.get('dota')?.rank, 90);
  assert.equal(changes, 1, 'the same rank again is not a change');

  scene.remove('mydota');
  assert.equal(scene.get('mydota'), undefined);
  assert.equal(changes, 2);
});

test('an app added later joins with its rank, and a stranger keeps its frame', () => {
  const scene = new Scene([], { staleMs: 60_000 });
  legacyDraw(scene, { application_name: 'late', elements: [{ id: 'x' }] }, 100);
  assert.equal(scene.get('late')?.rank, UNMANAGED_RANK);

  scene.add(manifest('late', { rank: 70 }));

  assert.equal(scene.get('late')?.rank, 70);
  assert.equal(scene.get('late')?.managed, true);
  assert.deepEqual(elements(scene, 'late'), ['x']);

  scene.add(manifest('fresh', { rank: 30 }));
  assert.equal(scene.get('fresh')?.running, false);
});

test('a legacy draw is an upsert by id, the way the device takes it', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  legacyDraw(scene, { application_name: 'dota', elements: [{ id: 'a' }, { id: 'b' }] });
  legacyDraw(scene, { application_name: 'dota', elements: [{ id: 'b', text: 'new' }] });

  assert.deepEqual(
    elements(scene, 'dota'),
    ['a', 'b'],
    'a stayed, as it would on the Bar',
  );
  assert.deepEqual(scene.get('dota')?.surfaces.get(LEGACY_SURFACE)?.frame?.elements[1], {
    id: 'b',
    text: 'new',
  });
});

test('a DELETE naming element ids takes only those', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  scene.setRunning('dota', true);
  legacyDraw(scene, { application_name: 'dota', elements: [{ id: 'a' }, { id: 'b' }] });

  legacyClear(scene, 'dota', ['a']);
  assert.deepEqual(elements(scene, 'dota'), ['b']);

  legacyClear(scene, 'dota', ['b']);
  assert.deepEqual(scene.candidates(), [], 'nothing left is nothing to show');
});

test('elements without an id are not something the device would take', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  legacyDraw(scene, {
    application_name: 'dota',
    elements: [{ id: 'a' }, { text: 'no id' }, 7],
  });

  assert.deepEqual(elements(scene, 'dota'), ['a']);
});

test('an identical frame is proof of life but not a reason to redraw', () => {
  let changes = 0;
  const scene = new Scene([manifest('dota')], {
    staleMs: 1000,
    onChange: () => {
      changes += 1;
    },
  });

  scene.commit('dota', 'main', frame(['a']), 100);
  scene.commit('dota', 'main', frame(['a']), 200);

  assert.equal(changes, 1);
  assert.equal(scene.get('dota')?.lastDrawAt, 200, 'but the liveness is recorded');
});

test('surfaces are separate frames of one app, shown in a stable order', () => {
  const scene = new Scene([manifest('nowplaying')], { staleMs: 1000 });
  scene.commit('nowplaying', 'strip', frame(['time']));
  scene.commit('nowplaying', 'cover', frame(['art']));

  assert.deepEqual(
    scene.visible('nowplaying').map((surface) => surface.name),
    ['cover', 'strip'],
  );

  scene.release('nowplaying', 'cover');
  assert.deepEqual(
    scene.visible('nowplaying').map((surface) => surface.name),
    ['strip'],
  );
});

test('an app’s priority is the highest across the frames it is showing', () => {
  const scene = new Scene([manifest('nowplaying')], { staleMs: 1000 });
  scene.commit('nowplaying', 'strip', frame(['time'], 40));
  scene.commit('nowplaying', 'cover', frame(['art'], 80));
  assert.equal(scene.get('nowplaying')?.priority, 80);

  scene.release('nowplaying', 'cover');
  assert.equal(scene.get('nowplaying')?.priority, 40);
});

test('a supervised app is judged by its process, not by its silence', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  scene.setRunning('dota', true);
  scene.commit('dota', 'main', frame(['a']), 0);

  // An hour later, with no redraw: apps only redraw when something changed.
  assert.equal(scene.candidates(3_600_000).length, 1);

  scene.setRunning('dota', false);
  assert.equal(scene.candidates(3_600_000).length, 0, 'a dead process shows nothing');
});

test('an app started by hand is judged by the clock, since nothing watches it', () => {
  // No command: nothing supervises it, so nothing knows whether it is alive.
  const manual: AppManifest = {
    name: 'manual',
    rank: 10,
    args: [],
    env: {},
    autostart: false,
    restart: false,
  };
  const scene = new Scene([manual], { staleMs: 1000 });
  scene.commit('manual', 'main', frame(['a']), 0);

  assert.equal(scene.candidates(500).length, 1);
  assert.equal(scene.candidates(1500).length, 0, 'and goes stale');
});

test('an app nobody wrote a manifest for still gets to draw, at rank zero', () => {
  const scene = new Scene([], { staleMs: 1000 });
  scene.commit('stranger', 'main', frame(['a']), 0);

  const [client] = scene.candidates(0);
  assert.equal(client?.name, 'stranger');
  assert.equal(client?.rank, UNMANAGED_RANK);
  assert.equal(client?.managed, false);
});

test('the draw priority an app sent is what the arbiter later reads', () => {
  const scene = new Scene([manifest('dota')], { staleMs: 1000 });
  scene.setRunning('dota', true);
  legacyDraw(
    scene,
    { application_name: 'dota', priority: 80, elements: [{ id: 'a' }] },
    0,
  );

  assert.equal(scene.get('dota')?.priority, 80);
});

test('an app wants the screen as much as its most eager surface with a frame', () => {
  const scene = new Scene([manifest('np')], { staleMs: 1000 });
  scene.commit('np', 'strip', frame(['t']));
  scene.commit('np', 'cover', frame(['a']));
  scene.setWant('np', 'strip', 'idle');
  scene.setWant('np', 'cover', 'idle');
  assert.equal(scene.get('np')?.want, 'idle');

  scene.setWant('np', 'cover', 'urgent');
  assert.equal(scene.get('np')?.want, 'urgent');

  scene.release('np', 'cover');
  assert.equal(
    scene.get('np')?.want,
    'idle',
    'a surface with nothing on it asks for nothing',
  );
});

test('an open session is proof of life, and closing it takes what it drew', () => {
  const scene = new Scene([], { staleMs: 1000 });
  scene.connect('np');
  scene.commit('np', 'strip', frame(['t']), 0);
  legacyDraw(scene, { application_name: 'np', elements: [{ id: 'old' }] }, 0);

  assert.equal(scene.candidates(3_600_000).length, 1, 'no staleness while connected');

  scene.disconnect('np', ['strip']);
  assert.equal(scene.get('np')?.surfaces.has('strip'), false);
  assert.deepEqual(
    elements(scene, 'np'),
    ['old'],
    'the proxy’s surface is not the socket’s',
  );
});
