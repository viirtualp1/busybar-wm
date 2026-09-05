import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppManifest } from '../src/manifest.js';
import { Registry, UNMANAGED_RANK } from '../src/wm/registry.js';

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

test('drawing is the request for the screen, and a DELETE is the release', () => {
  const registry = new Registry([manifest('dota')], { staleMs: 1000 });
  registry.setRunning('dota', true);

  assert.deepEqual(registry.candidates(), [], 'nothing drawn yet');

  registry.draw({ application_name: 'dota', elements: [] }, 100);
  assert.deepEqual(
    registry.candidates(100).map((app) => app.name),
    ['dota'],
  );

  registry.clear('dota', 200);
  assert.deepEqual(registry.candidates(200), []);
});

test('the last frame is kept, because an app off screen will not resend it', () => {
  const registry = new Registry([manifest('dota')], { staleMs: 1000 });
  registry.setRunning('dota', true);
  registry.draw({ application_name: 'dota', elements: [{ id: 'clock' }] }, 100);

  assert.deepEqual(registry.get('dota')?.frame?.elements, [{ id: 'clock' }]);
});

test('an identical frame is proof of life but not a reason to redraw', () => {
  let changes = 0;
  const registry = new Registry([manifest('dota')], {
    staleMs: 1000,
    onChange: () => {
      changes += 1;
    },
  });

  registry.draw({ application_name: 'dota', elements: [] }, 100);
  registry.draw({ application_name: 'dota', elements: [] }, 200);

  assert.equal(changes, 1);
  assert.equal(registry.get('dota')?.lastDrawAt, 200, 'but the liveness is recorded');
});

test('a supervised app is judged by its process, not by its silence', () => {
  const registry = new Registry([manifest('dota')], { staleMs: 1000 });
  registry.setRunning('dota', true);
  registry.draw({ application_name: 'dota', elements: [] }, 0);

  // An hour later, with no redraw: apps only redraw when something changed.
  assert.equal(registry.candidates(3_600_000).length, 1);

  registry.setRunning('dota', false);
  assert.equal(registry.candidates(3_600_000).length, 0, 'a dead process shows nothing');
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
  const registry = new Registry([manual], { staleMs: 1000 });
  registry.draw({ application_name: 'manual', elements: [] }, 0);

  assert.equal(registry.candidates(500).length, 1);
  assert.equal(registry.candidates(1500).length, 0, 'and goes stale');
});

test('an app nobody wrote a manifest for still gets to draw, at rank zero', () => {
  const registry = new Registry([], { staleMs: 1000 });
  registry.draw({ application_name: 'stranger', elements: [] }, 0);

  const [app] = registry.candidates(0);
  assert.equal(app?.name, 'stranger');
  assert.equal(app?.rank, UNMANAGED_RANK);
  assert.equal(app?.managed, false);
});

test('the draw priority an app sent is what the arbiter later reads', () => {
  const registry = new Registry([manifest('dota')], { staleMs: 1000 });
  registry.setRunning('dota', true);
  registry.draw({ application_name: 'dota', priority: 80, elements: [] }, 0);

  assert.equal(registry.get('dota')?.priority, 80);
});
