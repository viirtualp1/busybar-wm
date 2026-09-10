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

type Child = {
  manifest: AppManifest;
  process: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  failures: number;
};

const MAX_BACKOFF = 8;
const STOP_GRACE_MS = 3000;

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
      if (manifest.command) {
        this.children.set(manifest.name, {
          manifest,
          process: null,
          timer: null,
          failures: 0,
        });
      }
    }
  }

  start(): void {
    this.running = true;
    // Anything a previous daemon left running still holds its ports and still
    // draws; starting a second copy on top of it is how 3080 ends up taken.
    for (const stray of this.strays.sweep()) {
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
    this.strays.clear();
  }

  /** Kill and start again — used by the /wm config API after a settings change. */
  async restart(name: string): Promise<void> {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`no supervised app named ${name}`);
    }
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

  private spawn(child: Child): void {
    const { manifest } = child;
    if (!manifest.command || child.process) {
      return;
    }

    let proc: ChildProcess;
    try {
      proc = spawnChild(manifest.command, manifest.args, {
        ...(manifest.cwd ? { cwd: manifest.cwd } : {}),
        env: this.childEnv(manifest),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[${manifest.name}] failed to start: ${message}`);
      this.scheduleRestart(child, false);
      return;
    }

    child.process = proc;
    this.options.registry.setRunning(manifest.name, true);
    this.logger.info(`[wm] started ${manifest.name} (pid ${proc.pid ?? '?'})`);
    if (proc.pid) {
      this.strays.remember(proc.pid, manifest.name);
    }

    this.relay(manifest.name, proc);

    proc.on('error', (error) => {
      this.logger.warn(`[${manifest.name}] failed to start: ${error.message}`);
    });

    proc.on('exit', (code, signal) => {
      child.process = null;
      if (proc.pid) {
        this.strays.forget(proc.pid);
      }
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
      this.skipAutoRestart.has(child.manifest.name)
    ) {
      return;
    }

    // A clean exit is the app saying it is done, not a fault; retrying that
    // immediately is how you get a fork bomb with a nice log.
    child.failures = clean ? 1 : Math.min(child.failures + 1, MAX_BACKOFF);
    const delay = this.options.restartDelayMs * 2 ** (child.failures - 1);
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
    this.signal(proc.pid, 'SIGTERM');
    const timer = setTimeout(() => this.signal(proc.pid ?? 0, 'SIGKILL'), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      if (process.platform === 'win32') {
        // Negative pids are a Unix process-group trick; on Windows the tree
        // is `taskkill /t`. `/f` is SIGKILL. Without it, console apps often
        // ignore the request and the grace period expires into a force-kill.
        const args = ['/pid', String(pid), '/t', '/f'];
        spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
        return;
      }
      // Negative pid is the process group, which `detached` gave the child.
      process.kill(-pid, signal);
    } catch {
      // Already gone, or never had a group; either way there is nothing to stop.
    }
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

  /** App output, tagged, so one terminal can follow five apps. */
  private relay(name: string, proc: ChildProcess): void {
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) {
        continue;
      }
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim()) {
          this.logger.info(`[${name}] ${line}`);
        }
      });
    }
  }
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
