import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { profileAt } from 'busybar-kit/profile';
import { parseManifest } from '../src/manifest.js';

const DIR = resolve('/home/me/.busybar');

/** A profile where only the named packages were installed. */
function profile(installed: string[] = []) {
  const bins = new Set(installed.map((name) => join(DIR, 'node_modules', '.bin', name)));

  return profileAt(DIR, { platform: 'linux', exists: (path) => bins.has(path) });
}

test('an app with nothing said runs the package the profile installed', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'mydota', rank: 50 }] },
    '/base',
    profile(['busybar-mydota']),
  );

  assert.equal(apps[0]?.command, join(DIR, 'node_modules', '.bin', 'busybar-mydota'));
  assert.equal(apps[0]?.autostart, true, 'a resolved command is still a command');
});

test('every app keeps its own config folder inside the profile', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'mydota' }, { name: 'dota' }] },
    '/base',
    profile(['busybar-mydota', 'busybar-dota']),
  );

  assert.equal(apps[0]?.cwd, join(DIR, 'mydota'));
  assert.equal(apps[1]?.cwd, join(DIR, 'dota'));
});

test('a checkout still wins, so both kinds of app live side by side', () => {
  const { apps } = parseManifest(
    {
      apps: [
        { name: 'mydota' },
        {
          name: 'dota',
          command: 'node',
          args: ['dist/index.js'],
          cwd: '../busybar-dota',
        },
      ],
    },
    '/base',
    profile(['busybar-mydota', 'busybar-dota']),
  );

  assert.equal(apps[1]?.command, 'node', 'an explicit command is taken literally');
  assert.equal(apps[1]?.cwd, resolve('/base', '../busybar-dota'));
});

test('a bare name means the profile package, not whatever is on PATH', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'flights', command: 'busybar-flights' }] },
    '/base',
    profile(['busybar-flights']),
  );

  assert.equal(apps[0]?.command, join(DIR, 'node_modules', '.bin', 'busybar-flights'));
});

test('a bare name the profile does not have is left for PATH to find', () => {
  const { apps } = parseManifest(
    { apps: [{ name: 'dota', command: 'node', args: ['dist/index.js'] }] },
    '/base',
    profile([]),
  );

  assert.equal(apps[0]?.command, 'node');
});

test('an app the profile has not installed is one you start yourself', () => {
  const { apps } = parseManifest({ apps: [{ name: 'chess' }] }, '/base', profile([]));

  assert.equal(apps[0]?.command, undefined);
  assert.equal(apps[0]?.autostart, false);
  assert.equal(apps[0]?.cwd, join(DIR, 'chess'), 'but it still has a home for its .env');
});

test('without a profile nothing is filled in, which is the old behaviour', () => {
  const { apps } = parseManifest({ apps: [{ name: 'mydota' }] }, '/base');

  assert.equal(apps[0]?.command, undefined);
  assert.equal(apps[0]?.cwd, undefined, 'and the app inherits the daemon working dir');
});
