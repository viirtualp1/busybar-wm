import type { InputEvent } from '../bar/input.js';
import type { Element, WantLevel } from '../wm/scene.js';
import { WANT_LEVELS } from '../wm/scene.js';

/**
 * The display protocol, v1: what an app and the window manager say to each
 * other over `ws://…/wm/v1/display`. JSON, one object per message, `type` first.
 *
 * See docs/display-server.md for why each message exists.
 */
export const PROTOCOL = 1;
export const DISPLAY_PATH = '/wm/v1/display';

export type DisplayId = 'front' | 'back';
export const DISPLAYS: readonly DisplayId[] = ['front', 'back'];

/** Only one role in v1; the field is there so that adding one is not a break. */
export type Role = 'fullscreen';

export type Hello = { type: 'hello'; protocol: number; app: string; token?: string };
export type SurfaceCreate = {
  type: 'surface.create';
  surface: string;
  role: Role;
  display: DisplayId;
};
export type SurfaceCommit = {
  type: 'surface.commit';
  surface: string;
  ack?: number;
  /** The whole frame. An empty list means nothing to show. */
  elements: Element[];
  priority?: number;
  led_notification_color?: string;
};
export type SurfaceWant = { type: 'surface.want'; surface: string; level: WantLevel };
export type SurfaceDestroy = { type: 'surface.destroy'; surface: string };

/** The Bar's controls an app can ask for. BACK and the switch are the window manager's. */
export type InputKey = 'ok' | 'start' | 'encoder';
export const INPUT_KEYS: readonly InputKey[] = ['ok', 'start', 'encoder'];

/**
 * `focused`: while the app is on screen. `always`: whatever is on screen — one
 * app per key, the way the knob is the system volume whoever is showing.
 */
export type GrabWhen = 'focused' | 'always';

export type InputGrab = { type: 'input.grab'; keys: InputKey[]; when: GrabWhen };
export type InputRelease = { type: 'input.release'; keys: InputKey[] };

export type ClientMessage =
  | Hello
  | SurfaceCreate
  | SurfaceCommit
  | SurfaceWant
  | SurfaceDestroy
  | InputGrab
  | InputRelease;

export type ErrorCode =
  | 'bad_message'
  | 'protocol'
  | 'auth'
  | 'not_ready'
  | 'replaced'
  | 'unknown_surface'
  | 'surface_exists'
  | 'unsupported_role'
  | 'too_many_elements'
  | 'grab_taken'
  | 'reserved_key';

export type ServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      displays: { id: DisplayId; width: number; height: number }[];
      frameMs: number;
      budget: number;
    }
  | {
      type: 'configure';
      surface: string;
      serial: number;
      width: number;
      height: number;
      visible: boolean;
      focused: boolean;
      budget: number;
    }
  | { type: 'frame'; surface: string }
  | { type: 'input'; event: InputEvent }
  | { type: 'error'; code: ErrorCode; message: string; surface?: string };

/**
 * A name that is also a folder on the Bar: the device's own rule for an
 * application name, which is what an app's uploads are filed under.
 */
const NAME = /^[A-Za-z0-9._-]{1,32}$/;

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One message off the socket, checked; anything malformed is a `ProtocolError`. */
export function parseClientMessage(text: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError('bad_message', 'not JSON');
  }
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new ProtocolError('bad_message', 'a message is an object with a `type`');
  }

  switch (value['type']) {
    case 'hello':
      return {
        type: 'hello',
        protocol: number(value, 'protocol'),
        app: name(value, 'app'),
        ...(typeof value['token'] === 'string' ? { token: value['token'] } : {}),
      };
    case 'surface.create': {
      const role = value['role'] ?? 'fullscreen';
      if (role !== 'fullscreen') {
        throw new ProtocolError(
          'unsupported_role',
          `role ${JSON.stringify(role)} is not in v1`,
        );
      }
      const display = value['display'] ?? 'front';
      if (!DISPLAYS.includes(display as DisplayId)) {
        throw new ProtocolError('bad_message', '`display` is "front" or "back"');
      }

      return {
        type: 'surface.create',
        surface: name(value, 'surface'),
        role,
        display: display as DisplayId,
      };
    }
    case 'surface.commit': {
      const elements = value['elements'];
      if (!Array.isArray(elements) || !elements.every(isElement)) {
        throw new ProtocolError(
          'bad_message',
          '`elements` is a list of objects with an `id`',
        );
      }

      return {
        type: 'surface.commit',
        surface: name(value, 'surface'),
        elements,
        ...(typeof value['ack'] === 'number' ? { ack: value['ack'] } : {}),
        ...(typeof value['priority'] === 'number' ? { priority: value['priority'] } : {}),
        ...(typeof value['led_notification_color'] === 'string'
          ? { led_notification_color: value['led_notification_color'] }
          : {}),
      };
    }
    case 'surface.want': {
      const level = value['level'];
      if (!WANT_LEVELS.includes(level as WantLevel)) {
        throw new ProtocolError('bad_message', '`level` is "idle", "normal" or "urgent"');
      }

      return {
        type: 'surface.want',
        surface: name(value, 'surface'),
        level: level as WantLevel,
      };
    }
    case 'input.grab': {
      const when = value['when'] ?? 'focused';
      if (when !== 'focused' && when !== 'always') {
        throw new ProtocolError('bad_message', '`when` is "focused" or "always"');
      }

      return { type: 'input.grab', keys: keys(value), when };
    }
    case 'input.release':
      return { type: 'input.release', keys: keys(value) };
    case 'surface.destroy':
      return { type: 'surface.destroy', surface: name(value, 'surface') };
    default:
      throw new ProtocolError('bad_message', `no message called ${value['type']}`);
  }
}

function keys(value: Record<string, unknown>): InputKey[] {
  const found = value['keys'];
  if (!Array.isArray(found) || found.length === 0) {
    throw new ProtocolError(
      'bad_message',
      '`keys` is a list of "ok", "start", "encoder"',
    );
  }
  for (const key of found) {
    if (key === 'back') {
      throw new ProtocolError('reserved_key', 'BACK belongs to the window manager');
    }
    if (!INPUT_KEYS.includes(key as InputKey)) {
      throw new ProtocolError('bad_message', `no key called ${JSON.stringify(key)}`);
    }
  }

  return [...new Set(found as InputKey[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isElement(value: unknown): value is Element {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}

function number(value: Record<string, unknown>, key: string): number {
  const found = value[key];
  if (typeof found !== 'number') {
    throw new ProtocolError('bad_message', `\`${key}\` is a number`);
  }

  return found;
}

function name(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string' || !NAME.test(found)) {
    throw new ProtocolError(
      'bad_message',
      `\`${key}\` is 1–32 letters, digits, dots, dashes or underscores`,
    );
  }

  return found;
}
