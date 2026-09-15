import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppManifest } from '../src/manifest.js';
import { Registry } from '../src/wm/registry.js';
import { Supervisor } from '../src/wm/supervisor.js';

const quiet = { info: () => undefined, warn: () => undefined };

/** An app that does nothing but print where it was told the Bar is, and wait. */
const APP = 'console.log(process.env.BUSY_ADDR); setInterval(() => {}, 1000);';

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    name: 'fake',
    rank: 10,
    command: process.execPath,
    args: ['-e', APP],
    env: {},
    autostart: true,
    restart: false,
    ...over,
  };
}

async function until(what: string, predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a supervised app is pointed at the proxy, not at the Bar', async () => {
  const lines: string[] = [];
  const registry = new Registry([manifest()], { staleMs: 1000 });
  const supervisor = new Supervisor([manifest()], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs: 100,
    logger: { info: (line) => lines.push(line), warn: () => undefined },
  });

  await supervisor.start();
  try {
    await until('the app to report its address', () =>
      lines.some((line) => line.includes('http://127.0.0.1:4999')),
    );
    assert.equal(registry.get('fake')?.running, true);
  } finally {
    await supervisor.stop();
  }

  assert.equal(registry.get('fake')?.running, false);
});

test('a process that is gone is showing nothing, whatever it drew last', async () => {
  const registry = new Registry([manifest()], { staleMs: 60_000 });
  const supervisor = new Supervisor([manifest()], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs: 100,
    logger: quiet,
  });

  await supervisor.start();
  await until('the app to come up', () => registry.get('fake')?.running === true);
  registry.draw({ application_name: 'fake', elements: [] });
  assert.equal(registry.candidates().length, 1);

  await supervisor.stop();
  assert.equal(registry.candidates().length, 0);
});

test('an app that was not given a command is left alone', async () => {
  const unmanaged: AppManifest = {
    name: 'fake',
    rank: 10,
    args: [],
    env: {},
    autostart: false,
    restart: false,
  };
  const registry = new Registry([unmanaged], { staleMs: 1000 });
  const supervisor = new Supervisor([unmanaged], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs: 100,
    logger: quiet,
  });

  await supervisor.start();
  assert.equal(registry.get('fake')?.running, false);
  await supervisor.stop();
});

function supervised(app: AppManifest, restartDelayMs = 100) {
  const registry = new Registry([app], { staleMs: 1000 });
  const supervisor = new Supervisor([app], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs,
    logger: quiet,
  });

  return { registry, supervisor };
}

test('a crash says how it ended, and what the app said on the way out', async () => {
  const { supervisor } = supervised(
    manifest({ args: ['-e', "console.error('no token in .env'); process.exit(3)"] }),
  );

  await supervisor.start();
  try {
    await until('the app to exit', () => supervisor.health('fake')?.state === 'exited');
    const health = supervisor.health('fake');

    assert.equal(health?.exitCode, 3);
    assert.match(health?.message ?? '', /exit code 3/);
    assert.ok(health?.output.includes('no token in .env'), health?.output.join('|'));
  } finally {
    await supervisor.stop();
  }
});

test('a crash that will be retried says when', async () => {
  const { supervisor } = supervised(
    manifest({ args: ['-e', 'process.exit(1)'], restart: true }),
    60_000,
  );

  await supervisor.start();
  try {
    await until(
      'a retry to be scheduled',
      () => supervisor.health('fake')?.state === 'restarting',
    );
    assert.ok((supervisor.health('fake')?.restartAt ?? 0) > Date.now());
  } finally {
    await supervisor.stop();
  }
});

test('an app with autostart off is waiting, and says it is by choice', async () => {
  const { supervisor } = supervised(manifest({ autostart: false }));

  await supervisor.start();
  assert.equal(supervisor.health('fake')?.state, 'waiting');
  assert.match(supervisor.health('fake')?.message ?? '', /Autostart is off/);
  await supervisor.stop();
});

test('an app added while running is started without touching the others', async () => {
  const registry = new Registry([], { staleMs: 1000 });
  const supervisor = new Supervisor([], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs: 100,
    logger: quiet,
  });

  await supervisor.start();
  try {
    const app = manifest({ name: 'late' });
    registry.add(app);
    assert.equal(supervisor.add(app), true);
    assert.equal(supervisor.add(app), false, 'a second add is not a second process');

    await until('the new app to come up', () => registry.get('late')?.running === true);
  } finally {
    await supervisor.stop();
  }
});

test('an app stopped by hand stays stopped, and says so', async () => {
  const { registry, supervisor } = supervised(manifest({ restart: true }), 50);

  await supervisor.start();
  try {
    await until('the app to come up', () => registry.get('fake')?.running === true);
    await supervisor.stopApp('fake');
    await until('the app to be down', () => registry.get('fake')?.running === false);
    // Several restart delays' worth: long enough for one to have come.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(registry.get('fake')?.running, false, 'no restart came for it');
    assert.equal(supervisor.health('fake')?.state, 'stopped');

    await supervisor.restart('fake');
    await until(
      'it to start again by hand',
      () => registry.get('fake')?.running === true,
    );
    assert.equal(supervisor.health('fake')?.state, 'running');
  } finally {
    await supervisor.stop();
  }
});

test('a removed app is stopped and forgotten', async () => {
  const { registry, supervisor } = supervised(manifest({ restart: true }), 50);

  await supervisor.start();
  try {
    await until('the app to come up', () => registry.get('fake')?.running === true);
    assert.equal(await supervisor.remove('fake'), true);
    await until('the app to be down', () => registry.get('fake')?.running === false);

    assert.equal(supervisor.health('fake'), undefined);
    assert.equal(await supervisor.remove('fake'), false, 'nothing left to remove');
  } finally {
    await supervisor.stop();
  }
});

test('npm as a command is spawnable', async () => {
  const lines: string[] = [];
  const npm = manifest({
    command: 'npm',
    args: ['--version'],
    restart: false,
  });
  const registry = new Registry([npm], { staleMs: 1000 });
  const supervisor = new Supervisor([npm], {
    proxyAddr: 'http://127.0.0.1:4999',
    registry,
    restartDelayMs: 100,
    logger: {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    },
  });

  await supervisor.start();
  try {
    await until('npm to print a version', () =>
      lines.some((line) => /\d+\.\d+\.\d+/.test(line)),
    );
    assert.equal(
      lines.some((line) => /EINVAL/i.test(line)),
      false,
      lines.join('\n'),
    );
  } finally {
    await supervisor.stop();
  }
});
