import type { AppManifest } from '../manifest.js';

/** A `/display/draw` body, as an app sent it. Passed on to the device intact. */
export type DrawPayload = {
  application_name: string;
  priority?: number;
  elements?: unknown[];
  led_notification_color?: string;
  [key: string]: unknown;
};

export type AppState = {
  name: string;
  rank: number;
  /** False for an app that turned up on the socket without a manifest. */
  managed: boolean;
  /** Only meaningful for a managed app: whether its process is up. */
  running: boolean;
  /** The last frame it drew, replayed whenever it wins the screen back. */
  frame: DrawPayload | null;
  frameKey: string;
  /** The `priority` on that frame — an app's own say in how badly it wants the screen. */
  priority: number;
  lastDrawAt: number;
  /** When it last handed the screen back with a DELETE. */
  yieldedAt: number;
};

export type RegistryOptions = {
  /**
   * How long an *unmanaged* app's last frame stays believable. Apps redraw only
   * when something changed, so silence is not idleness — but a hand-started app
   * that got killed would otherwise hold the screen forever. A supervised app
   * needs none of this: its process either exists or it does not.
   */
  staleMs: number;
  onChange?: () => void;
};

const DEFAULT_PRIORITY = 50;
export const UNMANAGED_RANK = 0;

/**
 * Who wants the screen, learned entirely from the traffic passing through.
 *
 * Nothing here asks an app anything. Drawing is the request, and the DELETE
 * every app already sends when it has nothing to show is the release — which is
 * why existing apps needed no changes to take part.
 */
export class Registry {
  private readonly apps = new Map<string, AppState>();

  constructor(
    manifests: AppManifest[],
    private readonly options: RegistryOptions,
  ) {
    for (const manifest of manifests) {
      this.apps.set(manifest.name, {
        name: manifest.name,
        rank: manifest.rank,
        managed: Boolean(manifest.command),
        running: false,
        frame: null,
        frameKey: '',
        priority: DEFAULT_PRIORITY,
        lastDrawAt: 0,
        yieldedAt: 0,
      });
    }
  }

  all(): AppState[] {
    return [...this.apps.values()];
  }

  get(name: string): AppState | undefined {
    return this.apps.get(name);
  }

  draw(payload: DrawPayload, at = Date.now()): void {
    const app = this.ensure(payload.application_name);
    const key = JSON.stringify(payload);
    const changed = key !== app.frameKey;

    app.frame = payload;
    app.frameKey = key;
    app.priority = payload.priority ?? DEFAULT_PRIORITY;
    app.lastDrawAt = at;

    // A repeated identical frame is still proof of life, but there is nothing
    // downstream to redo for it.
    if (changed) {
      this.options.onChange?.();
    }
  }

  clear(name: string, at = Date.now()): void {
    const app = this.ensure(name);
    if (!app.frame) {
      return;
    }
    app.frame = null;
    app.frameKey = '';
    app.yieldedAt = at;
    this.options.onChange?.();
  }

  setRunning(name: string, running: boolean): void {
    const app = this.apps.get(name);
    if (!app || app.running === running) {
      return;
    }
    app.running = running;
    // A process that died cannot be showing anything, whatever it drew last.
    if (!running) {
      app.frame = null;
      app.frameKey = '';
    }
    this.options.onChange?.();
  }

  /** The apps with something to show right now, in no particular order. */
  candidates(now = Date.now()): AppState[] {
    return this.all().filter((app) => {
      if (!app.frame) {
        return false;
      }

      return app.managed ? app.running : now - app.lastDrawAt <= this.options.staleMs;
    });
  }

  /**
   * An app nobody wrote a manifest for is not an error — the Bar's own apps and
   * anything started by hand draw too. It joins at rank zero.
   */
  private ensure(name: string): AppState {
    const existing = this.apps.get(name);
    if (existing) {
      return existing;
    }

    const app: AppState = {
      name,
      rank: UNMANAGED_RANK,
      managed: false,
      running: false,
      frame: null,
      frameKey: '',
      priority: DEFAULT_PRIORITY,
      lastDrawAt: 0,
      yieldedAt: 0,
    };
    this.apps.set(name, app);

    return app;
  }
}
