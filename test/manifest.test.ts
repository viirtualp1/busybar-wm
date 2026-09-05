import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseManifest } from '../src/manifest.js';

test('a command with nothing else said means "yes, run this"', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'dota', command: 'npm', args: ['start'] }] },
    '/base',
  );

  assert.equal(apps[0]?.autostart, true);
  assert.equal(apps[0]?.restart, true);
  assert.equal(apps[0]?.rank, 10, 'and lands on the default rank');
});

test('an app with no command is one you start yourself', () => {
  const { apps } = parseManifest({ apps: [{ name: 'manual', rank: 5 }] }, '/base');

  assert.equal(apps[0]?.command, undefined);
  assert.equal(apps[0]?.autostart, false);
});

test('paths are relative to the manifest, not to wherever you ran the daemon', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'dota', command: 'npm', cwd: '../busybar-dota' }] },
    '/home/me/pet-projects/busybar-wm',
  );

  assert.equal(apps[0]?.cwd, '/home/me/pet-projects/busybar-dota');
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
