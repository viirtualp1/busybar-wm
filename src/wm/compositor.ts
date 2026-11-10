import { BarApiError, errorMessage, isLowPriority } from 'busybar-kit/errors';
import type { Upstream } from '../bar/upstream.js';
import { cycleOrder, decide, nextPin } from './arbiter.js';
import { compose, diff, MAX_ELEMENTS, OWNER, type Desired } from './canvas.js';
import type { Overlay } from './control.js';
import type { EventDraft, Events } from './events.js';
import { DEFAULT_PRIORITY, type Element, type Scene } from './scene.js';

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
  /** Told of every decision and every change to the canvas, for the inspector. */
  events?: Events;
  /** Start without drawing, as in tap mode, until `resume`. */
  paused?: boolean;
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
  private readonly overlays = new Map<Overlay['display'], Overlay>();
  private readonly overlayExpiry = new Map<Overlay['display'], NodeJS.Timeout>();
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
  private paused: boolean;
  private draining: Promise<void> | null = null;
  /** The last decision told, so the same one is not told every tick. */
  private toldDecision = '';
  /** Whose frame, and which overlays, the canvas held after the last push. */
  private pushedFor: string | null = null;
  private pushedOverlays = '';
  private readonly logger: Logger;

  constructor(
    private readonly scene: Scene,
    private readonly upstream: Upstream,
    private readonly options: CompositorOptions,
  ) {
    this.logger = options.logger ?? console;
    this.paused = options.paused ?? false;
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
    this.clearOverlay();
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
    this.draining = this.drain();
  }

  /**
   * Stops drawing and takes everything of ours off the canvas, for tap mode.
   * The scene goes on being kept, so `resume` has every frame to hand.
   */
  async pause() {
    if (this.paused) {
      return;
    }

    this.paused = true;
    await this.draining;

    try {
      await this.clearOwn();
    } catch (error) {
      this.logger.warn(`[wm] could not clear the canvas: ${errorMessage(error)}`);
    }

    this.current = null;
    this.pushedFor = null;
    this.pushedOverlays = '';
    this.toldDecision = '';
  }

  /** Decides and draws again, from a canvas whose contents are not known. */
  resume() {
    if (!this.paused) {
      return;
    }

    this.paused = false;
    this.device = null;
    this.current = null;
    this.currentSince = 0;
    this.wake();
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

  showOverlay(overlay: Overlay) {
    const { display, endsAt } = overlay;

    this.options.events?.emit({
      type: 'overlay',
      state: 'shown',
      source: overlay.source ?? 'control',
      text: overlay.text,
      durationMs: Math.max(0, endsAt - Date.now()),
    });
    clearTimeout(this.overlayExpiry.get(display));
    const expiry = setTimeout(
      () => this.clearOverlay(display),
      Math.max(0, endsAt - Date.now()),
    );
    expiry.unref();
    this.overlayExpiry.set(display, expiry);
    this.overlays.set(display, overlay);
    this.wake();
  }

  clearOverlay(display?: Overlay['display']) {
    const targets = display ? [display] : [...this.overlays.keys()];

    for (const target of targets) {
      const overlay = this.overlays.get(target);

      if (overlay) {
        this.options.events?.emit({
          type: 'overlay',
          state: 'cleared',
          source: overlay.source ?? 'control',
        });
      }

      clearTimeout(this.overlayExpiry.get(target));
      this.overlayExpiry.delete(target);
      this.overlays.delete(target);
    }

    this.wake();
  }

  private applyOverlays(desired: Desired, now: number) {
    const overlays: Element[] = [];
    let top = 0;

    for (const element of desired.elements.values()) {
      if (typeof element['z_index'] === 'number') {
        top = Math.max(top, element['z_index']);
      }
    }

    for (const overlay of this.overlays.values()) {
      if (overlay.endsAt <= now) {
        continue;
      }

      overlays.push(...overlayElements(overlay, now, top));
    }

    if (overlays.length === 0) {
      return;
    }

    // Temporarily make room on a full canvas. The app's saved frame is still intact.
    const overflow = Math.max(0, desired.elements.size + overlays.length - MAX_ELEMENTS);
    for (const id of [...desired.elements.keys()].slice(0, overflow)) {
      desired.elements.delete(id);
    }

    if (!this.current) {
      desired.priority = DEFAULT_PRIORITY;
    }

    for (const element of overlays) {
      desired.elements.set(element.id, element);
    }
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
    if (this.paused) {
      return;
    }

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

    this.tell(decision, now);

    const surfaces = this.current ? this.scene.visible(this.current) : [];
    const desired: Desired = this.current
      ? compose(this.current, surfaces)
      : { elements: new Map(), priority: 0 };
    this.applyOverlays(desired, now);
    const frames = `${this.current ?? ''}\n${surfaces.map((s) => s.frameKey).join('\n')}`;
    const overlays = [...this.overlays.values()]
      .map((o) => `${o.display}:${o.text}`)
      .join('\n');

    try {
      await this.push(desired, frames, overlays);
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

  private async push(desired: Desired, frames: string, overlays: string): Promise<void> {
    const before = this.device?.size ?? 0;

    if (desired.elements.size === 0) {
      if (this.device === null || this.device.size > 0) {
        await this.clearOwn();
        this.told({ add: 0, change: 0, remove: before, cleared: true }, overlays);
      }

      return;
    }

    // The device refuses a draw from its owner at a lower priority than the
    // last one; an empty canvas has none.
    let cleared = false;
    if (
      this.device === null ||
      (desired.priority < this.devicePriority && this.device.size > 0)
    ) {
      await this.clearOwn();
      cleared = true;
    }
    const device = this.device ?? new Map<string, string>();
    const plan = diff(device, desired);
    const upserted = new Set(plan.upsert.map((element) => element.id));
    const counts = {
      add: plan.upsert.filter((element) => !device.has(element.id)).length,
      change: plan.upsert.filter((element) => device.has(element.id)).length,
      remove:
        plan.remove.filter((id) => !upserted.has(id)).length + (cleared ? before : 0),
      cleared,
    };

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

    if (counts.add + counts.change + counts.remove > 0 || counts.cleared) {
      this.told(counts, overlays);
    }
  }

  /** A decision, once — not again every tick it stays the same. */
  private tell(decision: ReturnType<typeof decide>, now: number) {
    const events = this.options.events;

    if (!events) {
      return;
    }

    const candidates = this.scene
      .candidates(now)
      .map(({ name, rank, want }) => ({ name, rank, want }));
    const key = JSON.stringify([decision, this.pinned, candidates]);

    if (key === this.toldDecision) {
      return;
    }

    this.toldDecision = key;
    events.emit({
      type: 'decision',
      winner: decision.name,
      reason: decision.reason,
      pinned: this.pinned,
      holdMs: this.current
        ? Math.max(0, this.options.minHoldMs - (now - this.currentSince))
        : 0,
      candidates,
    });
  }

  /** What one push did to the canvas, and why it was pushed. */
  private told(
    counts: Pick<
      Extract<EventDraft, { type: 'diff' }>,
      'add' | 'change' | 'remove' | 'cleared'
    >,
    overlays: string,
  ) {
    const cause =
      this.current !== this.pushedFor
        ? 'switch'
        : overlays !== this.pushedOverlays
          ? 'overlay'
          : 'frame';

    this.options.events?.emit({
      type: 'diff',
      cause,
      from: this.pushedFor,
      to: this.current,
      ...counts,
      total: this.device?.size ?? 0,
      budget: MAX_ELEMENTS,
    });
    this.pushedFor = this.current;
    this.pushedOverlays = overlays;
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

function overlayElements(overlay: Overlay, now: number, top: number) {
  const { display } = overlay;
  const front = display === 'front';
  const width = front ? 72 : 146;
  const height = front ? 16 : 24;
  const y = front ? 0 : 28;
  const text = overlay.kind === 'timer' ? timerText(overlay, now) : overlay.text;
  const elements: Element[] = [
    {
      id: `wm-overlay-${display}-bg`,
      type: 'rectangle',
      display,
      x: 0,
      y,
      width,
      height,
      fill: 'solid',
      fill_colors: ['#000000FF'],
      border_width: 0,
      border_color: '#00000000',
      align: 'top_left',
      z_index: top + 1,
      timeout: 0,
    },
    {
      id: `wm-overlay-${display}-text`,
      type: 'text',
      display,
      x: 1,
      y: y + (front ? 4 : 7),
      width: width - 2,
      text,
      font: 'small',
      color: '#FFFFFFFF',
      align: 'top_left',
      ...(text.length > (front ? 17 : 35) ? { scroll_rate: 900 } : {}),
      z_index: top + 2,
      timeout: 0,
    },
  ];

  return elements;
}

function timerText(overlay: Overlay, now: number) {
  const seconds = Math.ceil((overlay.endsAt - now) / 1000);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return overlay.text ? `${time} ${overlay.text}` : time;
}
