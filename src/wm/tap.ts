import { BarApiError, errorMessage } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import { LEGACY_SURFACE } from '../proxy/legacy.js';
import { diff } from './canvas.js';
import type { Logger } from './compositor.js';
import type { DrawKind } from './events.js';
import { DEFAULT_PRIORITY, type Element, type Scene } from './scene.js';

/**
 * Tap mode: the window manager listens and decides nothing.
 *
 * Apps behind the proxy have their draws forwarded to the Bar under their own
 * names, as if nothing stood in between. An app on the display socket has no
 * draws of its own to forward, so this does what it would do without a window
 * manager: draws its whole frame under its own name whenever it changes. The
 * device then arbitrates, by its own rules — which is the fight the inspector
 * shows before the window manager steps in.
 *
 * The scene is kept up to date throughout, so the moment the window manager
 * starts deciding it already knows every app's last frame.
 */
export class TapRelay {
  private active = false;
  /** What each app last had accepted, by id: the ones a new frame dropped are deleted. */
  private readonly sent = new Map<string, Map<string, string>>();
  private readonly busy = new Set<string>();
  private readonly dirty = new Set<string>();
  /** Whoever last drew to the Bar in tap mode, to say whose elements a draw wiped. */
  private owner: string | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly upstream: Upstream,
    private readonly logger: Logger,
  ) {}

  /** Starts relaying, beginning with the frames every connected app already has. */
  start() {
    this.active = true;
    this.owner = null;

    for (const client of this.scene.all()) {
      if (client.connected) {
        this.push(client.name);
      }
    }
  }

  stop() {
    this.active = false;
    this.sent.clear();
    this.dirty.clear();
    this.owner = null;
  }

  /** An app on the socket changed its frames. */
  push(app: string) {
    if (!this.active) {
      return;
    }

    if (this.busy.has(app)) {
      // The device holds an equal-priority draw for a second and a half before
      // refusing it; frames that arrive meanwhile collapse into the next one.
      this.dirty.add(app);

      return;
    }

    void this.run(app);
  }

  /**
   * What a draw that reached the Bar did to the previous owner. Only true in
   * tap mode: managed, everything is drawn under one name.
   */
  note(app: string, kind: DrawKind, status: number) {
    if (!this.active || status >= 400) {
      return undefined;
    }

    if (kind === 'draw') {
      const previous = this.owner;

      this.owner = app;

      return previous && previous !== app ? `${previous}'s elements wiped` : undefined;
    }

    if (kind === 'clear' && (app === this.owner || !app)) {
      this.owner = null;
    }

    return undefined;
  }

  private async run(app: string) {
    this.busy.add(app);

    try {
      do {
        this.dirty.delete(app);
        await this.flush(app);
      } while (this.dirty.has(app) && this.active);
    } finally {
      this.busy.delete(app);
    }
  }

  private async flush(app: string) {
    const elements = new Map<string, Element>();
    let priority: number | null = null;
    let led: string | undefined;

    for (const surface of this.scene.visible(app)) {
      if (surface.name === LEGACY_SURFACE || !surface.frame) {
        continue;
      }

      priority = Math.max(priority ?? 0, surface.frame.priority);
      led ??= surface.frame.led;

      for (const element of surface.frame.elements) {
        const id = `${surface.name}:${element.id}`;

        elements.set(id, { ...element, id });
      }
    }

    const held = this.sent.get(app) ?? new Map<string, string>();
    const plan = diff(held, { elements, priority: priority ?? DEFAULT_PRIORITY });

    if (plan.upsert.length === 0 && plan.remove.length === 0) {
      return;
    }

    try {
      if (elements.size === 0) {
        await this.upstream.clear(app);
        this.sent.delete(app);

        return;
      }

      if (plan.remove.length > 0) {
        await this.upstream.deleteElements(app, plan.remove);
      }

      // The whole frame, as an app on its own sends it: another app may have
      // wiped any of it since the last draw.
      await this.upstream.draw({
        application_name: app,
        priority: priority ?? DEFAULT_PRIORITY,
        elements: [...elements.values()],
        ...(led ? { led_notification_color: led } : {}),
      });

      this.sent.set(
        app,
        new Map([...elements].map(([id, element]) => [id, JSON.stringify(element)])),
      );
    } catch (error) {
      // Whatever the Bar holds of this app now is not known; the next frame
      // is drawn whole, with nothing to delete first.
      this.sent.delete(app);

      if (!(
        error instanceof BarApiError &&
        (error.status === 409 || error.status === 400)
      )) {
        this.logger.warn(
          `[wm] tap: ${app}'s frame did not reach the Bar: ${errorMessage(error)}`,
        );
      }
    }
  }
}
