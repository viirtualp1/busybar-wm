import { errorMessage, isLowPriority } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import { cycleOrder, decide, nextPin, type Decision } from './arbiter.js';
import type { Registry } from './registry.js';

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type CompositorOptions = {
  minHoldMs: number;
  /** How long a knob-chosen app stays chosen. 0 keeps it until BACK. */
  pinTimeoutMs: number;
  /** Re-checks the clock-driven parts of the policy: holds, pins, staleness. */
  tickMs: number;
  logger?: Logger;
};

/**
 * Turns the arbiter's answer into what the Bar is showing.
 *
 * Only one app's elements are ever on the device, because they persist there by
 * id: handing the screen over means clearing the outgoing app before the
 * incoming one draws, or its leftovers stay under the new frame.
 */
export class Compositor {
  private current: string | null = null;
  private currentSince = 0;
  private pinned: string | null = null;
  private pinnedAt = 0;
  private pushedKey = '';
  private flushing = false;
  private dirty = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private warnedPriority = false;
  private readonly logger: Logger;

  constructor(
    private readonly registry: Registry,
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
    if (this.current) {
      await this.upstream.clear(this.current).catch(() => undefined);
      this.current = null;
    }
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

  /** The knob: step to the next app that has something to show. */
  cycle(delta: number, now = Date.now()): string | null {
    const order = cycleOrder(this.registry.candidates(now));
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

    const candidates = this.registry.candidates(now);
    const decision = decide({
      candidates,
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
      await this.handOver(decision, now);
    }

    if (!this.current) {
      return;
    }

    const app = this.registry.get(this.current);
    if (!app?.frame || app.frameKey === this.pushedKey) {
      return;
    }

    try {
      await this.upstream.draw(app.frame);
      this.pushedKey = app.frameKey;
      this.warnedPriority = false;
    } catch (error) {
      // Someone flipped the Bar to its own BUSY session; the frame is still
      // good, so keep it and let the next tick try again.
      if (isLowPriority(error)) {
        if (!this.warnedPriority) {
          this.logger.warn('[wm] the Bar is showing a higher-priority session, waiting');
          this.warnedPriority = true;
        }

        return;
      }
      this.pushedKey = '';
      this.logger.warn(`[wm] draw failed: ${errorMessage(error)}`);
    }
  }

  private async handOver(decision: Decision, now: number): Promise<void> {
    const outgoing = this.current;
    this.current = decision.name;
    this.currentSince = now;
    this.pushedKey = '';

    if (outgoing) {
      try {
        await this.upstream.clear(outgoing);
      } catch (error) {
        this.logger.warn(`[wm] clearing ${outgoing} failed: ${errorMessage(error)}`);
      }
    }

    this.logger.info(
      decision.name
        ? `[wm] ${decision.name} has the screen (${decision.reason})`
        : '[wm] nobody is drawing — display released',
    );
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
