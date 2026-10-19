import type { ClientState, WantLevel } from './scene.js';

/** What the policy reads of an app: everything else about it is not its business. */
export type Contender = Pick<ClientState, 'name' | 'rank' | 'priority' | 'lastDrawAt'> & {
  /** Absent means `normal`: an app behind the proxy wants the screen by drawing. */
  want?: WantLevel;
};

export type ArbiterInput = {
  candidates: Contender[];
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
    // Rank is a claim on the screen strong enough to interrupt, and so is an
    // app saying it is urgent; wanting it slightly more within the same rank
    // is not.
    const urgent = best.want === 'urgent' && holder.want !== 'urgent';
    if (best.rank <= holder.rank && !urgent && tier(best) <= tier(holder)) {
      return { name: holder.name, reason: 'hold' };
    }
  }

  return { name: best.name, reason: 'rank' };
}

/**
 * Wanting the screen at all first — an `idle` app is shown only when nothing
 * else asks — then rank, then saying it is urgent, then the app's own draw
 * priority, then whoever spoke last.
 */
function compare(a: Contender, b: Contender): number {
  return (
    tier(b) - tier(a) ||
    b.rank - a.rank ||
    Number(b.want === 'urgent') - Number(a.want === 'urgent') ||
    b.priority - a.priority ||
    b.lastDrawAt - a.lastDrawAt
  );
}

/** `urgent` does not jump the manifest's order; it wins ties and interrupts holds. */
function tier(app: Contender): number {
  return app.want === 'idle' ? 0 : 1;
}

/**
 * The knob's order through the apps: the same one the arbiter would pick in,
 * so turning it walks down from what is on screen rather than around a set
 * whose order nothing explains.
 */
export function cycleOrder(candidates: Contender[]): string[] {
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
