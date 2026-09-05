import { BarApiError } from 'busybar-kit/errors';
import { isCloudAddr } from 'busybar-kit/config';
import type { DrawPayload } from '../wm/registry.js';

export type UpstreamOptions = {
  addr: string;
  token?: string;
  httpPassword?: string;
  timeoutMs?: number;
};

/**
 * The one connection that actually reaches the hardware.
 *
 * busy-lib's client would do, but the window manager already has to speak the
 * wire protocol to proxy it, and its own draws carry `led_notification_color`,
 * which the generated `DisplayDraw` helper drops. Sixty lines of fetch keeps
 * `@busy-app/busy-lib` a devDependency: the daemon is a proxy, not a client.
 */
export class Upstream {
  readonly base: URL;
  private semver = '';
  private versionInFlight: Promise<void> | null = null;

  constructor(private readonly options: UpstreamOptions) {
    this.base = baseUrl(options.addr);
  }

  /** Headers every request but `/version` carries. */
  headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.options.token) {
      headers['authorization'] = `Bearer ${this.options.token}`;
    }
    if (this.options.httpPassword) {
      headers['x-api-token'] = this.options.httpPassword;
    }
    if (this.semver) {
      headers['x-api-sem-ver'] = this.semver;
    }

    return headers;
  }

  url(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(this.base.pathname.replace(/\/$/, '') + path, this.base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    return url;
  }

  async ping(): Promise<void> {
    await this.request('GET', this.url('/status/system'));
  }

  async draw(payload: DrawPayload): Promise<void> {
    await this.request('POST', this.url('/display/draw'), {
      body: JSON.stringify(payload),
      contentType: 'application/json',
    });
  }

  async clear(applicationName?: string): Promise<void> {
    await this.request(
      'DELETE',
      this.url('/display/draw', { application_name: applicationName }),
    );
  }

  /**
   * The device rejects a request carrying the wrong `X-API-Sem-Ver` with a 405,
   * so the version is fetched lazily and refreshed once on that answer — the
   * same dance busy-lib's middleware does.
   */
  private async request(
    method: string,
    url: URL,
    init: { body?: string; contentType?: string } = {},
    retried = false,
  ): Promise<unknown> {
    await this.ensureVersion();

    const headers = this.headers();
    if (init.contentType) {
      headers['content-type'] = init.contentType;
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });

    if (response.ok) {
      return await readBody(response);
    }

    if (response.status === 405 && !retried) {
      this.semver = '';

      return await this.request(method, url, init, true);
    }

    throw new BarApiError(
      `BUSY Bar responded ${response.status}: ${await describe(response)}`,
      response.status,
      undefined,
    );
  }

  private async ensureVersion(): Promise<void> {
    if (this.semver) {
      return;
    }
    this.versionInFlight ??= (async () => {
      const response = await fetch(this.url('/version'), {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        throw new BarApiError(
          `BUSY Bar version check failed: ${response.status}`,
          response.status,
          undefined,
        );
      }
      const body = (await response.json()) as { api_semver?: string };
      if (!body.api_semver) {
        throw new BarApiError('BUSY Bar returned an empty API version', undefined, body);
      }
      this.semver = body.api_semver;
    })().finally(() => {
      this.versionInFlight = null;
    });

    await this.versionInFlight;
  }
}

/**
 * `10.0.4.20` and `http://10.0.4.20` are the same Bar; `api.busy.app` is the
 * cloud, which mounts the same API under a different prefix.
 */
export function baseUrl(addr: string): URL {
  const url = new URL(/^https?:\/\//i.test(addr) ? addr : `http://${addr}`);
  url.pathname = isCloudAddr(addr) ? '/busybar' : '/api';

  return url;
}

async function readBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';

  return type.includes('application/json')
    ? await response.json()
    : await response.text();
}

async function describe(response: Response): Promise<string> {
  try {
    const body = await response.text();

    return body.slice(0, 200) || response.statusText;
  } catch {
    return response.statusText;
  }
}
