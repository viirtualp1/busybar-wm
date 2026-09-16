import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AppManifest } from '../manifest.js';
import type { Logger } from './compositor.js';
import type { Registry } from './registry.js';
import { Strays } from './strays.js';

export type SupervisorOptions = {
  /** What the children get as `BUSY_ADDR` — this daemon, not the device. */
  proxyAddr: string;
  registry: Registry;
  restartDelayMs: number;
  /** Where the note about running children is kept between runs. */
  stateDir?: string;
  logger?: Logger;
};

/**
 * Why an app is or is not running, in words a person can act on.
 *
 * Kept as plain data because it travels: the deck puts it above the app's
 * settings, where "offline" alone would leave you reading the terminal to find
 * out whether the app crashed, is waiting its turn, or was never started.
 */
export type AppHealth = {
  state:
    'running' | 'waiting' | 'restarting' | 'exited' | 'stopped' | 'broken' | 'unmanaged';
  message: string;
  /** When it started, or when it last stopped. */
  since?: number;
  /** When the next attempt is due, while one is scheduled. */
  restartAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** The last lines it printed — usually where the reason actually is. */
  output: string[];
};

type Child = {
  manifest: AppManifest;
  process: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  failures: number;
  startedAt: number;
  restartAt: number;
  exit: { code: number | null; signal: string | null; at: number } | null;
  error: string | null;
  output: string[];
};

const MAX_BACKOFF = 8;
const STOP_GRACE_MS = 3000;
/** Enough to hold a stack trace's first lines, not a whole log. */
const OUTPUT_LINES = 12;

/**
 * Runs the apps.
 *
 * Nothing here knows what an app does — only how to start it, where to point
 * it, and that a process which is gone is not showing anything. Keeping the
 * apps as separate processes is deliberate: each stays a program you can still
 * run on its own, and a crash in one is one line in the log rather than the
 * whole bar going dark.
 */
export class Supervisor {
  private readonly children = new Map<string, Child>();
  private readonly skipAutoRestart = new Set<string>();
  /** Stopped by hand: no restart, however they exit, until started by hand. */
  private readonly held = new Set<string>();
  private readonly logger: Logger;
  private readonly strays: Strays;
  private running = false;

  constructor(
    manifests: AppManifest[],
    private readonly options: SupervisorOptions,
  ) {
    this.logger = options.logger ?? console;
    this.strays = new Strays(options.stateDir ?? process.cwd());
    for (const manifest of manifests) {
      this.track(manifest);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    // Anything a previous daemon left running still holds its ports and still
    // draws; starting a second copy on top of it is how 3080 ends up taken.
    for (const stray of await this.strays.sweep()) {
      this.logger.warn(
        `[wm] stopped a stray ${stray.name} (pid ${stray.pid}) from a previous run`,
      );
    }

    for (const child of this.children.values()) {
      if (child.manifest.autostart) {
        this.spawn(child);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const stopping = [...this.children.values()].map((child) => this.kill(child));
    await Promise.all(stopping);
    // Only what is really gone is forgotten. A child that outlived its kill
    // stays in the note, so the next start clears it up instead of colliding
    // with it on its port.
    this.strays.settle();
  }

  /**
   * Takes on an app that was added while the daemon runs.
   *
   * False when there is nothing to take on: no command to run, or an app of
   * that name is already supervised.
   */
  add(manifest: AppManifest): boolean {
    if (!this.track(manifest)) {
      return false;
    }
    const child = this.children.get(manifest.name);
    if (child && this.running && manifest.autostart) {
      this.spawn(child);
    }

    return true;
  }

  /**
   * Stops an app by hand. It stays stopped — no restart, however it exits —
   * until it is started by hand again.
   */
  async stopApp(name: string): Promise<void> {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`no supervised app named ${name}`);
    }
    this.held.add(name);
    await this.kill(child);
    this.logger.info(`[wm] stopped ${name} by hand`);
  }

  /** Stops an app and forgets it, because it has left the manifest. */
  async remove(name: string): Promise<boolean> {
    const child = this.children.get(name);
    if (!child) {
      return false;
    }
    this.held.add(name);
    await this.kill(child);
    this.children.delete(name);
    this.held.delete(name);

    return true;
  }

  /** Kill and start again — used by the /wm config API after a settings change. */
  async restart(name: string): Promise<void> {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`no supervised app named ${name}`);
    }
    // Starting by hand is what undoes stopping by hand.
    this.held.delete(name);
    if (child.timer) {
      clearTimeout(child.timer);
      child.timer = null;
    }
    child.failures = 0;
    if (child.process) {
      this.skipAutoRestart.add(name);
      await this.kill(child);
      this.skipAutoRestart.delete(name);
    }
    if (this.running) {
      this.spawn(child);
    }
  }

  /** Undefined for an app this supervisor does not run. */
  health(name: string): AppHealth | undefined {
    const child = this.children.get(name);
    if (!child) {
      return undefined;
    }
    const output = [...child.output];

    if (child.process) {
      return { state: 'running', message: 'Running', since: child.startedAt, output };
    }

    if (this.held.has(name)) {
      return {
        state: 'stopped',
        message: 'Stopped by hand — it stays off until you start it',
        ...(child.exit ? { since: child.exit.at } : {}),
        output,
      };
    }

    const exit = child.exit
      ? { since: child.exit.at, exitCode: child.exit.code, signal: child.exit.signal }
      : {};
    const why = child.error ? `Could not start: ${child.error}` : exitMessage(child);

    if (child.timer) {
      return {
        state: 'restarting',
        message: `${why} — trying again`,
        restartAt: child.restartAt,
        ...exit,
        output,
      };
    }
    if (child.error) {
      return { state: 'broken', message: why, output };
    }
    if (child.exit) {
      return {
        state: 'exited',
        message: child.manifest.restart
          ? why
          : `${why}. It is set not to restart, so it stays stopped`,
        ...exit,
        output,
      };
    }
    if (!child.manifest.autostart) {
      return {
        state: 'waiting',
        message: 'Autostart is off in wm.config.json, so it only runs when started',
        output,
      };
    }

    return {
      state: 'waiting',
      message: 'Not started yet — apps start once the Bar answers',
      output,
    };
  }

  private track(manifest: AppManifest): boolean {
    if (!manifest.command || this.children.has(manifest.name)) {
      return false;
    }
    this.children.set(manifest.name, {
      manifest,
      process: null,
      timer: null,
      failures: 0,
      startedAt: 0,
      restartAt: 0,
      exit: null,
      error: null,
      output: [],
    });

    return true;
  }

  private spawn(child: Child): void {
    const { manifest } = child;
    if (!manifest.command || child.process) {
      return;
    }

    // What the last run said is only interesting until the next run speaks.
    child.output = [];
    child.error = null;
    child.exit = null;

    let proc: ChildProcess;
    try {
      proc = spawnChild(manifest.command, manifest.args, {
        ...(manifest.cwd ? { cwd: manifest.cwd } : {}),
        env: this.childEnv(manifest),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      child.error = message;
      this.logger.warn(`[${manifest.name}] failed to start: ${message}`);
      this.scheduleRestart(child, false);
      return;
    }

    child.process = proc;
    child.startedAt = Date.now();
    this.options.registry.setRunning(manifest.name, true);
    this.logger.info(`[wm] started ${manifest.name} (pid ${proc.pid ?? '?'})`);
    if (proc.pid) {
      this.strays.remember(proc.pid, manifest.name);
    }

    this.relay(child, proc);

    proc.on('error', (error) => {
      child.error = error.message;
      this.logger.warn(`[${manifest.name}] failed to start: ${error.message}`);
      // A command that does not exist never gets a pid, and never exits
      // either — without this it would count as running forever.
      if (!proc.pid && child.process === proc) {
        child.process = null;
        this.options.registry.setRunning(manifest.name, false);
        this.scheduleRestart(child, false);
      }
    });

    proc.on('exit', (code, signal) => {
      if (child.process === proc) {
        child.process = null;
      }
      if (proc.pid) {
        this.strays.forget(proc.pid);
      }
      child.exit = { code, signal, at: Date.now() };
      this.options.registry.setRunning(manifest.name, false);
      const how = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      this.logger.info(`[wm] ${manifest.name} exited (${how})`);
      this.scheduleRestart(child, code === 0 && !signal);
    });
  }

  private scheduleRestart(child: Child, clean: boolean): void {
    if (
      !this.running ||
      !child.manifest.restart ||
      child.timer ||
      this.skipAutoRestart.has(child.manifest.name) ||
      this.held.has(child.manifest.name)
    ) {
      return;
    }

    // A clean exit is the app saying it is done, not a fault; retrying that
    // immediately is how you get a fork bomb with a nice log.
    child.failures = clean ? 1 : Math.min(child.failures + 1, MAX_BACKOFF);
    const delay = this.options.restartDelayMs * 2 ** (child.failures - 1);
    child.restartAt = Date.now() + delay;
    child.timer = setTimeout(() => {
      child.timer = null;
      this.spawn(child);
    }, delay);
    child.timer.unref();
    this.logger.info(
      `[wm] restarting ${child.manifest.name} in ${Math.round(delay / 1000)}s`,
    );
  }

  private async kill(child: Child): Promise<void> {
    if (child.timer) {
      clearTimeout(child.timer);
      child.timer = null;
    }
    const proc = child.process;
    if (!proc?.pid) {
      return;
    }

    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    await this.signal(proc.pid, 'SIGTERM');
    const timer = setTimeout(
      () => void this.signal(proc.pid ?? 0, 'SIGKILL'),
      STOP_GRACE_MS,
    );
    // Bounded: a child that will not exit must not keep the daemon from
    // stopping. The note still has it, and the next start sweeps it.
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS * 2).unref()),
    ]);
    clearTimeout(timer);
  }

  private signal(pid: number, signal: NodeJS.Signals): Promise<void> {
    if (process.platform === 'win32') {
      // Negative pids are a Unix process-group trick; on Windows the tree is
      // taskkill /t, and /f is SIGKILL. It is awaited: returning before
      // taskkill has run let the daemon exit first, and then nothing did.
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
      // Negative pid is the process group, which detached gave the child.
      process.kill(-pid, signal);
    } catch {
      // Already gone, or never had a group; either way there is nothing to stop.
    }

    return Promise.resolve();
  }

  private childEnv(manifest: AppManifest): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...manifest.env,
      // Real environment variables beat an app's own .env, which is what makes
      // this work without touching a line of the app.
      BUSY_ADDR: this.options.proxyAddr,
      // The daemon holds the real credential. Apps still need *a* value here,
      // or busybar-kit warns every one of them about a missing Wi-Fi password.
      BUSY_HTTP_PASSWORD: manifest.env['BUSY_HTTP_PASSWORD'] ?? 'managed-by-wm',
      BUSY_TOKEN: manifest.env['BUSY_TOKEN'] ?? '',
    };
  }

  /**
   * App output, tagged, so one terminal can follow five apps — and the last few
   * lines kept, because that is where a crash explains itself.
   */
  private relay(child: Child, proc: ChildProcess): void {
    const { name } = child.manifest;
    const streams = [
      [proc.stdout, 'out'],
      [proc.stderr, 'err'],
    ] as const;
    for (const [stream, kind] of streams) {
      if (!stream) {
        continue;
      }
      createInterface({ input: stream }).on('line', (line) => {
        if (!line.trim()) {
          return;
        }
        if (this.logger.app) {
          this.logger.app(name, line, kind);
        } else {
          this.logger.info(`[${name}] ${line}`);
        }
        child.output.push(line);
        if (child.output.length > OUTPUT_LINES) {
          child.output.shift();
        }
      });
    }
  }
}

function exitMessage(child: Child): string {
  const exit = child.exit;
  if (!exit) {
    return 'Stopped';
  }
  if (exit.signal) {
    return `Stopped by ${exit.signal}`;
  }

  return exit.code === 0
    ? 'Exited on its own'
    : `Crashed with exit code ${exit.code ?? '?'}`;
}

function spawnChild(
  command: string,
  args: string[],
  extra: { cwd?: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  // Annotated rather than `as const`: a readonly tuple is not a `StdioOptions`,
  // and the mismatch made every `spawn` overload below fail to resolve.
  const stdio: StdioOptions = ['ignore', 'pipe', 'pipe'];
  const common = { ...extra, stdio, windowsHide: true };

  if (process.platform !== 'win32') {
    // `npm start` is a shell that execs node; signalling the group is the
    // only way the app itself hears about the shutdown.
    return spawn(command, args, { ...common, detached: true });
  }

  // CVE-2024-27980: .cmd/.bat cannot be spawned without a shell (EINVAL).
  // Detached + piped stdio is also EINVAL on Windows, so the tree is killed
  // with taskkill instead of a process group.
  if (needsWindowsShell(command)) {
    return spawn(joinWindowsCommand(command, args), { ...common, shell: true });
  }

  return spawn(command, args, common);
}

function needsWindowsShell(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command) || /^(npm|npx|yarn|pnpm)$/i.test(command);
}

function joinWindowsCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArg).join(' ');
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
