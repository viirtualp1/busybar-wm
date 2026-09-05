import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cycleOrder, decide, nextPin } from '../src/wm/arbiter.js';
import type { AppState } from '../src/wm/registry.js';

function app(name: string, over: Partial<AppState> = {}): AppState {
  return {
    name,
    rank: 10,
    managed: true,
    running: true,
    frame: { application_name: name },
    frameKey: name,
    priority: 50,
    lastDrawAt: 0,
    yieldedAt: 0,
    ...over,
  };
}

const base = { pinned: null, current: null, currentSince: 0, now: 1000, minHoldMs: 3000 };

test('nobody drawing means the display goes back to the Bar', () => {
  assert.deepEqual(decide({ ...base, candidates: [] }), { name: null, reason: 'idle' });
});

test('rank decides, not who spoke last', () => {
  const decision = decide({
    ...base,
    candidates: [
      app('nowplaying', { rank: 20, lastDrawAt: 999 }),
      app('dota', { rank: 40 }),
    ],
  });

  assert.equal(decision.name, 'dota');
});

test('within a rank, an app that raised its own draw priority wins', () => {
  const decision = decide({
    ...base,
    candidates: [app('a', { priority: 40 }), app('b', { priority: 70 })],
  });

  assert.equal(decision.name, 'b');
});

test('and failing that, the most recent frame', () => {
  const decision = decide({
    ...base,
    candidates: [app('a', { lastDrawAt: 10 }), app('b', { lastDrawAt: 20 })],
  });

  assert.equal(decision.name, 'b');
});

test('an equal-ranked rival cannot take the screen inside the hold', () => {
  const decision = decide({
    ...base,
    candidates: [app('a', { lastDrawAt: 10 }), app('b', { lastDrawAt: 20 })],
    current: 'a',
    currentSince: 900,
    now: 1000,
  });

  assert.deepEqual(decision, { name: 'a', reason: 'hold' });
});

test('a higher rank interrupts the hold — that is what rank is for', () => {
  const decision = decide({
    ...base,
    candidates: [app('a'), app('urgent', { rank: 90 })],
    current: 'a',
    currentSince: 900,
    now: 1000,
  });

  assert.equal(decision.name, 'urgent');
});

test('once the hold is over the better app comes through', () => {
  const decision = decide({
    ...base,
    candidates: [app('a', { lastDrawAt: 10 }), app('b', { lastDrawAt: 20 })],
    current: 'a',
    currentSince: 0,
    now: 5000,
  });

  assert.equal(decision.name, 'b');
});

test('a pin beats rank, which is the point of choosing by hand', () => {
  const decision = decide({
    ...base,
    candidates: [app('quiet', { rank: 1 }), app('dota', { rank: 90 })],
    pinned: 'quiet',
  });

  assert.deepEqual(decision, { name: 'quiet', reason: 'pinned' });
});

test('a pin on an app that stopped drawing is not honoured', () => {
  const decision = decide({ ...base, candidates: [app('dota')], pinned: 'gone' });

  assert.deepEqual(decision, { name: 'dota', reason: 'rank' });
});

test('the knob walks the same order the arbiter would pick in', () => {
  const order = cycleOrder([
    app('c', { rank: 5 }),
    app('a', { rank: 50 }),
    app('b', { rank: 20 }),
  ]);

  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(nextPin(order, 'a', 1), 'b');
  assert.equal(nextPin(order, 'c', 1), 'a', 'and wraps');
  assert.equal(nextPin(order, 'a', -1), 'c');
  assert.equal(nextPin(order, null, 1), 'a', 'starting from nothing lands on the first');
  assert.equal(nextPin([], null, 1), null);
});
