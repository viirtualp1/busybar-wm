import type { WantLevel } from './scene.js';

/**
 * What the window manager does, as it does it — for the inspector page, which
 * draws the traffic between the apps, the window manager and the Bar.
 *
 * Nothing here decides anything. Every part reports to one `Events`, which
 * hands each event to whoever is listening and forgets it; with nobody
 * listening an event costs one object.
 */
export type Mode = 'tap' | 'manage';

export const MODES: readonly Mode[] = ['tap', 'manage'];

/** Who an app's request reached: the Bar itself in tap mode, the window manager otherwise. */
export type Hop = 'bar' | 'wm';

/** What a request did to the Bar's canvas, for working out whose elements it took. */
export type DrawKind = 'draw' | 'clear' | 'delete-ids' | 'other';

export type EventDraft =
  | { type: 'request'; id: string; app: string; to: Hop; method: string; path: string }
  | { type: 'response'; id: string; status: number; ms: number; note?: string }
  | { type: 'mode'; mode: Mode }
  | {
      type: 'decision';
      winner: string | null;
      reason: 'pinned' | 'rank' | 'hold' | 'idle';
      pinned: string | null;
      /** What is left of the holder's minimum hold, relative so a recording replays. */
      holdMs: number;
      candidates: { name: string; rank: number; want: WantLevel }[];
    }
  | {
      type: 'diff';
      cause: 'switch' | 'frame' | 'overlay';
      from: string | null;
      to: string | null;
      add: number;
      change: number;
      remove: number;
      /** The canvas was cleared first, rather than changed by id. */
      cleared: boolean;
      total: number;
      budget: number;
    }
  | {
      type: 'protocol';
      app: string;
      from: 'app' | 'wm';
      message: string;
      detail?: string;
      visible?: boolean;
    }
  | { type: 'input'; key: string; gesture: 'next' | 'automatic' | 'app'; to?: string }
  | {
      type: 'overlay';
      state: 'shown' | 'cleared';
      source: string;
      text?: string;
      durationMs?: number;
    }
  /** The front panel as the device sends it: base64 of 72×16 BGR bytes. */
  | { type: 'screen'; data: string };

export type WmEvent = EventDraft & { t: number };

export type Listener = (event: WmEvent) => void;

/** A note on a request's answer, such as whose elements it wiped. */
export type Note = (app: string, kind: DrawKind, status: number) => string | undefined;

export type Request = { app: string; to: Hop; method: string; path: string };

/** What a page opened halfway through needs before the next event says it. */
const REMEMBERED = new Set<EventDraft['type']>(['mode', 'decision', 'screen']);

/**
 * The messages that open a session on the display socket. They are said once,
 * usually long before anyone opens the inspector, so each app's are kept.
 */
const HANDSHAKE = new Set([
  'hello',
  'welcome',
  'surface.create',
  'input.grab',
  'configure',
]);

export class Events {
  private readonly listeners = new Set<Listener>();
  private readonly latest = new Map<EventDraft['type'], WmEvent>();
  /** Each connected app's handshake, by message; forgotten when its session closes. */
  private readonly handshakes = new Map<string, Map<string, WmEvent>>();
  private requests = 0;

  get listening() {
    return this.listeners.size > 0;
  }

  emit(draft: EventDraft) {
    const event: WmEvent = { ...draft, t: Date.now() };

    if (REMEMBERED.has(event.type)) {
      this.latest.set(event.type, event);
    }

    if (event.type === 'protocol' && HANDSHAKE.has(event.message)) {
      const kept = this.handshakes.get(event.app) ?? new Map<string, WmEvent>();

      kept.set(event.message, event);
      this.handshakes.set(event.app, kept);
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One page that cannot keep up is not a reason to stop telling the rest.
      }
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** An app left the display socket: its handshake is history. */
  forget(app: string) {
    this.handshakes.delete(app);
  }

  /** The latest mode, every open session's handshake, then the latest decision and screen. */
  snapshot() {
    const [mode, ...rest] = [...REMEMBERED].map((type) => this.latest.get(type));
    const handshakes = [...this.handshakes.values()].flatMap((kept) => [
      ...kept.values(),
    ]);

    return [mode, ...handshakes, ...rest].filter((event) => event !== undefined);
  }

  /** Announces a request, and returns what to call with its answer. */
  request(request: Request) {
    if (!this.listening) {
      return () => undefined;
    }

    const id = `r${++this.requests}`;
    const started = performance.now();

    this.emit({ type: 'request', id, ...request });

    return (status: number, note?: string) => {
      this.emit({
        type: 'response',
        id,
        status,
        ms: Math.round(performance.now() - started),
        ...(note ? { note } : {}),
      });
    };
  }
}
