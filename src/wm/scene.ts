import type { AppManifest } from '../manifest.js';

/** One element of a frame, as an app wrote it. Passed on to the device intact. */
export type Element = {
  id: string;
  type?: string;
  display?: string;
  [key: string]: unknown;
};

/** What a surface shows: its elements, and the app's own say in how badly. */
export type Frame = {
  elements: Element[];
  priority: number;
  led?: string;
};

/**
 * How badly a surface wants the screen, said by the app rather than read off
 * its traffic. `idle` keeps a frame current without asking for the screen: it is
 * shown only when nothing else wants it. `urgent` may interrupt a hold.
 */
export type WantLevel = 'idle' | 'normal' | 'urgent';

export const WANT_LEVELS: readonly WantLevel[] = ['idle', 'normal', 'urgent'];

export type SurfaceState = {
  name: string;
  /** The last frame committed, replayed whenever its client wins the screen back. */
  frame: Frame | null;
  frameKey: string;
  want: WantLevel;
};

export type ClientState = {
  name: string;
  rank: number;
  /** False for an app that turned up on the socket without a manifest. */
  managed: boolean;
  /** Only meaningful for a managed app: whether its process is up. */
  running: boolean;
  surfaces: Map<string, SurfaceState>;
  /** The highest `priority` across its frames — an app's own say in how badly it wants the screen. */
  priority: number;
  /** The strongest `want` across the surfaces that have a frame. */
  want: WantLevel;
  /** Whether it has a session open on the display socket: alive for as long as it does. */
  connected: boolean;
  lastDrawAt: number;
  /** When it last handed a surface back. */
  yieldedAt: number;
};

export type SceneOptions = {
  /**
   * How long an *unmanaged* app's last frame stays believable. Apps redraw only
   * when something changed, so silence is not idleness — but a hand-started app
   * that got killed would otherwise hold the screen forever. A supervised app
   * needs none of this: its process either exists or it does not.
   */
  staleMs: number;
  onChange?: () => void;
};

export const DEFAULT_PRIORITY = 50;
export const UNMANAGED_RANK = 0;

/**
 * Every app the window manager knows of, and the surfaces each one draws into.
 *
 * A plain state machine on purpose: who wants the screen, and with what, is all
 * here, and none of it needs a device, a socket or a clock to be tested. An app
 * behind the proxy has a single surface, which its draws fill and its DELETE
 * empties — see `proxy/legacy.ts`.
 */
export class Scene {
  private readonly clients = new Map<string, ClientState>();

  constructor(
    manifests: AppManifest[],
    private readonly options: SceneOptions,
  ) {
    for (const manifest of manifests) {
      this.clients.set(manifest.name, fresh(manifest));
    }
  }

  /**
   * An app written into the manifest while the daemon runs.
   *
   * One that already drew as a stranger keeps its frames and gains the rank it
   * was given, so installing an app that is already running by hand does not
   * blank it.
   */
  add(manifest: AppManifest): void {
    const existing = this.clients.get(manifest.name);
    if (existing) {
      existing.rank = manifest.rank;
      existing.managed = Boolean(manifest.command);
    } else {
      this.clients.set(manifest.name, fresh(manifest));
    }
    this.options.onChange?.();
  }

  /** An app taken out of the manifest. Whatever it last drew goes with it. */
  remove(name: string): void {
    if (this.clients.delete(name)) {
      this.options.onChange?.();
    }
  }

  /** A new place in the queue for the screen. */
  setRank(name: string, rank: number): void {
    const client = this.clients.get(name);
    if (!client || client.rank === rank) {
      return;
    }
    client.rank = rank;
    this.options.onChange?.();
  }

  all(): ClientState[] {
    return [...this.clients.values()];
  }

  get(name: string): ClientState | undefined {
    return this.clients.get(name);
  }

  /** The surfaces of one app that have something to show, by name. */
  visible(name: string): SurfaceState[] {
    const client = this.clients.get(name);
    if (!client) {
      return [];
    }

    return [...client.surfaces.values()]
      .filter((surface) => surface.frame)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  commit(name: string, surfaceName: string, frame: Frame, at = Date.now()): void {
    const client = this.ensure(name);
    const surface = ensureSurface(client, surfaceName);
    const key = JSON.stringify(frame);
    const changed = key !== surface.frameKey;

    surface.frame = frame;
    surface.frameKey = key;
    settle(client);
    client.lastDrawAt = at;

    // A repeated identical frame is still proof of life, but there is nothing
    // downstream to redo for it.
    if (changed) {
      this.options.onChange?.();
    }
  }

  release(name: string, surfaceName: string, at = Date.now()): void {
    const client = this.ensure(name);
    const surface = client.surfaces.get(surfaceName);
    if (!surface?.frame) {
      return;
    }
    surface.frame = null;
    surface.frameKey = '';
    settle(client);
    client.yieldedAt = at;
    this.options.onChange?.();
  }

  setWant(name: string, surfaceName: string, want: WantLevel): void {
    const client = this.ensure(name);
    const surface = ensureSurface(client, surfaceName);
    if (surface.want === want) {
      return;
    }
    surface.want = want;
    const before = client.want;
    settle(client);
    // Only a surface with a frame counts towards the screen.
    if (surface.frame || before !== client.want) {
      this.options.onChange?.();
    }
  }

  /** A surface the app is done with: its frame and its name both go. */
  drop(name: string, surfaceName: string): void {
    const client = this.clients.get(name);
    const surface = client?.surfaces.get(surfaceName);
    if (!client || !surface) {
      return;
    }
    client.surfaces.delete(surfaceName);
    settle(client);
    if (surface.frame) {
      this.options.onChange?.();
    }
  }

  /** A session opened on the display socket. */
  connect(name: string): void {
    this.ensure(name).connected = true;
  }

  /**
   * The session closed: the app is gone as far as the screen is concerned, and
   * so is everything it drew over the socket. Its other surfaces — the proxy's —
   * are not the socket's to take.
   */
  disconnect(name: string, surfaces: Iterable<string>): void {
    const client = this.clients.get(name);
    if (!client) {
      return;
    }
    client.connected = false;
    let changed = false;
    for (const surfaceName of surfaces) {
      changed = Boolean(client.surfaces.get(surfaceName)?.frame) || changed;
      client.surfaces.delete(surfaceName);
    }
    settle(client);
    if (changed) {
      this.options.onChange?.();
    }
  }

  setRunning(name: string, running: boolean): void {
    const client = this.clients.get(name);
    if (!client || client.running === running) {
      return;
    }
    client.running = running;
    // A process that died cannot be showing anything, whatever it drew last.
    if (!running) {
      for (const surface of client.surfaces.values()) {
        surface.frame = null;
        surface.frameKey = '';
      }
      settle(client);
    }
    this.options.onChange?.();
  }

  /** The apps with something to show right now, in no particular order. */
  candidates(now = Date.now()): ClientState[] {
    return this.all().filter((client) => {
      if (![...client.surfaces.values()].some((surface) => surface.frame)) {
        return false;
      }

      // An open session is proof of life by itself; that is what the socket
      // is for. Without one, the old rules.
      if (client.connected) {
        return true;
      }

      return client.managed
        ? client.running
        : now - client.lastDrawAt <= this.options.staleMs;
    });
  }

  /**
   * An app nobody wrote a manifest for is not an error — the Bar's own apps and
   * anything started by hand draw too. It joins at rank zero.
   */
  private ensure(name: string): ClientState {
    const existing = this.clients.get(name);
    if (existing) {
      return existing;
    }

    const client = fresh({ name, rank: UNMANAGED_RANK });
    this.clients.set(name, client);

    return client;
  }
}

function fresh(manifest: Pick<AppManifest, 'name' | 'rank' | 'command'>): ClientState {
  return {
    name: manifest.name,
    rank: manifest.rank,
    managed: Boolean(manifest.command),
    running: false,
    surfaces: new Map(),
    priority: DEFAULT_PRIORITY,
    want: 'normal',
    connected: false,
    lastDrawAt: 0,
    yieldedAt: 0,
  };
}

function ensureSurface(client: ClientState, name: string): SurfaceState {
  const existing = client.surfaces.get(name);
  if (existing) {
    return existing;
  }
  const surface: SurfaceState = { name, frame: null, frameKey: '', want: 'normal' };
  client.surfaces.set(name, surface);

  return surface;
}

/** A client's priority and want, worked out again from the surfaces it is showing. */
function settle(client: ClientState): void {
  const showing = [...client.surfaces.values()].filter((surface) => surface.frame);
  client.priority =
    showing.length > 0
      ? Math.max(...showing.map((surface) => surface.frame?.priority ?? DEFAULT_PRIORITY))
      : DEFAULT_PRIORITY;
  client.want =
    WANT_LEVELS[
      Math.max(-1, ...showing.map((surface) => WANT_LEVELS.indexOf(surface.want)))
    ] ?? 'normal';
}
