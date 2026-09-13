import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The children of a daemon that did not get to say goodbye.
 *
 * Killing the daemon hard — closing the terminal, a crash — leaves the apps it
 * started running. They keep their ports, so a second `busybar-mydota` cannot
 * bind 3080 and crash-loops instead; they keep drawing into a screen they no
 * longer own; and nothing on the next start knows they are there.
 *
 * So every child is written down as it starts, and the next daemon reads the
 * note and clears up before it spawns anything.
 */
export type StrayNote = { pid: number; name: string; startedAt: number };

export type StraysOptions = {
  /** Injected by the tests, which have no processes to kill. */
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => unknown;
  now?: () => number;
  /** How long this machine has been up, in ms. */
  bootedMsAgo?: () => number;
  /** How long a stopped stray is given to actually let go of its port. */
  waitMs?: number;
};

const FILE = 'children.json';
const POLL_MS = 100;
const DEFAULT_WAIT_MS = 5000;

export class Strays {
  private readonly path: string;
  private readonly options: Required<StraysOptions>;
  private notes = new Map<number, StrayNote>();

  constructor(stateDir: string, options: StraysOptions = {}) {
    this.path = join(stateDir, FILE);
    this.options = {
      alive: options.alive ?? alive,
      kill: options.kill ?? killTree,
      now: options.now ?? (() => Date.now()),
      bootedMsAgo: options.bootedMsAgo ?? (() => uptime() * 1000),
      waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    };
  }

  /** Stops whatever the last run left behind, and says what it stopped. */
  async sweep(): Promise<StrayNote[]> {
    const bootedAt = this.options.now() - this.options.bootedMsAgo();
    const stopped: StrayNote[] = [];

    for (const note of this.read()) {
      // A pid means something only while it is still the same process. After a
      // reboot the number is free to belong to anything, so a note older than
      // this machine's uptime is left well alone.
      if (note.startedAt < bootedAt || !this.options.alive(note.pid)) {
        continue;
      }
      await this.options.kill(note.pid);
      stopped.push(note);
    }

    // A killed process is not yet a closed port. Starting the replacement the
    // moment taskkill returns is the other way to find 3080 still taken, so the
    // sweep waits for the strays to be gone — bounded, because one that will
    // not die should not keep the whole daemon from starting.
    await this.waitGone(stopped.map((note) => note.pid));

    this.notes.clear();
    this.write();

    return stopped;
  }

  remember(pid: number, name: string): void {
    this.notes.set(pid, { pid, name, startedAt: this.options.now() });
    this.write();
  }

  forget(pid: number): void {
    if (this.notes.delete(pid)) {
      this.write();
    }
  }

  /**
   * What an orderly stop leaves behind: a note of the children still alive.
   *
   * Deleting the note outright on the way out assumed every kill had worked.
   * When one had not — a shell that died before the app beneath it, a taskkill
   * that never reached — the survivor went unrecorded, and the next start had
   * nothing to sweep and collided with it instead.
   */
  settle(): void {
    for (const pid of [...this.notes.keys()]) {
      if (!this.options.alive(pid)) {
        this.notes.delete(pid);
      }
    }

    if (this.notes.size === 0) {
      this.clear();

      return;
    }
    this.write();
  }

  /** Forgets everything, whatever state it is in. */
  clear(): void {
    this.notes.clear();
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Nothing there, or nothing to be done about it.
    }
  }

  private async waitGone(pids: number[]): Promise<void> {
    // The real clock, not the injected one: a frozen test clock would never
    // reach the deadline.
    const deadline = Date.now() + this.options.waitMs;
    while (pids.some((pid) => this.options.alive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private read(): StrayNote[] {
    if (!existsSync(this.path)) {
      return [];
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));

      return Array.isArray(raw) ? raw.filter(isNote) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify([...this.notes.values()], null, 2)}\n`);
    } catch {
      // Failing to write the note is not worth failing a start over; the cost
      // is one stray we cannot clean up next time.
    }
  }
}

function isNote(value: unknown): value is StrayNote {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const note = value as Partial<StrayNote>;

  return (
    typeof note.pid === 'number' &&
    typeof note.name === 'string' &&
    typeof note.startedAt === 'number'
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a process and everything under it, and resolves once that is done.
 *
 * On Windows that is taskkill, which is a process of its own: returning before
 * it has run lets the caller carry on — or exit — while the kill is still only
 * an intention.
 */
function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.once('exit', () => resolve());
      taskkill.once('error', () => resolve());
    });
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  return Promise.resolve();
}
