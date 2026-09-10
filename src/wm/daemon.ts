import { mountDeck, type Mounted } from 'busybar-deck';
import { errorMessage, isForbidden } from 'busybar-kit/errors';
import { BarInput, type InputEvent } from '../bar/input.js';
import { Upstream } from '../bar/upstream.js';
import type { Config } from '../config.js';
import type { WmManifest } from '../manifest.js';
import { ProxyServer } from '../proxy/server.js';
import { Compositor, type Logger } from './compositor.js';
import { Registry } from './registry.js';
import { Supervisor } from './supervisor.js';

export type DaemonDeps = {
  config: Config;
  manifest: WmManifest;
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

  constructor(private readonly deps: DaemonDeps) {
    const { config, manifest } = deps;
    this.logger = deps.logger ?? console;

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
        manifestApps: this.deps.manifest.apps.map((app) => ({
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
    this.supervisor.start();
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
