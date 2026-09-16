import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleLog, shouldColor } from '../src/log/console.js';

const MINUTE = 60_000;
const ESC = String.fromCharCode(27);

function capture(options: { verbose?: boolean; color?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 8, 16, 12, 0, 0);
  const log = new ConsoleLog({
    color: options.color ?? false,
    verbose: options.verbose ?? false,
    now: () => clock,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return {
    log,
    out,
    err,
    all: () => [...out, ...err],
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('an app announcing its own name says nothing worth a line', () => {
  const { log, all } = capture();

  log.app('discord', 'busybar-discord', 'out');
  log.app('discord', 'discord', 'out');

  assert.deepEqual(all(), []);
});

test("an app's own tag is not printed beside the column that already names it", () => {
  const { log, out } = capture();

  log.app('discord', '[discord] Discord connected as virtualp1', 'out');

  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /discord\s+Discord connected as virtualp1$/);
  assert.doesNotMatch(out[0] ?? '', /\[discord\]/);
});

test('apps talking about reaching the Bar stay quiet; the wm speaks for the Bar', () => {
  const { log, all } = capture();

  log.app('dota', 'Waiting for BUSY Bar at http://127.0.0.1:4111: fetch failed', 'err');
  log.app('dota', 'BUSY Bar connected (http://127.0.0.1:4111)', 'out');
  log.warn('[wm] waiting for BUSY Bar at http://10.0.4.20: fetch failed');

  assert.equal(all().length, 1);
  assert.match(all()[0] ?? '', /wm\s+waiting for BUSY Bar at http:\/\/10\.0\.4\.20/);
});

test('a line repeated every two seconds is shown once, then counted', () => {
  const { log, all, advance } = capture();

  for (let tick = 0; tick < 10; tick += 1) {
    log.warn('[wm] input socket closed, reconnecting');
    advance(2000);
  }
  assert.equal(all().length, 1, 'once, not ten times');

  advance(5 * MINUTE);
  log.warn('[wm] input socket closed, reconnecting');

  assert.equal(all().length, 2);
  assert.match(all()[1] ?? '', /repeated 9× since/);
});

test('two lines that take turns are each held back on their own', () => {
  const { log, all } = capture();

  for (let round = 0; round < 5; round += 1) {
    log.app('discord', 'input socket closed, reconnecting', 'err');
    log.app('discord', 'waiting for Discord', 'err');
  }

  assert.equal(all().length, 2);
});

test('the same words from two apps are two different lines', () => {
  const { log, all } = capture();

  log.app('discord', 'input socket closed, reconnecting', 'err');
  log.app('nowplaying', 'input socket closed, reconnecting', 'err');

  assert.equal(all().length, 2);
});

test('verbose shows every line as it came', () => {
  const { log, all } = capture({ verbose: true });

  log.app('discord', 'busybar-discord', 'out');
  log.app('dota', 'Waiting for BUSY Bar at http://127.0.0.1:4111', 'err');
  log.warn('[wm] input socket closed, reconnecting');
  log.warn('[wm] input socket closed, reconnecting');

  assert.equal(all().length, 4);
});

test('warnings and errors go to stderr, the rest to stdout', () => {
  const { log, out, err } = capture();

  log.info('[wm] started discord (pid 1)');
  log.app('dota', 'Source: demo', 'out');
  log.app('dota', 'OpenDota: 503', 'err');
  log.app('dota', '[fatal] GET /api/version failed', 'out');

  assert.equal(out.length, 2);
  assert.equal(err.length, 2);
});

test('colour is added only when asked for', () => {
  const plain = capture({ color: false });
  const colored = capture({ color: true });

  plain.log.info('[wm] started discord (pid 1)');
  colored.log.info('[wm] started discord (pid 1)');

  assert.ok(!(plain.out[0] ?? '').includes(ESC + '['), 'no escape codes');
  assert.ok((colored.out[0] ?? '').includes(ESC + '['), 'escape codes present');
});

test('the message column starts in the same place for every source', () => {
  const { log, out } = capture();
  log.reserve(['proxy', 'nowplaying', 'dota']);

  log.info('[wm] ready');
  log.app('dota', 'ready', 'out');
  log.app('nowplaying', 'ready', 'out');

  const columns = out.map((line) => line.indexOf('ready'));
  assert.equal(new Set(columns).size, 1, out.join('\n'));
});

test('colour follows the terminal unless told otherwise', () => {
  assert.equal(shouldColor({ isTTY: true }, {}), true);
  assert.equal(shouldColor({ isTTY: false }, {}), false);
  assert.equal(shouldColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(shouldColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
});
