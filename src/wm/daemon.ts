import { mountDeck, type Mounted } from 'busybar-deck';
import { errorMessage, isForbidden } from 'busybar-kit/errors';
import { BarInput, type InputEvent } from '../bar/input.js';
import { Upstream } from '../bar/upstream.js';
import type { Config } from '../config.js';
import type { AppManifest, WmManifest } from '../manifest.js';
import { ProxyServer } from '../proxy/server.js';
import { Compositor, type Logger } from './compositor.js';
import { Registry } from './registry.js';
import { Supervisor, type AppHealth } from './supervisor.js';

export type DaemonDeps = {
  config: Config;
  manifest: WmManifest;
  /**
   * Reads the manifest again, for an app added while the daemon runs. Left
   * out, the daemon only ever runs the apps it started with.
   */
  reloadManifest?: () => WmManifest;
  logger?: Logger;
};

const CONNECT_RETRY_MS = 2000;

/**
 * The whole window manager, wired together.
 *
 * Four parts, each of which only knows the one next to it: the proxy learns who
 * wants the screen, the registry remembers it, the arbiter decides, and the
 * supervisor keeps the processes it decides between alive.
 */
export class Daemon {
  private readonly registry: Registry;
  private readonly upstream: Upstream;
  private readonly compositor: Compositor;
  private readonly proxy: ProxyServer;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;
  private deck: Mounted | null = null;
  private input: BarInput | null = null;
  private running = false;
  /** The manifest as it stands now, including apps added since startup. */
  private readonly apps: AppManifest[];

  constructor(private readonly deps: DaemonDeps) {
    const { config, manifest } = deps;
    this.logger = deps.logger ?? console;
    this.apps = [...manifest.apps];

    this.upstream = new Upstream({
      addr: config.bar.busyAddr,
      timeoutMs: config.requestTimeoutMs,
      ...(config.bar.busyToken ? { token: config.bar.busyToken } : {}),
      ...(config.bar.busyHttpPassword
        ? { httpPassword: config.bar.busyHttpPassword }
        : {}),
    });

    this.registry = new Registry(manifest.apps, {
      staleMs: config.staleMs,
      onChange: () => this.compositor.wake(),
    });

    this.compositor = new Compositor(this.registry, this.upstream, {
      minHoldMs: config.minHoldMs,
      pinTimeoutMs: config.pinTimeoutMs,
      tickMs: config.tickMs,
      logger: this.logger,
    });

    this.proxy = new ProxyServer({
      host: config.host,
      port: config.port,
      upstream: this.upstream,
      registry: this.registry,
      logger: this.logger,
      deck: (req, res) => this.deck?.handle(req, res) ?? Promise.resolve(false),
    });

    this.supervisor = new Supervisor(manifest.apps, {
      proxyAddr: `http://${config.host}:${config.port}`,
      registry: this.registry,
      restartDelayMs: config.restartDelayMs,
      // Beside the manifest, so each profile keeps its own note of what it
      // started — and a second profile does not adopt the first one's strays.
      stateDir: config.profile ?? process.cwd(),
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.deps.config.profile) {
      this.deck = mountDeck({
        profileDir: this.deps.config.profile,
        host: this.deps.config.host,
        ...(process.env['WM_API_TOKEN'] ? { token: process.env['WM_API_TOKEN'] } : {}),
        manifestApps: () =>
          this.apps.map((app) => ({
            name: app.name,
            rank: app.rank,
            autostart: app.autostart,
            ...(app.command ? { command: app.command } : {}),
          })),
        // Mounted here, the deck has the answers only this process holds; run
        // on its own it reports that it does not, rather than guessing.
        live: {
          status: { connected: true },
          state: {
            running: (name: string) => this.registry.get(name)?.running ?? false,
            onScreen: () => this.compositor.showing,
            pin: () => this.compositor.pin,
            restart: (name: string) => this.supervisor.restart(name),
            setPin: (name: string) => this.compositor.pinApp(name),
            clearPin: () => this.compositor.unpin(),
            // The deck has no credentials of its own, and a browser cannot put
            // headers on an `<img>` — so the frame is fetched here, where the
            // one connection to the hardware already lives.
            screen: (display: 0 | 1) => this.upstream.screen(display),
            health: (name: string) => this.health(name),
            addApp: (name: string) => this.addApp(name),
            stop: (name: string) => this.supervisor.stopApp(name),
            removeApp: (name: string) => this.removeApp(name),
            setRanks: (ranks: Record<string, number>) => this.setRanks(ranks),
          },
        },
      });
      this.logger.info(
        `[wm] deck at http://${this.deps.config.host}:${this.deps.config.port}/deck/`,
      );
    }

    await this.proxy.listen();
    this.logger.info(
      `[wm] proxying ${this.deps.config.bar.busyAddr} on http://${this.deps.config.host}:${this.proxy.port}`,
    );

    await this.connect();
    if (!this.running) {
      return;
    }

    await this.sweep();

    this.compositor.start();
    await this.supervisor.start();
    this.attachInput();
  }

  /**
   * Everything the API has ever drawn, wiped once before we start arbitrating.
   *
   * Elements persist on the device by id, under the name of whoever drew them,
   * and a clear only ever names one app. So an app that died without cleaning
   * up, or one from a previous run of this daemon, leaves its elements behind
   * for as long as the Bar stays up — and they pile up until a draw comes back
   * `508 Resource Limit Reached`. Nothing of ours is legitimately on screen at
   * this moment, which is what makes the unnamed clear safe here and nowhere
   * else. It touches only what the API drew, not the Bar's own apps.
   */
  private async sweep(): Promise<void> {
    try {
      await this.upstream.clear();
      this.logger.info('[wm] display swept — anything left over from before is gone');
    } catch (error) {
      this.logger.warn(`[wm] could not sweep the display: ${errorMessage(error)}`);
    }
  }

  /**
   * Why an app is where it is. The supervisor answers for what it runs; an app
   * the manifest lists but nothing can start gets its reason from here.
   */
  health(name: string): AppHealth | null {
    const known = this.supervisor.health(name);
    if (known) {
      return known;
    }
    if (!this.apps.some((app) => app.name === name)) {
      return null;
    }

    return {
      state: 'unmanaged',
      message: this.deps.config.profile
        ? `busybar-${name} is not installed in this profile, and the manifest names no command, so there is nothing to start`
        : 'The manifest names no command for it, so the window manager does not start it',
      output: [],
    };
  }

  /**
   * Takes on an app that was just written into the manifest, without a
   * restart. Everything else keeps running; only the newcomer starts.
   */
  addApp(name: string): void {
    const reload = this.deps.reloadManifest;
    if (!reload) {
      throw new Error(
        'this daemon cannot re-read its manifest; restart it to pick up the app',
      );
    }
    const manifest = reload();
    const app = manifest.apps.find((candidate) => candidate.name === name);
    if (!app) {
      throw new Error(`${name} is not in the manifest`);
    }
    if (this.apps.some((existing) => existing.name === name)) {
      return;
    }

    this.apps.push(app);
    this.registry.add(app);
    this.supervisor.add(app);
    // Ranks come from places in the list, and the list just grew: everyone
    // else's rank moves with it, or the newcomer would tie with the last app.
    this.setRanks(
      Object.fromEntries(manifest.apps.map((entry) => [entry.name, entry.rank])),
    );
    this.logger.info(`[wm] added ${name}`);
  }

  /**
   * Takes an app out: stops it, forgets it, and lets go of the screen if it
   * was holding it. Its folder and settings are not this process's to touch.
   */
  async removeApp(name: string): Promise<void> {
    await this.supervisor.remove(name);
    const at = this.apps.findIndex((app) => app.name === name);
    if (at !== -1) {
      this.apps.splice(at, 1);
    }
    if (this.compositor.pin === name) {
      this.compositor.unpin();
    }
    this.registry.remove(name);
    this.logger.info(`[wm] removed ${name}`);
  }

  /** New ranks, applied at once: the very next decision already uses them. */
  setRanks(ranks: Record<string, number>): void {
    for (const app of this.apps) {
      const rank = ranks[app.name];
      if (typeof rank === 'number' && Number.isFinite(rank)) {
        app.rank = rank;
        this.registry.setRank(app.name, rank);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.input?.stop();
    await this.supervisor.stop();
    await this.compositor.stop();
    await this.proxy.close();
  }

  private async connect(): Promise<void> {
    while (this.running) {
      try {
        await this.upstream.ping();
        this.logger.info(`[wm] BUSY Bar connected (${this.deps.config.bar.busyAddr})`);

        return;
      } catch (error) {
        const hint =
          isForbidden(error) && !this.deps.config.bar.isCloud
            ? ' — set BUSY_HTTP_PASSWORD to the HTTP Access password'
            : '';
        this.logger.warn(
          `[wm] waiting for BUSY Bar at ${this.deps.config.bar.busyAddr}: ${errorMessage(error)}${hint}`,
        );
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    }
  }

  private attachInput(): void {
    if (!this.deps.config.input) {
      return;
    }

    const credential =
      this.deps.config.bar.busyToken || this.deps.config.bar.busyHttpPassword;
    this.input = new BarInput({
      addr: this.deps.config.bar.busyAddr,
      ...(credential ? { credential } : {}),
      onEvent: (event) => this.onInput(event),
      onWarning: (warning) => this.logger.warn(`[wm] ${warning}`),
    });
    this.input.start();
  }

  private onInput(event: InputEvent): void {
    if (event.kind === 'encoder') {
      if (this.deps.config.knob) {
        this.compositor.cycle(event.delta);
      }

      return;
    }

    if (event.kind !== 'button' || event.action !== 'press') {
      return;
    }

    if (event.button === 'ok') {
      this.compositor.cycle(1);
    } else if (event.button === 'back') {
      this.compositor.unpin();
    }
  }
}
