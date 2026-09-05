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
import type { DrawPayload, Registry } from '../wm/registry.js';
import type { Logger } from '../wm/compositor.js';
import { tunnel } from './tunnel.js';

export type ProxyOptions = {
  host: string;
  port: number;
  upstream: Upstream;
  registry: Registry;
  logger?: Logger;
};

/** The API prefixes the Bar mounts itself under, local and cloud. */
const PREFIXES = ['/api', '/busybar'];
const DRAW_PATH = '/display/draw';
const MAX_BODY = 4 * 1024 * 1024;

/**
 * A BUSY Bar, as far as every app is concerned.
 *
 * Apps point `BUSY_ADDR` here instead of at the device. Draws are answered from
 * this process — the app is told its frame landed, and it did, in the registry —
 * while everything else, asset uploads and the status socket included, is piped
 * straight through to the hardware. That asymmetry is the whole trick: an app
 * off screen keeps uploading its cover art and keeps believing it is drawing,
 * so the moment it wins the screen its last frame is replayable as-is.
 */
export class ProxyServer {
  private readonly server: Server;
  private readonly logger: Logger;
  private warnedGlobalClear = false;

  constructor(private readonly options: ProxyOptions) {
    this.logger = options.logger ?? console;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.fail(res, `proxy: ${errorMessage(error)}`);
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
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
    const route = strip(url.pathname);

    if (route === DRAW_PATH && req.method === 'POST') {
      return await this.onDraw(req, res);
    }
    if (route === DRAW_PATH && req.method === 'DELETE') {
      return this.onClear(url, res);
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

    this.options.registry.draw(payload);
    ok(res);
  }

  private onClear(url: URL, res: ServerResponse): void {
    const name = url.searchParams.get('application_name');
    if (!name) {
      // Under the window manager an app only ever speaks for itself, and a
      // clear with no name would take the screen from whoever holds it.
      if (!this.warnedGlobalClear) {
        this.logger.warn('[proxy] ignoring a clear that names no application');
        this.warnedGlobalClear = true;
      }

      return ok(res);
    }

    this.options.registry.clear(name);
    ok(res);
  }

  private passThrough(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const proxied = this.open(req, url, (upstreamRes) => {
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
    const proxied = this.open(req, url, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    proxied.end(body);
  }

  private open(
    req: IncomingMessage,
    url: URL,
    onResponse: (res: IncomingMessage) => void,
  ) {
    const target = this.rewrite(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const proxied = send(
      target,
      {
        method: req.method ?? 'GET',
        headers: this.forwardHeaders(req, target),
      },
      onResponse,
    );
    proxied.on('error', (error) => {
      this.logger.warn(`[proxy] ${target.pathname}: ${errorMessage(error)}`);
      proxied.destroy();
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
