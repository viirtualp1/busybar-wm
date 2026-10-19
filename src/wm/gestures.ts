import type { InputEvent } from '../bar/input.js';

/** What a press on the Bar turns out to mean. */
export type Gesture =
  /** Holding OK: the next app that has something to show. */
  | { kind: 'next' }
  /** BACK: give the choice back to the policy. */
  | { kind: 'automatic' }
  /** The knob, when the window manager was told to take it. */
  | { kind: 'cycle'; delta: number }
  /** The device closed the API's canvas by itself — a short BACK, the switch. */
  | { kind: 'dropped' }
  /** Not the window manager's: it goes to whichever app should hear it. */
  | { kind: 'app'; event: InputEvent };

export type GesturesOptions = {
  /** How long OK has to be held to mean "next app" rather than a press for the app. */
  holdMs: number;
  /** The knob switches apps instead of going to them. */
  knob: boolean;
  onGesture: (gesture: Gesture) => void;
};

/**
 * The few presses the window manager keeps for itself, the way a desktop keeps
 * Alt-Tab, and everything else handed on.
 *
 * OK cannot be told apart from a press for the app until it is either let go
 * or held long enough, so a short OK reaches the app at its release — as a
 * press and a release together — and a long one never does.
 */
export class Gestures {
  private okTimer: NodeJS.Timeout | null = null;
  private okHeld = false;
  private okDown = false;

  constructor(private readonly options: GesturesOptions) {}

  handle(event: InputEvent): void {
    const emit = this.options.onGesture;

    if (event.kind === 'switch') {
      emit({ kind: 'dropped' });

      return;
    }

    if (event.kind === 'encoder') {
      emit(
        this.options.knob
          ? { kind: 'cycle', delta: event.delta }
          : { kind: 'app', event },
      );

      return;
    }

    switch (event.button) {
      case 'back':
        // The device itself closes the canvas on a short BACK; the press is
        // ours, and neither edge is an app's.
        emit(event.action === 'press' ? { kind: 'automatic' } : { kind: 'dropped' });

        return;
      case 'ok':
        return this.ok(event.action);
      case 'start':
        emit({ kind: 'app', event });
    }
  }

  stop(): void {
    if (this.okTimer) {
      clearTimeout(this.okTimer);
      this.okTimer = null;
    }
  }

  private ok(action: 'press' | 'release'): void {
    if (action === 'press') {
      if (this.okDown) {
        return;
      }
      this.okDown = true;
      this.okHeld = false;
      this.okTimer = setTimeout(() => {
        this.okTimer = null;
        this.okHeld = true;
        this.options.onGesture({ kind: 'next' });
      }, this.options.holdMs);
      this.okTimer.unref();

      return;
    }

    if (!this.okDown) {
      return;
    }
    this.okDown = false;
    this.stop();
    if (this.okHeld) {
      return;
    }
    this.options.onGesture({
      kind: 'app',
      event: { kind: 'button', button: 'ok', action: 'press' },
    });
    this.options.onGesture({
      kind: 'app',
      event: { kind: 'button', button: 'ok', action: 'release' },
    });
  }
}
