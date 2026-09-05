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
    });

    this.supervisor = new Supervisor(manifest.apps, {
      proxyAddr: `http://${config.host}:${config.port}`,
      registry: this.registry,
      restartDelayMs: config.restartDelayMs,
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    this.running = true;

    await this.proxy.listen();
    this.logger.info(
      `[wm] proxying ${this.deps.config.bar.busyAddr} on http://${this.deps.config.host}:${this.proxy.port}`,
    );

    await this.connect();
    if (!this.running) {
      return;
    }

    this.compositor.start();
    this.supervisor.start();
    this.attachInput();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.input?.stop();
    // Apps first: one of them drawing into a half-torn-down proxy is noise in
    // the log at best.
    await this.supervisor.stop();
    await this.compositor.stop();
    await this.proxy.close();
  }

  /** Nothing is worth starting until the Bar answers. */
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

  /**
   * OK steps through the apps that have something to show, BACK gives the
   * choice back to the policy. The knob is left alone by default: apps bind it
   * themselves — busybar-nowplaying makes it the system volume — and taking it
   * away at this level would break them.
   */
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
