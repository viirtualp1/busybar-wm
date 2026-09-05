import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Upstream } from '../bar/upstream.js';

/**
 * The status socket, passed through byte for byte.
 *
 * `ws://<bar>/api/status/ws` carries frames the window manager has no reason to
 * read on an app's behalf — it opens its own socket for the knob. So rather
 * than terminate the WebSocket and re-frame it, this replays the upgrade
 * request at the device and joins the two sockets together.
 */
export async function tunnel(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  upstream: Upstream,
  rewrite: (url: URL) => URL,
): Promise<void> {
  const target = rewrite(new URL(req.url ?? '/', 'http://proxy.invalid'));
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));

  // Apps behind the proxy send a dummy token; replace it so the device
  // does not close the socket on the placeholder.
  stampCredential(target, upstream);

  const server = secure
    ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
    : netConnect({ host: target.hostname, port });

  await once(server, secure ? 'secureConnect' : 'connect');

  server.write(upgradeRequest(req, target));
  if (head.length > 0) {
    server.write(head);
  }

  client.pipe(server);
  server.pipe(client);

  const shutdown = (): void => {
    client.destroy();
    server.destroy();
  };
  client.on('error', shutdown);
  server.on('error', shutdown);
  client.on('close', shutdown);
  server.on('close', shutdown);
}

const SKIP_HEADERS = new Set(['host', 'authorization', 'x-api-token']);

/** The original request line and headers, pointed at the device. */
function upgradeRequest(req: IncomingMessage, target: URL): string {
  const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || SKIP_HEADERS.has(key)) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${key}: ${item}`);
    }
  }
  const token = target.searchParams.get('x-api-token');
  if (token) {
    lines.push(`x-api-token: ${token}`);
  }
  lines.push(`host: ${target.host}`, '', '');

  return lines.join('\r\n');
}

export function stampCredential(target: URL, upstream: Upstream): void {
  const credential =
    upstream.headers()['x-api-token'] ?? upstream.headers()['authorization'];
  if (!credential) {
    return;
  }
  target.searchParams.set('x-api-token', credential.replace(/^Bearer /i, ''));
}
