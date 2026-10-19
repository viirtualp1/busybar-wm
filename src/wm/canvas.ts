import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { Element, SurfaceState } from './scene.js';
import { DEFAULT_PRIORITY } from './scene.js';

/**
 * The one `application_name` the device ever sees from the window manager.
 *
 * The Bar's canvas has a single owner: a draw under another name needs a
 * strictly higher priority, and then wipes everything the previous owner had.
 * So every app's elements are drawn under this name, with their ids made unique
 * per app — which is also what turns a handover into a diff rather than a clear
 * followed by a draw.
 */
export const OWNER = 'busybar-wm';

/** The device refuses a draw that would leave more than this on the canvas. */
export const MAX_ELEMENTS = 100;

/** The firmware's limit on an uploaded file's name, folders included. */
const MAX_FILE_NAME = 64;

/** Element types whose `path` names an uploaded asset. */
const ASSET_TYPES = new Set(['image', 'animation']);

/** What the canvas should hold: element ids to the element, and how to draw it. */
export type Desired = {
  elements: Map<string, Element>;
  priority: number;
  led?: string;
};

export type Plan = {
  /** Ids to delete before the draw: gone from the frame, or changed type or panel. */
  remove: string[];
  /** Elements to draw: new, or different from what the device holds. */
  upsert: Element[];
};

/** An app's element id, made unique across every app on the one canvas. */
export function namespaced(client: string, surface: string, id: string): string {
  return `${client}/${surface}:${id}`;
}

/**
 * Where an app's upload lives once it is under the window manager's name.
 *
 * An image's `path` resolves inside the drawing application's own folder, and
 * the drawing application is now always `OWNER` — so `cover.png` uploaded by
 * nowplaying becomes `nowplaying/cover.png` under `OWNER`. The device allows
 * folders in an upload's name but caps it at 64 characters, so a name that would
 * not fit is replaced by a hash of itself, which is the same every time.
 */
export function rehome(client: string, file: string): string {
  const plain = `${client}/${file}`;
  if (plain.length <= MAX_FILE_NAME) {
    return plain;
  }

  const ext = extname(file).slice(0, 8);
  const room = MAX_FILE_NAME - client.length - 1 - ext.length;
  const digest = createHash('sha1')
    .update(file)
    .digest('hex')
    .slice(0, Math.max(8, room));

  return `${client}/${digest}${ext}`;
}

/** The canvas for one app's surfaces, as the device will hold it. */
export function compose(client: string, surfaces: SurfaceState[]): Desired {
  const elements = new Map<string, Element>();
  let priority: number | null = null;
  let led: string | undefined;
  // The device stacks an element without a `z_index` by its place in the one
  // request that drew it, counting from zero each time. A diff draws only what
  // changed, so that count would restart under every update and a lone `time`
  // would land level with the progress bar behind it. The place is the one it
  // has in the whole frame, written down here, the way a full draw would.
  let z = 0;

  for (const surface of surfaces) {
    const frame = surface.frame;
    if (!frame) {
      continue;
    }
    priority = Math.max(priority ?? 0, frame.priority);
    led ??= frame.led;

    for (const element of frame.elements) {
      const id = namespaced(client, surface.name, element.id);
      const placed: Element = { ...element, id };
      if (typeof element['z_index'] !== 'number') {
        placed['z_index'] = z;
        z += 10;
      }
      if (
        typeof element.type === 'string' &&
        ASSET_TYPES.has(element.type) &&
        typeof element['path'] === 'string'
      ) {
        placed['path'] = rehome(client, element['path']);
      }
      elements.set(id, placed);
    }
  }

  return { elements, priority: priority ?? DEFAULT_PRIORITY, ...(led ? { led } : {}) };
}

/**
 * The fewest requests that take the canvas from what it holds to what it should.
 *
 * A draw is an upsert by id — an id left out of the next draw stays on screen —
 * so whatever went has to be deleted by name. An id whose type or panel changed
 * is deleted first too: the device refuses to turn a text into an image in
 * place.
 */
export function diff(device: ReadonlyMap<string, string>, desired: Desired): Plan {
  const remove: string[] = [];
  const upsert: Element[] = [];

  for (const [id, element] of desired.elements) {
    const held = device.get(id);
    const json = JSON.stringify(element);
    if (held === json) {
      continue;
    }
    if (held !== undefined && !sameKind(JSON.parse(held) as Element, element)) {
      remove.push(id);
    }
    upsert.push(element);
  }

  for (const id of device.keys()) {
    if (!desired.elements.has(id)) {
      remove.push(id);
    }
  }

  return { remove, upsert };
}

function sameKind(a: Element, b: Element): boolean {
  return a.type === b.type && (a.display ?? 'front') === (b.display ?? 'front');
}
