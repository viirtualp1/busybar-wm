import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseManifest } from '../src/manifest.js';

test('a command with nothing else said means "yes, run this"', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'dota', command: 'npm', args: ['start'] }] },
    '/base',
  );

  assert.equal(apps[0]?.autostart, true);
  assert.equal(apps[0]?.restart, true);
});

test('the order of the list is the priority: the first listed goes first', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'livesplit' }, { name: 'mydota' }, { name: 'dota' }] },
    '/base',
  );

  assert.deepEqual(
    apps.map((app) => [app.name, app.rank]),
    [
      ['livesplit', 30],
      ['mydota', 20],
      ['dota', 10],
    ],
  );
});

test('a manifest still written with numbers keeps meaning what it meant', () => {
  const { apps } = parseManifest(
    {
      apps: [
        { name: 'flights', rank: 15 },
        { name: 'livesplit', rank: 60 },
        { name: 'dota' },
        { name: 'mydota', rank: 50 },
      ],
    },
    '/base',
  );

  assert.deepEqual(
    apps.map((app) => app.name),
    ['livesplit', 'mydota', 'flights', 'dota'],
    'sorted on the numbers, and one without sits at the old default of 10',
  );
  assert.ok(
    apps.every((app) => !('written' in app)),
    'the number read is not passed on',
  );
});

test('an app with no command is one you start yourself', () => {
  const { apps } = parseManifest({ apps: [{ name: 'manual' }] }, '/base');

  assert.equal(apps[0]?.command, undefined);
  assert.equal(apps[0]?.autostart, false);
});

test('paths are relative to the manifest, not to wherever you ran the daemon', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'dota', command: 'npm', cwd: '../busybar-dota' }] },
    '/home/me/pet-projects/busybar-wm',
  );

  assert.equal(
    apps[0]?.cwd,
    resolve('/home/me/pet-projects/busybar-wm', '../busybar-dota'),
  );
});

test('two apps cannot share a name, because the name is the identity', () => {
  assert.throws(
    () => parseManifest({ apps: [{ name: 'dota' }, { name: 'dota' }] }, '/base'),
    /appears twice/,
  );
});

test('autostart with nothing to start is a typo worth failing on', () => {
  assert.throws(
    () => parseManifest({ apps: [{ name: 'dota', autostart: true }] }, '/base'),
    /needs a command/,
  );
});

test('the errors say which entry and which field', () => {
  assert.throws(() => parseManifest({ apps: [{ rank: 3 }] }, '/base'), /apps\[0\]\.name/);
  assert.throws(
    () => parseManifest({ apps: [{ name: 'a', rank: 'high' }] }, '/base'),
    /apps\[0\]\.rank/,
  );
  assert.throws(() => parseManifest({}, '/base'), /"apps" array/);
});
