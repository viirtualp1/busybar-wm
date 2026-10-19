import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export type MockDraw = {
  at: number;
  application_name: string;
  priority?: number;
  elements?: unknown[];
  [key: string]: unknown;
};

export type MockElement = {
  id: string;
  type?: string;
  display?: string;
  [key: string]: unknown;
};

export type MockBar = {
  url: string;
  port: number;
  draws: MockDraw[];
  clears: { at: number; application_name: string | null; element_ids?: string[] }[];
  assets: { application_name: string | null; file: string | null; size: number }[];
  sounds: Record<string, unknown>[];
  /** Answer draws with the Bar's "something louder is on screen" 409. */
  lowPriority: boolean;
  /** What the canvas holds right now, by element id. */
  canvas: Map<string, MockElement>;
  /** The application the canvas belongs to, if anything is on it. */
  showing: () => string | null;
  /** What a short BACK does on the real device: the canvas closes, whatever was on it. */
  drop: () => void;
  close: () => Promise<void>;
};

/** The device's own limit, counting what persists from earlier draws. */
const MAX_ELEMENTS = 100;

/**
 * A BUSY Bar that is not a BUSY Bar.
 *
 * The device is one of a kind and sits on someone's desk. What the window
 * manager has to get right is how its canvas behaves, so that is what this
 * keeps, as measured on a real one (API 27.14.0):
 *
 * - one application owns the canvas; another takes it only with a strictly
 *   higher priority, and then everything the old owner had is gone
 * - a draw is an upsert by element id, and an id cannot change type or panel
 * - a DELETE clears the owner's canvas, or only the `element_ids` it names —
 *   all of which must exist
 * - at most a hundred elements on the canvas in total
 */
export async function createMockBar(port = 0): Promise<MockBar> {
  const state: Pick<MockBar, 'draws' | 'clears' | 'assets' | 'sounds' | 'lowPriority'> = {
    draws: [],
    clears: [],
    assets: [],
    sounds: [],
    lowPriority: false,
  };
  const canvas = new Map<string, MockElement>();
  let owner: string | null = null;
  let ownerPriority = 0;

  const close = (): void => {
    canvas.clear();
    owner = null;
    ownerPriority = 0;
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
      return void read(req).then((raw) => {
        let body: { application_name?: string; element_ids?: string[] } = {};
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString()) as typeof body;
          } catch {
            return json(400, { error: 'body contains malformed JSON' });
          }
        }
        const name =
          url.searchParams.get('application_name') ?? body.application_name ?? null;
        const ids = body.element_ids;
        state.clears.push({
          at: Date.now(),
          application_name: name,
          ...(ids ? { element_ids: ids } : {}),
        });

        if (!owner) {
          return ids
            ? json(400, { error: 'one of element_ids is non-existent' })
            : json(200, { result: 'OK' });
        }
        if (name && name !== owner) {
          return json(400, {
            error: 'this application_name is currently not displaying anything',
          });
        }
        if (ids) {
          if (!ids.every((id) => canvas.has(id))) {
            return json(400, { error: 'one of element_ids is non-existent' });
          }
          for (const id of ids) {
            canvas.delete(id);
          }
          if (canvas.size === 0) {
            close();
          }
        } else {
          close();
        }

        return json(200, { result: 'OK' });
      });
    }

    if (route === '/display/draw' && req.method === 'POST') {
      if (state.lowPriority) {
        return json(409, { error: 'Not drawn due to low priority' });
      }

      return void read(req).then((raw) => {
        let draw: MockDraw;
        try {
          draw = {
            at: Date.now(),
            ...(JSON.parse(raw.toString()) as object),
          } as MockDraw;
        } catch {
          return json(400, { error: 'bad json' });
        }
        const priority = draw.priority ?? 50;
        const elements = (draw.elements ?? []) as MockElement[];
        if (elements.length === 0) {
          return json(400, { error: 'Nothing to display' });
        }
        const sameOwner = owner === draw.application_name;
        if (owner && (sameOwner ? priority < ownerPriority : priority <= ownerPriority)) {
          return json(409, { error: 'Not drawn due to low priority' });
        }

        state.draws.push(draw);
        if (!sameOwner) {
          canvas.clear();
          owner = draw.application_name;
        }
        ownerPriority = priority;
        for (const element of elements) {
          const held = canvas.get(element.id);
          if (
            held &&
            (held.type !== element.type ||
              (held.display ?? 'front') !== (element.display ?? 'front'))
          ) {
            return json(400, { error: 'Unspecified request error' });
          }
          canvas.set(element.id, element);
          if (canvas.size > MAX_ELEMENTS) {
            return json(400, { error: 'Elements number limit exceeded' });
          }
        }

        return json(200, { result: 'OK' });
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

    if (route === '/audio/play' && req.method === 'POST') {
      return void read(req).then((body) => {
        state.sounds.push(JSON.parse(body.toString()) as Record<string, unknown>);

        return json(200, { result: 'OK' });
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
    sounds: state.sounds,
    canvas,
    get lowPriority() {
      return state.lowPriority;
    },
    set lowPriority(value: boolean) {
      state.lowPriority = value;
    },
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    showing() {
      return owner;
    },
    drop: close,
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
    console.log(
      `[mock] ${bar.draws.length} draws, ${bar.canvas.size} elements of ${showing ?? 'nobody'}`,
    );
  }, 5000);
}
