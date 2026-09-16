import type { Logger } from '../wm/compositor.js';

export type LogStream = 'out' | 'err';

export type ConsoleLogOptions = {
  color: boolean;
  /** Everything as the apps said it, repeats and all. */
  verbose?: boolean;
  /** How long a line stays quiet after it was shown once. */
  repeatMs?: number;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

type Tone = 'plain' | 'good' | 'warn' | 'error';

const REPEAT_MS = 5 * 60_000;
/** Enough to remember every distinct line of a busy afternoon, not a week's. */
const MAX_REMEMBERED = 200;

const WM = 'wm';
const TAGGED = /^\[([\w.-]+)\]\s?([\s\S]*)$/;

/**
 * An app reporting on its connection to the Bar. Under the window manager the
 * Bar an app talks to is this process, so what it says is about the proxy —
 * and the wm already reports on the real device, once.
 */
const BAR_CHATTER = /^(?:waiting for busy bar at|busy bar connected)\b/i;

const ERROR_TEXT = /^(?:fatal|error)\b|\[fatal\]|unhandled/i;

/** Colours for the apps, in the order they are met. Red and yellow mean something else. */
const APP_COLORS = ['36', '35', '32', '34', '96', '95', '92', '94'];

const TONE: Record<Tone, string> = {
  plain: '',
  good: '32',
  warn: '33',
  error: '31',
};

/** Built rather than typed, so the source holds no invisible control characters. */
const ESC = String.fromCharCode(27);

/**
 * The window manager's terminal: one line per event, in columns, with each app
 * in its own colour.
 *
 * Most of what several apps print is the same few things — their name on
 * start, and news of a connection that drops and retries every two seconds.
 * Left alone that is hundreds of lines an hour burying the one that matters,
 * so by default a line is shown once and then held back for a while, with a
 * count when it comes round again. `WM_LOG=verbose` shows everything.
 */
export class ConsoleLog implements Logger {
  private readonly colors = new Map<string, string>();
  private readonly seen = new Map<string, { at: number; hidden: number }>();
  private readonly now: () => number;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;
  private width = 5;

  constructor(private readonly options: ConsoleLogOptions) {
    this.now = options.now ?? Date.now;
    this.out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
    this.err = options.err ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /**
   * Sizes the name column for every app up front, so the first lines line up
   * with the last, and hands out colours in manifest order.
   */
  reserve(names: readonly string[]): void {
    for (const name of names) {
      this.width = Math.max(this.width, name.length);
      this.colorOf(name);
    }
  }

  /** The start-up summary: a title and a few labelled rows, no timestamps. */
  heading(title: string, rows: readonly (readonly [string, string])[]): void {
    this.out(this.paint('1', title));
    const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
      this.out(`  ${this.paint('2', label.padEnd(labelWidth))}  ${value}`);
    }
    this.out('');
  }

  info(message: string): void {
    this.fromWm(message, 'plain');
  }

  warn(message: string): void {
    this.fromWm(message, 'warn');
  }

  error(message: string): void {
    this.fromWm(message, 'error');
  }

  /** A line an app printed, as the supervisor relays it. */
  app(name: string, line: string, stream: LogStream): void {
    let text = line.trim();

    if (!this.options.verbose) {
      // The column already names the app.
      const own = TAGGED.exec(text);
      if (own && own[1] === name) {
        text = (own[2] ?? '').trim();
      }
      if (!text || text === name || text === `busybar-${name}`) {
        return;
      }
      if (BAR_CHATTER.test(text)) {
        return;
      }
    }

    const tone: Tone = ERROR_TEXT.test(text)
      ? 'error'
      : stream === 'err'
        ? 'warn'
        : 'plain';
    this.emit(name, text, tone);
  }

  private fromWm(message: string, tone: Tone): void {
    const tagged = TAGGED.exec(message);
    const source = tagged?.[1] ?? WM;
    const text = tagged ? (tagged[2] ?? '') : message;

    this.emit(source, text, tone === 'plain' ? toneOf(text) : tone);
  }

  private emit(source: string, text: string, tone: Tone): void {
    const note = this.throttle(source, text);
    if (note === null) {
      return;
    }

    const line = [
      this.paint('2', clock(this.now())),
      this.label(source),
      `${this.paint(TONE[tone], text)}${note ? this.paint('2', note) : ''}`,
    ].join('  ');

    if (tone === 'warn' || tone === 'error') {
      this.err(line);
    } else {
      this.out(line);
    }
  }

  /**
   * Null to hold a line back; otherwise what to append to it — empty, or how
   * many times it came round while it was quiet.
   */
  private throttle(source: string, text: string): string | null {
    if (this.options.verbose) {
      return '';
    }

    const now = this.now();
    const key = `${source}::${text}`;
    const entry = this.seen.get(key);
    if (entry && now - entry.at < (this.options.repeatMs ?? REPEAT_MS)) {
      entry.hidden += 1;

      return null;
    }

    this.seen.set(key, { at: now, hidden: 0 });
    this.forgetOld(now);

    return entry && entry.hidden > 0
      ? `  (repeated ${entry.hidden}× since ${clock(entry.at)})`
      : '';
  }

  private forgetOld(now: number): void {
    if (this.seen.size <= MAX_REMEMBERED) {
      return;
    }
    const window = this.options.repeatMs ?? REPEAT_MS;
    for (const [key, entry] of this.seen) {
      if (now - entry.at >= window) {
        this.seen.delete(key);
      }
    }
  }

  private label(source: string): string {
    this.width = Math.max(this.width, source.length);
    const padded = source.padEnd(this.width);
    if (source === WM) {
      return this.paint('1', padded);
    }
    if (source === 'proxy') {
      return this.paint('90', padded);
    }

    return this.paint(this.colorOf(source), padded);
  }

  private colorOf(name: string): string {
    let color = this.colors.get(name);
    if (!color) {
      color = APP_COLORS[this.colors.size % APP_COLORS.length] ?? '36';
      this.colors.set(name, color);
    }

    return color;
  }

  private paint(code: string, text: string): string {
    return this.options.color && code ? `${ESC}[${code}m${text}${ESC}[0m` : text;
  }
}

/** What the wm's own plain messages mean at a glance. */
function toneOf(text: string): Tone {
  if (/exited \((?:code [1-9]|signal)/.test(text)) {
    return 'warn';
  }
  if (/^(?:started|BUSY Bar connected|added)\b/.test(text)) {
    return 'good';
  }

  return 'plain';
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Colour for a terminal, and not for a file or a pipe. `NO_COLOR` and
 * `FORCE_COLOR` are the usual ways to say otherwise.
 */
export function shouldColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['NO_COLOR']) {
    return false;
  }
  if (env['FORCE_COLOR'] && env['FORCE_COLOR'] !== '0') {
    return true;
  }

  return Boolean(stream.isTTY);
}
