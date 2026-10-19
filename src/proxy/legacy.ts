import { DEFAULT_PRIORITY, type Element, type Frame, type Scene } from '../wm/scene.js';

/**
 * Apps that do not know the window manager exists — which is all of them, so
 * far — draw through here.
 *
 * Each gets one surface, filled by its draws and emptied by its DELETE. The
 * device upserts by id, so a draw here does too: an element the app drew once
 * stays in its frame until the app deletes it, exactly as it would have stayed
 * on the Bar.
 */
export const LEGACY_SURFACE = 'legacy';

/** A `/display/draw` body, as an app sent it. */
export type DrawPayload = {
  application_name: string;
  priority?: number;
  elements?: unknown[];
  led_notification_color?: string;
  [key: string]: unknown;
};

export function legacyDraw(scene: Scene, payload: DrawPayload, at = Date.now()): void {
  const name = payload.application_name;
  const previous = scene.get(name)?.surfaces.get(LEGACY_SURFACE)?.frame;
  const elements = new Map<string, Element>(
    (previous?.elements ?? []).map((element) => [element.id, element]),
  );
  for (const element of payload.elements ?? []) {
    if (isElement(element)) {
      elements.set(element.id, element);
    }
  }

  const frame: Frame = {
    elements: [...elements.values()],
    priority: typeof payload.priority === 'number' ? payload.priority : DEFAULT_PRIORITY,
    ...(typeof payload.led_notification_color === 'string'
      ? { led: payload.led_notification_color }
      : {}),
  };
  scene.commit(name, LEGACY_SURFACE, frame, at);
}

/** A DELETE: the whole frame, or only the ids it names. */
export function legacyClear(
  scene: Scene,
  name: string,
  elementIds?: string[],
  at = Date.now(),
): void {
  const frame = scene.get(name)?.surfaces.get(LEGACY_SURFACE)?.frame;
  if (!elementIds || !frame) {
    scene.release(name, LEGACY_SURFACE, at);

    return;
  }

  const drop = new Set(elementIds);
  const elements = frame.elements.filter((element) => !drop.has(element.id));
  if (elements.length === 0) {
    scene.release(name, LEGACY_SURFACE, at);

    return;
  }
  scene.commit(name, LEGACY_SURFACE, { ...frame, elements }, at);
}

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
