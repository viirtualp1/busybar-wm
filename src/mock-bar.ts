import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export type MockDraw = {
  at: number;
  application_name: string;
  priority?: number;
  elements?: unknown[];
  [key: string]: unknown;
};

export type MockBar = {
  url: string;
  port: number;
  draws: MockDraw[];
  clears: { at: number; application_name: string | null }[];
  assets: { application_name: string | null; file: string | null; size: number }[];
  /** Answer draws with the Bar's "something louder is on screen" 409. */
  lowPriority: boolean;
  /** What a real Bar would be showing: the last draw that was not cleared away. */
  showing: () => string | null;
  close: () => Promise<void>;
};

/**
 * A BUSY Bar that is not a BUSY Bar.
 *
 * The device is one of a kind and sits on someone's desk; the window manager
 * mostly needs to be certain that exactly one app's frames reach it, in the
 * right order, with the outgoing app cleared first. That is all checkable
 * against a server that writes down what it was asked to draw.
 */
export async function createMockBar(port = 0): Promise<MockBar> {
  const state: Pick<MockBar, 'draws' | 'clears' | 'assets' | 'lowPriority'> = {
    draws: [],
    clears: [],
    assets: [],
    lowPriority: false,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    const route = url.pathname.replace(/^\/api/, '');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (route === '/version') {
      return json(200, { api_semver: '1.0.0' });
    }

    if (route === '/status/system') {
      return json(200, { uptime: 1, heap_free: 1 });
    }

    if (route === '/display/draw' && req.method === 'DELETE') {
      state.clears.push({
        at: Date.now(),
        application_name: url.searchParams.get('application_name'),
      });

      return json(200, {});
    }

    if (route === '/display/draw' && req.method === 'POST') {
      if (state.lowPriority) {
        return json(409, { error: 'low priority' });
      }

      return void read(req).then((body) => {
        try {
          state.draws.push({
            at: Date.now(),
            ...(JSON.parse(body.toString()) as object),
          } as MockDraw);
        } catch {
          return json(400, { error: 'bad json' });
        }

        return json(200, {});
      });
    }

    if (route === '/assets/upload' && req.method === 'POST') {
      return void read(req).then((body) => {
        state.assets.push({
          application_name: url.searchParams.get('application_name'),
          file: url.searchParams.get('file'),
          size: body.length,
        });

        return json(200, {});
      });
    }

    json(404, { error: `no route ${route}` });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;

  return {
    draws: state.draws,
    clears: state.clears,
    assets: state.assets,
    get lowPriority() {
      return state.lowPriority;
    },
    set lowPriority(value: boolean) {
      state.lowPriority = value;
    },
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    showing() {
      const last = state.draws.at(-1);
      if (!last) {
        return null;
      }
      const clearedAfter = state.clears.some(
        (clear) =>
          clear.at >= last.at &&
          (clear.application_name === null ||
            clear.application_name === last.application_name),
      );

      return clearedAfter ? null : last.application_name;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bar = await createMockBar(Number(process.env['MOCK_PORT'] ?? 4110));
  console.log(`mock BUSY Bar on ${bar.url} — point BUSY_ADDR at it`);
  setInterval(() => {
    const showing = bar.showing();
    console.log(`[mock] ${bar.draws.length} draws, showing ${showing ?? 'nothing'}`);
  }, 5000);
}
