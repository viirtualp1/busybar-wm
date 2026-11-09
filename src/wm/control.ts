import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InputEvent } from '../bar/input.js';

export type Overlay = {
  kind: 'message' | 'timer';
  text: string;
  display: 'front' | 'back';
  endsAt: number;
};

type Control = {
  status: () => object;
  apps: () => object[];
  switchApp: (name: string) => 'missing' | 'unavailable' | 'pinned';
  automatic: () => void;
  overlay: (overlay: Overlay) => void;
  clearOverlay: (display?: Overlay['display']) => void;
  input: (events: InputEvent[]) => string | null;
  knobReserved: boolean;
};

export const CONTROL_PATH = '/wm/v1/control';

const PROTOCOL = 'busybar-wm/control/v1';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  control: Control,
) {
  if (!authorized(req, token)) {
    return send(res, 401, {
      error: 'WM control requires a matching WM_API_TOKEN or a local connection',
    });
  }

  if (req.method === 'GET') {
    return send(res, 200, {
      protocol: PROTOCOL,
      ...control.status(),
      apps: control.apps(),
    });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Expected GET or POST' });
  }

  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return send(res, 415, { error: 'Expected application/json' });
  }

  let command: unknown;

  try {
    command = await readCommand(req);
  } catch {
    return send(res, 400, { error: 'Expected a JSON command of at most 4096 bytes' });
  }

  if (typeof command !== 'object' || command === null || !('action' in command)) {
    return send(res, 400, { error: 'Expected a control action' });
  }

  switch (command.action) {
    case 'switch': {
      if (!('app' in command) || typeof command.app !== 'string' || !command.app) {
        return send(res, 400, { error: 'Expected an app name' });
      }

      const outcome = control.switchApp(command.app);
      if (outcome === 'missing') {
        return send(res, 404, { error: 'App is absent from the WM manifest' });
      }
      if (outcome === 'unavailable') {
        return send(res, 409, { error: 'App has no frame to show' });
      }

      return send(res, 200, { pinned: command.app });
    }
    case 'auto':
      control.automatic();

      return send(res, 200, { mode: 'automatic' });
    case 'clear': {
      const display = 'display' in command ? command.display : undefined;
      if (display !== undefined && display !== 'front' && display !== 'back') {
        return send(res, 400, { error: 'Invalid display' });
      }

      control.clearOverlay(display);

      return send(res, 200, { cleared: true });
    }
    case 'message':
    case 'timer': {
      const { action: kind } = command;
      const display = 'display' in command ? command.display : undefined;
      const duration = 'durationSeconds' in command ? command.durationSeconds : undefined;
      const text = 'text' in command ? command.text : '';
      const limit = kind === 'timer' ? 86400 : 300;

      if (
        (display !== 'front' && display !== 'back') ||
        typeof text !== 'string' ||
        text.length > 120 ||
        !/^[ -~]*$/.test(text) ||
        (kind === 'message' && !text.trim()) ||
        typeof duration !== 'number' ||
        !Number.isInteger(duration) ||
        duration < 1 ||
        duration > limit
      ) {
        return send(res, 400, { error: 'Invalid display, text, or duration' });
      }

      const endsAt = Date.now() + duration * 1000;
      control.overlay({ kind, text, display, endsAt });

      return send(res, 202, {
        status: 'queued',
        display,
        endsAt: new Date(endsAt).toISOString(),
      });
    }
    case 'input': {
      const input = 'key' in command ? command.key : undefined;
      const delta = 'delta' in command ? command.delta : undefined;
      let events: InputEvent[];

      if ((input === 'ok' || input === 'start') && delta === undefined) {
        events = [
          { kind: 'button', button: input, action: 'press' },
          { kind: 'button', button: input, action: 'release' },
        ];
      } else if (
        input === 'encoder' &&
        typeof delta === 'number' &&
        Number.isInteger(delta) &&
        delta !== 0 &&
        Math.abs(delta) <= 10
      ) {
        if (control.knobReserved) {
          return send(res, 409, {
            error: 'The encoder is reserved by the window manager',
          });
        }

        events = [{ kind: 'encoder', delta }];
      } else {
        return send(res, 400, {
          error: 'Expected ok, start, or encoder with a nonzero delta from -10 to 10',
        });
      }

      const app = control.input(events);
      if (!app) {
        return send(res, 409, { error: 'No app is listening for this input' });
      }

      return send(res, 200, { deliveredTo: app });
    }
    default:
      return send(res, 400, { error: 'Unknown control action' });
  }
}

function authorized(req: IncomingMessage, token: string | undefined) {
  if (req.headers.origin) {
    return false;
  }

  if (token) {
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);

    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  const host = req.headers.host ?? '';

  return (
    LOOPBACK.has(req.socket.remoteAddress ?? '') &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
  );
}

async function readCommand(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;

    if (size > 4096) {
      req.resume();
      throw new Error('Command too large');
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

function send(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-busybar-wm-control': '1',
  });
  res.end(JSON.stringify(value));
}
