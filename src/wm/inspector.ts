import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { errorMessage } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import type { Logger } from './compositor.js';
import { isLocal } from './control.js';
import type { Events, WmEvent } from './events.js';

export type ScreenMirrorOptions = {
  upstream: Upstream;
  events: Events;
  intervalMs: number;
  logger: Logger;
};

export const EVENTS_PATH = '/wm/v1/events';
export const INSPECTOR_PATH = '/inspector';

/** A proxy in between would otherwise close a stream that has been quiet for a minute. */
const KEEPALIVE_MS = 15_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * `GET /wm/v1/events`: every event as a server-sent event, after the latest
 * mode, decision and screen, so a page opened halfway through is not blank.
 *
 * Local only, like the control API: the stream carries every frame every app
 * draws, and nothing on the network needs it.
 */
export function handleEvents(req: IncomingMessage, res: ServerResponse, events: Events) {
  if (!isLocal(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'the event stream is for local pages only' }));

    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const send = (event: WmEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of events.snapshot()) {
    send(event);
  }

  const unsubscribe = events.subscribe(send);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);

  keepalive.unref();
  res.on('close', () => {
    unsubscribe();
    clearInterval(keepalive);
  });
}

/**
 * The inspector page, a build of busybar-inspector, under `/inspector/`.
 * Opened bare, it is sent to its live view of this window manager.
 */
export async function serveInspector(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string | null,
) {
  const url = new URL(req.url ?? '/', 'http://wm.invalid');

  if (
    (url.pathname === INSPECTOR_PATH || url.pathname === `${INSPECTOR_PATH}/`) &&
    !url.search
  ) {
    res.writeHead(302, { location: `${INSPECTOR_PATH}/?source=live` });
    res.end();

    return;
  }

  if (url.pathname === INSPECTOR_PATH) {
    res.writeHead(302, { location: `${INSPECTOR_PATH}/${url.search}` });
    res.end();

    return;
  }

  if (!dir) {
    return notFound(
      res,
      'no inspector here: build busybar-inspector and set WM_INSPECTOR_DIR to its dist folder',
    );
  }

  const file = within(dir, url.pathname.slice(INSPECTOR_PATH.length + 1) || 'index.html');

  if (!file) {
    return notFound(res, 'not found');
  }

  try {
    const found = await stat(file);
    const path = found.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(path);

    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      // A rebuild between rehearsals must show up on a reload.
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    notFound(res, 'not found');
  }
}

/** A path inside `dir`, or null for one that tries to leave it. */
function within(dir: string, path: string) {
  let decoded: string;

  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  const root = normalize(dir);
  const file = normalize(join(root, decoded));

  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep)
    ? file
    : null;
}

function notFound(res: ServerResponse, message: string) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * The Bar's front panel, read back from the device while a page is watching,
 * and sent on whenever it changed.
 *
 * It is the device's own capture, not the window manager's idea of it — which
 * is the point when two apps are fighting over the screen.
 */
export class ScreenMirror {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private last = '';
  private failing = false;

  constructor(private readonly options: ScreenMirrorOptions) {}

  start() {
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll() {
    const { events, upstream, logger } = this.options;

    if (this.busy || !events.listening) {
      if (!events.listening) {
        this.last = '';
      }

      return;
    }

    this.busy = true;

    try {
      const { body } = await upstream.screen(0);
      const data = body.trim();

      this.failing = false;

      if (data !== this.last) {
        this.last = data;
        events.emit({ type: 'screen', data });
      }
    } catch (error) {
      if (!this.failing) {
        logger.warn(
          `[wm] could not read the Bar's screen for the inspector: ${errorMessage(error)}`,
        );
        this.failing = true;
      }
    } finally {
      this.busy = false;
    }
  }
}
