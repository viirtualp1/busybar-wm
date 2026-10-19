import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, diff, rehome, type Desired } from '../src/wm/canvas.js';
import type { Element, SurfaceState } from '../src/wm/scene.js';

function surface(
  name: string,
  elements: Element[],
  priority = 50,
  led?: string,
): SurfaceState {
  const frame = { elements, priority, ...(led ? { led } : {}) };

  return { name, frame, frameKey: JSON.stringify(frame), want: 'normal' };
}

function held(desired: Desired): Map<string, string> {
  return new Map(
    [...desired.elements].map(([id, element]) => [id, JSON.stringify(element)]),
  );
}

const text = (id: string, value: string, extra: Partial<Element> = {}): Element => ({
  id,
  type: 'text',
  text: value,
  ...extra,
});

test('ids are made unique per app and surface, so two apps never share one', () => {
  const desired = compose('dota', [surface('main', [text('clock', '12:00')])]);

  assert.deepEqual([...desired.elements.keys()], ['dota/main:clock']);
  assert.equal(desired.elements.get('dota/main:clock')?.['text'], '12:00');
});

test('an image names its asset where the daemon put it', () => {
  const desired = compose('nowplaying', [
    surface('main', [
      { id: 'art', type: 'image', path: 'cover-1.png', display: 'back' },
      { id: 'icon', type: 'image', stock_path: 'icons/play.png' },
    ]),
  ]);

  assert.equal(
    desired.elements.get('nowplaying/main:art')?.['path'],
    'nowplaying/cover-1.png',
  );
  assert.equal(
    desired.elements.get('nowplaying/main:icon')?.['stock_path'],
    'icons/play.png',
    'the Bar’s own images are not ours to move',
  );
});

test('a name too long for the device is shortened the same way every time', () => {
  const long = `${'x'.repeat(70)}.png`;
  const once = rehome('nowplaying', long);

  assert.ok(once.length <= 64, once);
  assert.ok(once.startsWith('nowplaying/') && once.endsWith('.png'), once);
  assert.equal(rehome('nowplaying', long), once);
  assert.equal(rehome('nowplaying', 'cover.png'), 'nowplaying/cover.png');
});

test('priority is the highest of the frames, and the LED the first that asks', () => {
  const desired = compose('nowplaying', [
    surface('cover', [text('a', 'a')], 40),
    surface('strip', [text('b', 'b')], 70, '#00ff00'),
  ]);

  assert.equal(desired.priority, 70);
  assert.equal(desired.led, '#00ff00');
});

test('an unchanged canvas needs nothing', () => {
  const desired = compose('dota', [surface('main', [text('a', '1'), text('b', '2')])]);

  assert.deepEqual(diff(held(desired), desired), { remove: [], upsert: [] });
});

test('only what changed is drawn, and what went is deleted by id', () => {
  const before = compose('dota', [surface('main', [text('a', '1'), text('b', '2')])]);
  const after = compose('dota', [surface('main', [text('a', '1'), text('c', '3')])]);

  const plan = diff(held(before), after);
  assert.deepEqual(plan.remove, ['dota/main:b']);
  assert.deepEqual(
    plan.upsert.map((element) => element.id),
    ['dota/main:c'],
  );
});

test('a handover is the same diff: the old app’s ids out, the new one’s in', () => {
  const dota = compose('dota', [surface('main', [text('clock', '1')])]);
  const chess = compose('chess', [surface('main', [text('clock', '2')])]);

  const plan = diff(held(dota), chess);
  assert.deepEqual(plan.remove, ['dota/main:clock']);
  assert.deepEqual(
    plan.upsert.map((element) => element.id),
    ['chess/main:clock'],
  );
});

test('an element that changes type or panel is deleted before it is drawn again', () => {
  const before = compose('dota', [surface('main', [text('x', 'hello')])]);
  const after = compose('dota', [
    surface('main', [{ id: 'x', type: 'rectangle', width: 2, height: 2 }]),
  ]);
  const moved = compose('dota', [
    surface('main', [text('x', 'hello', { display: 'back' })]),
  ]);

  assert.deepEqual(diff(held(before), after).remove, ['dota/main:x']);
  assert.deepEqual(diff(held(before), moved).remove, ['dota/main:x']);
  assert.deepEqual(
    diff(held(before), compose('dota', [surface('main', [text('x', 'bye')])])).remove,
    [],
    'new text in the same element is an update, not a replacement',
  );
});

test('every element keeps the layer a whole draw would give it, even drawn alone', () => {
  const frame = (time: string) =>
    compose('np', [
      surface('strip', [
        { id: 'progress', type: 'rectangle', width: 30, height: 16 },
        text('title', 'Song'),
        text('time', time),
        text('badge', '!', { z_index: 5 }),
      ]),
    ]);
  const before = frame('0:01');
  const after = frame('0:02');

  assert.deepEqual(
    [...after.elements.values()].map((element) => element['z_index']),
    [0, 10, 20, 5],
    'counted as the device would: only the ones that do not say',
  );

  const [time] = diff(held(before), after).upsert;
  assert.equal(time?.id, 'np/strip:time');
  assert.equal(time?.['z_index'], 20, 'above the bar, not level with it');
});
