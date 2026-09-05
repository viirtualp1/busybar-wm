import type { AppState } from './registry.js';

export type ArbiterInput = {
  candidates: AppState[];
  /** Set by the knob: an app the user chose to sit on. */
  pinned: string | null;
  /** Who holds the screen at the moment, and since when. */
  current: string | null;
  currentSince: number;
  now: number;
  /**
   * The shortest a frame is allowed to stay. Two apps of equal rank that both
   * update every 200ms would otherwise trade the screen every 200ms, which
   * reads as a flicker rather than as a choice.
   */
  minHoldMs: number;
};

export type Decision = {
  name: string | null;
  reason: 'pinned' | 'rank' | 'hold' | 'idle';
};

/**
 * Who gets the screen. Pure on purpose — the whole policy of the window manager
 * is this function, and it is worth being able to test without a device, a
 * socket or a clock.
 */
export function decide(input: ArbiterInput): Decision {
  const { candidates, pinned, current, currentSince, now, minHoldMs } = input;

  if (pinned) {
    const choice = candidates.find((app) => app.name === pinned);
    // A pin the app itself dropped out from under is not honoured; the caller
    // sees `reason !== 'pinned'` and lets it go.
    if (choice) {
      return { name: choice.name, reason: 'pinned' };
    }
  }

  const best = [...candidates].sort(compare)[0];
  if (!best) {
    return { name: null, reason: 'idle' };
  }

  const holder = candidates.find((app) => app.name === current);
  if (holder && best.name !== holder.name && now - currentSince < minHoldMs) {
    // Rank is a claim on the screen strong enough to interrupt; wanting it
    // slightly more within the same rank is not.
    if (best.rank <= holder.rank) {
      return { name: holder.name, reason: 'hold' };
    }
  }

  return { name: best.name, reason: 'rank' };
}

/** Rank first, then the app's own draw priority, then whoever spoke last. */
function compare(a: AppState, b: AppState): number {
  return b.rank - a.rank || b.priority - a.priority || b.lastDrawAt - a.lastDrawAt;
}

/**
 * The knob's order through the apps: the same one the arbiter would pick in,
 * so turning it walks down from what is on screen rather than around a set
 * whose order nothing explains.
 */
export function cycleOrder(candidates: AppState[]): string[] {
  return [...candidates].sort(compare).map((app) => app.name);
}

/** Where a knob turn of `delta` notches lands, starting from `from`. */
export function nextPin(
  order: string[],
  from: string | null,
  delta: number,
): string | null {
  if (order.length === 0) {
    return null;
  }
  const at = from ? order.indexOf(from) : -1;
  const step = delta > 0 ? 1 : -1;
  const start = at === -1 ? (step > 0 ? -1 : 0) : at;
  const index = (((start + step) % order.length) + order.length) % order.length;

  return order[index] ?? null;
}
