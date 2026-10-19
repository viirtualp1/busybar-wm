import { BarApiError, errorMessage, isLowPriority } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import { cycleOrder, decide, nextPin } from './arbiter.js';
import { compose, diff, OWNER, type Desired } from './canvas.js';
import type { Scene } from './scene.js';

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  /**
   * A line an app printed. A logger without this gets it as `[name] line`
   * through `info`, which is what every logger got before.
   */
  app?: (name: string, line: string, stream: 'out' | 'err') => void;
};

export type CompositorOptions = {
  minHoldMs: number;
  /** How long a knob-chosen app stays chosen. 0 keeps it until BACK. */
  pinTimeoutMs: number;
  /** Re-checks the clock-driven parts of the policy: holds, pins, staleness. */
  tickMs: number;
  logger?: Logger;
  /** Told whenever a different app — or none — takes the screen. */
  onShow?: (name: string | null) => void;
};

/**
 * Turns the arbiter's answer into what the Bar is showing.
 *
 * Everything is drawn under one name, `OWNER`, because the device's canvas has
 * one owner. What the canvas holds is remembered here, element by element, so
 * each change — a new frame, a handover — reaches the device as the difference
 * and nothing more: the ids that went are deleted, the ones that changed are
 * drawn. `null` means it is not known what the device holds, and the next push
 * starts from a clear.
 */
export class Compositor {
  private current: string | null = null;
  private currentSince = 0;
  private pinned: string | null = null;
  private pinnedAt = 0;
  private device: Map<string, string> | null = null;
  private devicePriority = 0;
  /** The frames the LED was last sent for, so a flash is sent once per frame. */
  private ledFor = '';
  private flushing = false;
  private dirty = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private warnedPriority = false;
  private readonly logger: Logger;

  constructor(
    private readonly scene: Scene,
    private readonly upstream: Upstream,
    private readonly options: CompositorOptions,
  ) {
    this.logger = options.logger ?? console;
  }

  get showing(): string | null {
    return this.current;
  }

  get pin(): string | null {
    return this.pinned;
  }

  start(): void {
    this.running = true;
    this.timer = setInterval(() => this.wake(), this.options.tickMs);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Leave the Bar as it was found rather than with a dead app's last frame.
    if (this.device === null || this.device.size > 0) {
      await this.clearOwn().catch(() => undefined);
    }
    this.current = null;
  }

  /** Something changed; work out what the screen should be, once. */
  wake(): void {
    if (!this.running) {
      return;
    }
    this.dirty = true;
    if (this.flushing) {
      return;
    }
    void this.drain();
  }

  /**
   * The device dropped the canvas on its own — a short BACK, or the switch —
   * and is showing its own screen. Nothing of ours is there any more, so the
   * next push draws the whole frame again instead of finding nothing to do.
   */
  deviceDropped(): void {
    this.device = new Map();
    this.devicePriority = 0;
    this.ledFor = '';
    this.wake();
  }

  /** The knob: step to the next app that has something to show. */
  cycle(delta: number, now = Date.now()): string | null {
    const order = cycleOrder(this.scene.candidates(now));
    const target = nextPin(order, this.pinned ?? this.current, delta);
    if (target) {
      this.pinned = target;
      this.pinnedAt = now;
      this.wake();
    }

    return target;
  }

  /** Same as OK landing on one app — used by the /wm config API. */
  pinApp(name: string, now = Date.now()): void {
    this.pinned = name;
    this.pinnedAt = now;
    this.logger.info(`[wm] pinned ${name}`);
    this.wake();
  }

  /** BACK: give the choice back to the policy. */
  unpin(): void {
    if (!this.pinned) {
      return;
    }
    this.pinned = null;
    this.logger.info('[wm] automatic again');
    this.wake();
  }

  private async drain(): Promise<void> {
    this.flushing = true;
    try {
      while (this.dirty && this.running) {
        this.dirty = false;
        await this.flush();
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flush(): Promise<void> {
    const now = Date.now();
    this.expirePin(now);

    const decision = decide({
      candidates: this.scene.candidates(now),
      pinned: this.pinned,
      current: this.current,
      currentSince: this.currentSince,
      now,
      minHoldMs: this.options.minHoldMs,
    });

    // A pin the app dropped out from under has nothing left to hold.
    if (this.pinned && decision.reason !== 'pinned') {
      this.pinned = null;
      this.logger.info(`[wm] ${decision.name ?? 'nobody'} — pinned app went quiet`);
    }

    if (decision.name !== this.current) {
      this.current = decision.name;
      this.currentSince = now;
      this.logger.info(
        decision.name
          ? `[wm] ${decision.name} has the screen (${decision.reason})`
          : '[wm] nobody is drawing — display released',
      );
      this.options.onShow?.(decision.name);
    }

    const surfaces = this.current ? this.scene.visible(this.current) : [];
    const desired = this.current
      ? compose(this.current, surfaces)
      : { elements: new Map(), priority: 0 };
    const frames = `${this.current ?? ''}\n${surfaces.map((s) => s.frameKey).join('\n')}`;

    try {
      await this.push(desired, frames);
      this.warnedPriority = false;
    } catch (error) {
      // Someone flipped the Bar to its own BUSY session; the frame is still
      // good, and what the canvas holds did not change, so the next tick tries
      // the same difference again.
      if (isLowPriority(error)) {
        if (!this.warnedPriority) {
          this.logger.warn('[wm] the Bar is showing a higher-priority session, waiting');
          this.warnedPriority = true;
        }

        return;
      }
      // Whatever got through, the canvas is not what this side believes any
      // more. The next tick starts it over from a clear.
      this.device = null;
      this.logger.warn(`[wm] draw failed: ${errorMessage(error)}`);
    }
  }

  private async push(desired: Desired, frames: string): Promise<void> {
    if (desired.elements.size === 0) {
      if (this.device === null || this.device.size > 0) {
        await this.clearOwn();
      }

      return;
    }

    // The device refuses a draw from its owner at a lower priority than the
    // last one; an empty canvas has none.
    if (
      this.device === null ||
      (desired.priority < this.devicePriority && this.device.size > 0)
    ) {
      await this.clearOwn();
    }
    const device = this.device ?? new Map<string, string>();
    const plan = diff(device, desired);

    if (plan.remove.length > 0) {
      await this.upstream.deleteElements(OWNER, plan.remove);
      for (const id of plan.remove) {
        device.delete(id);
      }
      if (device.size === 0) {
        this.devicePriority = 0;
      }
    }

    // The LED flashes once per draw that carries it, so it goes out with the
    // first draw of a frame that asks for it — even when no element changed.
    const led = desired.led && frames !== this.ledFor ? desired.led : undefined;
    const upsert =
      plan.upsert.length === 0 && led
        ? [...desired.elements.values()].slice(0, 1)
        : plan.upsert;

    if (upsert.length > 0) {
      await this.upstream.draw({
        application_name: OWNER,
        priority: desired.priority,
        elements: upsert,
        ...(led ? { led_notification_color: led } : {}),
      });
      for (const element of upsert) {
        device.set(element.id, JSON.stringify(element));
      }
      this.devicePriority = desired.priority;
      if (led) {
        this.ledFor = frames;
      }
    }
  }

  /**
   * Everything of ours off the canvas. A device whose canvas belongs to
   * somebody else, or to nobody, has nothing of ours on it either.
   */
  private async clearOwn(): Promise<void> {
    try {
      await this.upstream.clear(OWNER);
    } catch (error) {
      if (!(error instanceof BarApiError && error.status === 400)) {
        throw error;
      }
    }
    this.device = new Map();
    this.devicePriority = 0;
    this.ledFor = '';
  }

  private expirePin(now: number): void {
    if (!this.pinned || this.options.pinTimeoutMs <= 0) {
      return;
    }
    if (now - this.pinnedAt >= this.options.pinTimeoutMs) {
      this.pinned = null;
      this.logger.info('[wm] pin expired, automatic again');
    }
  }
}
