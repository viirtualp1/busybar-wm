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

  supervisor.start();
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

  supervisor.start();
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

  supervisor.start();
  assert.equal(registry.get('fake')?.running, false);
  await supervisor.stop();
});
