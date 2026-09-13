import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Strays, type StrayNote } from '../src/wm/strays.js';

const NOW = 1_800_000_000_000;
const UP_FOR = 60 * 60 * 1000;

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'busybar-strays-'));
  dirs.push(dir);

  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A tracker that kills nothing and believes whatever we say is alive. */
function tracker(dir: string, living: number[] = []) {
  const killed: number[] = [];
  const strays = new Strays(dir, {
    now: () => NOW,
    bootedMsAgo: () => UP_FOR,
    alive: (pid) => living.includes(pid),
    kill: (pid) => killed.push(pid),
    // The doubles never actually die, so waiting for them would only add time.
    waitMs: 0,
  });

  return { strays, killed };
}

function note(dir: string, notes: Partial<StrayNote>[]): void {
  writeFileSync(
    join(dir, 'children.json'),
    JSON.stringify(notes.map((n) => ({ pid: 1, name: 'demo', startedAt: NOW, ...n }))),
  );
}

test('a child is written down as it starts, so the next run knows about it', () => {
  const dir = scratch();
  const { strays } = tracker(dir);

  strays.remember(4242, 'mydota');
  const written = JSON.parse(
    readFileSync(join(dir, 'children.json'), 'utf8'),
  ) as StrayNote[];

  assert.equal(written.length, 1);
  assert.equal(written[0]?.pid, 4242);
  assert.equal(written[0]?.name, 'mydota');
});

test('a child that exits is forgotten rather than hunted next time', () => {
  const dir = scratch();
  const { strays } = tracker(dir);

  strays.remember(4242, 'mydota');
  strays.forget(4242);

  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'children.json'), 'utf8')), []);
});

test('a stray still holding its port is stopped before anything else starts', async () => {
  const dir = scratch();
  note(dir, [{ pid: 4242, name: 'mydota' }]);
  const { strays, killed } = tracker(dir, [4242]);

  const stopped = await strays.sweep();

  assert.deepEqual(killed, [4242]);
  assert.equal(stopped[0]?.name, 'mydota');
});

test('a pid that is no longer running is left alone', async () => {
  const dir = scratch();
  note(dir, [{ pid: 4242, name: 'mydota' }]);
  const { strays, killed } = tracker(dir, []);

  assert.deepEqual(await strays.sweep(), []);
  assert.deepEqual(killed, []);
});

test('a note from before this machine booted is not trusted', async () => {
  const dir = scratch();
  // The pid may well be alive — as something else entirely.
  note(dir, [{ pid: 4242, name: 'mydota', startedAt: NOW - UP_FOR - 1000 }]);
  const { strays, killed } = tracker(dir, [4242]);

  assert.deepEqual(await strays.sweep(), [], 'a recycled pid is somebody else');
  assert.deepEqual(killed, []);
});

test('the note is emptied once it has been acted on', async () => {
  const dir = scratch();
  note(dir, [{ pid: 4242, name: 'mydota' }]);
  const { strays } = tracker(dir, [4242]);

  await strays.sweep();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'children.json'), 'utf8')), []);
});

test('the sweep waits for a stray to be gone before letting anything start', async () => {
  const dir = scratch();
  note(dir, [{ pid: 4242, name: 'mydota' }]);
  // Alive for the first few looks, as a process is while taskkill gets to it.
  let looks = 0;
  const strays = new Strays(dir, {
    now: () => NOW,
    bootedMsAgo: () => UP_FOR,
    alive: () => {
      looks += 1;

      return looks < 4;
    },
    kill: () => undefined,
    waitMs: 5000,
  });

  await strays.sweep();

  assert.ok(looks >= 4, 'it kept looking until the process had let go');
});

test('an orderly stop forgets the children that really went', () => {
  const dir = scratch();
  const { strays } = tracker(dir, []);

  strays.remember(4242, 'mydota');
  strays.settle();

  assert.equal(existsSync(join(dir, 'children.json')), false);
});

test('a child that outlived its kill stays in the note, for the next start to clear', async () => {
  // This is the Ctrl+C case: the shell under the daemon died, the app beneath
  // it did not, and the old stop deleted the note anyway.
  const dir = scratch();
  const { strays } = tracker(dir, [4242]);

  strays.remember(4242, 'mydota');
  strays.settle();

  const next = tracker(dir, [4242]);
  const stopped = await next.strays.sweep();

  assert.deepEqual(next.killed, [4242]);
  assert.equal(stopped[0]?.name, 'mydota');
});

test('a clean shutdown leaves nothing to sweep', async () => {
  const dir = scratch();
  const { strays, killed } = tracker(dir, [4242]);

  strays.remember(4242, 'mydota');
  strays.clear();

  assert.deepEqual(
    await new Strays(dir, {
      alive: () => true,
      kill: () => undefined,
      waitMs: 0,
    }).sweep(),
    [],
  );
  assert.deepEqual(killed, []);
});

test('a corrupt or missing note is not a reason to fail a start', async () => {
  const dir = scratch();
  assert.deepEqual(await tracker(dir).strays.sweep(), [], 'nothing written yet');

  writeFileSync(join(dir, 'children.json'), '{not json');
  assert.deepEqual(await tracker(dir).strays.sweep(), []);

  writeFileSync(join(dir, 'children.json'), '[{"pid":"nope"}]');
  assert.deepEqual(await tracker(dir).strays.sweep(), []);
});
