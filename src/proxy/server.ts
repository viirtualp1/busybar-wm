import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { errorMessage } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import { OWNER, rehome } from '../wm/canvas.js';
import type { Logger } from '../wm/compositor.js';
import { DISPLAY_PATH } from '../protocol/messages.js';
import type { DisplayServer } from '../protocol/server.js';
import type { Scene } from '../wm/scene.js';
import { PLACEHOLDER_CREDENTIAL } from '../wm/supervisor.js';
import { legacyClear, legacyDraw, type DrawPayload } from './legacy.js';
import { tunnel } from './tunnel.js';

export type ProxyOptions = {
  host: string;
  port: number;
  upstream: Upstream;
  scene: Scene;
  logger?: Logger;
  /**
   * Local `/wm` config API + UI. Checked before device pass-through; must never
   * be forwarded to the Bar.
   */
  /** The display socket, answered here rather than tunnelled to the Bar. */
  display?: DisplayServer;
  /** The deck answers `/deck` before anything is forwarded to the device. */
  deck?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * How long a forwarded request may sit with no traffic before it is given
   * up on. An idle limit rather than a total one, so a slow upload that keeps
   * moving is left alone.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

class UpstreamTimeout extends Error {
  constructor() {
    super('the Bar did not answer in time');
  }
}

/** The API prefixes the Bar mounts itself under, local and cloud. */
const PREFIXES = ['/api', '/busybar'];
const DRAW_PATH = '/display/draw';
const ASSETS_PATH = '/assets/upload';
const AUDIO_PATH = '/audio/play';
const MAX_BODY = 4 * 1024 * 1024;

/**
 * A BUSY Bar, as far as every app is concerned.
 *
 * Apps point `BUSY_ADDR` here instead of at the device. Draws are answered from
 * this process — the app is told its frame landed, and it did, in the scene —
 * while everything else, asset uploads and the status socket included, is piped
 * straight through to the hardware. That asymmetry is the whole trick: an app
 * off screen keeps uploading its cover art and keeps believing it is drawing,
 * so the moment it wins the screen its last frame is replayable as-is.
 */
export class ProxyServer {
  private readonly server: Server;
  private readonly logger: Logger;
  private warnedGlobalClear = false;
  private warnedAssetDelete = false;

  constructor(private readonly options: ProxyOptions) {
    this.logger = options.logger ?? console;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.fail(res, `proxy: ${errorMessage(error)}`);
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (this.options.display?.handles(req)) {
        this.options.display.upgrade(req, socket, head);

        return;
      }
      tunnel(req, socket, head, this.options.upstream, this.rewrite.bind(this)).catch(
        (error: unknown) => {
          this.logger.warn(`[proxy] socket upgrade failed: ${errorMessage(error)}`);
          socket.destroy();
        },
      );
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  /** The port actually bound, which matters when the config asked for 0. */
  get port(): number {
    const address = this.server.address();

    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');

    if (this.options.deck && (await this.options.deck(req, res))) {
      return;
    }

    if (url.pathname === DISPLAY_PATH) {
      res.writeHead(426, { 'content-type': 'application/json', upgrade: 'websocket' });
      res.end(JSON.stringify({ error: 'the display protocol is a WebSocket' }));

      return;
    }

    const route = strip(url.pathname);

    if (route === DRAW_PATH && req.method === 'POST') {
      return await this.onDraw(req, res);
    }
    if (route === DRAW_PATH && req.method === 'DELETE') {
      return await this.onClear(req, url, res);
    }
    if (route === ASSETS_PATH && req.method === 'DELETE') {
      return this.onAssetsDelete(url, res);
    }
    if (route === ASSETS_PATH) {
      rehomeUpload(url);
    }
    if (route === AUDIO_PATH && req.method === 'POST') {
      return await this.onAudio(req, res, url);
    }

    this.passThrough(req, res, url);
  }

  private async onDraw(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let payload: DrawPayload;
    try {
      payload = JSON.parse(body.toString('utf8')) as DrawPayload;
    } catch {
      // Not something this proxy understands well enough to arbitrate. The
      // device can have it and say what it thinks.
      return this.passThroughBody(
        req,
        res,
        new URL(req.url ?? '/', 'http://proxy.invalid'),
        body,
      );
    }

    if (typeof payload.application_name !== 'string' || !payload.application_name) {
      return this.passThroughBody(
        req,
        res,
        new URL(req.url ?? '/', 'http://proxy.invalid'),
        body,
      );
    }

    legacyDraw(this.options.scene, payload);
    ok(res);
  }

  private async onClear(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    // The device takes the name in the query or in a JSON body, and a body may
    // name only some elements.
    let body: { application_name?: unknown; element_ids?: unknown } = {};
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as typeof body;
      } catch {
        body = {};
      }
    }
    const fromBody =
      typeof body.application_name === 'string' ? body.application_name : null;
    const name = url.searchParams.get('application_name') || fromBody;
    const ids = Array.isArray(body.element_ids)
      ? body.element_ids.filter((id): id is string => typeof id === 'string')
      : undefined;

    if (!name) {
      // Under the window manager an app only ever speaks for itself, and a
      // clear with no name would take the screen from whoever holds it.
      if (!this.warnedGlobalClear) {
        this.logger.warn('[proxy] ignoring a clear that names no application');
        this.warnedGlobalClear = true;
      }

      return ok(res);
    }

    legacyClear(this.options.scene, name, ids);
    ok(res);
  }

  /**
   * An app clearing out its uploads. They live in a folder of `OWNER`'s now,
   * and the device can only delete an application's folder whole — which would
   * take every other app's covers with it. So the request is answered here and
   * the files are left; nothing draws them once the app stops naming them.
   */
  private onAssetsDelete(url: URL, res: ServerResponse): void {
    const name = url.searchParams.get('application_name');
    if (!this.warnedAssetDelete) {
      this.logger.info(
        `[proxy] ${name ?? 'an app'} asked to delete its assets; kept, since they share one folder on the Bar`,
      );
      this.warnedAssetDelete = true;
    }
    ok(res);
  }

  /** A sound an app uploaded lives where its images do, under `OWNER`. */
  private async onAudio(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return this.passThroughBody(req, res, url, raw);
    }

    const name = body['application_name'];
    const path = body['path'];
    if (typeof name !== 'string' || typeof path !== 'string') {
      return this.passThroughBody(req, res, url, raw);
    }

    const rewritten = Buffer.from(
      JSON.stringify({ ...body, application_name: OWNER, path: rehome(name, path) }),
    );
    this.passThroughBody(req, res, url, rewritten);
  }

  private passThrough(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const proxied = this.open(req, res, url, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    req.pipe(proxied);
  }

  private passThroughBody(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: Buffer,
  ): void {
    const proxied = this.open(
      req,
      res,
      url,
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
      body.length,
    );
    proxied.end(body);
  }

  private open(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    onResponse: (res: IncomingMessage) => void,
    bodyLength?: number,
  ) {
    const target = this.rewrite(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = this.forwardHeaders(req, target);
    if (bodyLength !== undefined) {
      headers['content-length'] = String(bodyLength);
      delete headers['transfer-encoding'];
    }
    const proxied = send(
      target,
      {
        method: req.method ?? 'GET',
        headers,
      },
      onResponse,
    );
    // A Bar that stops answering would otherwise hold this request, and its
    // socket, for as long as TCP cares to wait — one more for every retry.
    proxied.setTimeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      proxied.destroy(new UpstreamTimeout());
    });

    proxied.on('error', (error) => {
      this.logger.warn(`[proxy] ${target.pathname}: ${errorMessage(error)}`);
      proxied.destroy();
      // The app is told, rather than left waiting out its own timeout.
      if (res.headersSent) {
        res.destroy();

        return;
      }
      const timedOut = error instanceof UpstreamTimeout;
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: errorMessage(error) }));
    });

    // The app gave up first — its own timeout, or it exited. Nobody is left to
    // read the answer, so the request to the Bar goes too.
    res.on('close', () => {
      if (!res.writableFinished) {
        proxied.destroy();
      }
    });

    return proxied;
  }

  /**
   * Same path, the upstream's prefix. A local Bar mounts the API at `/api`, the
   * cloud at `/busybar`, and an app pointed at this proxy resolved the prefix
   * from *this* address rather than from the real one.
   */
  rewrite(url: URL): URL {
    const base = this.options.upstream.base;
    const target = new URL(base.origin);
    target.pathname = base.pathname.replace(/\/$/, '') + strip(url.pathname);
    target.search = url.search;

    return target;
  }

  /**
   * The daemon holds the Bar's credentials so the apps behind it do not have
   * to; whatever an app sends is replaced when the daemon has its own.
   */
  private forwardHeaders(req: IncomingMessage, target: URL): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key === 'host' || key === 'connection') {
        continue;
      }
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers['host'] = target.host;

    const own = this.options.upstream.headers();
    if (own['authorization'] || own['x-api-token']) {
      delete headers['authorization'];
      delete headers['x-api-token'];
      Object.assign(headers, own);
    } else if (headers['x-api-token'] === PLACEHOLDER_CREDENTIAL) {
      delete headers['x-api-token'];
    }

    return headers;
  }

  private fail(res: ServerResponse, message: string): void {
    this.logger.warn(`[proxy] ${message}`);
    if (res.headersSent) {
      res.destroy();

      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

/** Drops whichever API prefix the caller used, leaving the route itself. */
export function strip(pathname: string): string {
  for (const prefix of PREFIXES) {
    if (pathname === prefix) {
      return '/';
    }
    if (pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length);
    }
  }

  return pathname;
}

/**
 * An upload, moved into `OWNER`'s folder: the app's draws are drawn as `OWNER`,
 * and an image's path resolves inside the drawing application's folder.
 */
export function rehomeUpload(url: URL): void {
  const name = url.searchParams.get('application_name');
  const file = url.searchParams.get('file');
  if (!name || !file || name === OWNER) {
    return;
  }
  url.searchParams.set('application_name', OWNER);
  url.searchParams.set('file', rehome(name, file));
}

function ok(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('draw body too large'));
        req.destroy();

        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
