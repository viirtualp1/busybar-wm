import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InputEvent } from '../src/bar/input.js';
import { Gestures, type Gesture } from '../src/wm/gestures.js';

function record(knob = false) {
  const seen: Gesture[] = [];
  const gestures = new Gestures({ holdMs: 60, knob, onGesture: (g) => seen.push(g) });

  return { seen, gestures };
}

const ok = (action: 'press' | 'release'): InputEvent => ({
  kind: 'button',
  button: 'ok',
  action,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a short OK is the app’s, delivered whole when it is let go', async () => {
  const { seen, gestures } = record();
  gestures.handle(ok('press'));
  assert.deepEqual(seen, [], 'nothing yet: it could still become a hold');

  await sleep(10);
  gestures.handle(ok('release'));
  assert.deepEqual(seen, [
    { kind: 'app', event: ok('press') },
    { kind: 'app', event: ok('release') },
  ]);
});

test('holding OK is the next app, and its release goes nowhere', async () => {
  const { seen, gestures } = record();
  gestures.handle(ok('press'));
  await sleep(90);
  assert.deepEqual(seen, [{ kind: 'next' }], 'switched while still held');

  gestures.handle(ok('release'));
  assert.deepEqual(seen, [{ kind: 'next' }]);
});

test('BACK is the window manager’s on both edges', () => {
  const { seen, gestures } = record();
  gestures.handle({ kind: 'button', button: 'back', action: 'press' });
  gestures.handle({ kind: 'button', button: 'back', action: 'release' });

  assert.deepEqual(seen, [{ kind: 'automatic' }, { kind: 'dropped' }]);
});

test('the switch closes the canvas; START goes straight to the app', () => {
  const { seen, gestures } = record();
  gestures.handle({ kind: 'switch', position: 'busy' });
  gestures.handle({ kind: 'button', button: 'start', action: 'press' });

  assert.deepEqual(seen, [
    { kind: 'dropped' },
    { kind: 'app', event: { kind: 'button', button: 'start', action: 'press' } },
  ]);
});

test('the knob is the app’s unless the window manager was told to take it', () => {
  const apps = record();
  apps.gestures.handle({ kind: 'encoder', delta: 2 });
  assert.deepEqual(apps.seen, [{ kind: 'app', event: { kind: 'encoder', delta: 2 } }]);

  const wm = record(true);
  wm.gestures.handle({ kind: 'encoder', delta: -1 });
  assert.deepEqual(wm.seen, [{ kind: 'cycle', delta: -1 }]);
});
