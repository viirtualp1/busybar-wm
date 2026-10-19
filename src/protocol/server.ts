import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { InputEvent } from '../bar/input.js';
import { BACK, FRONT } from 'busybar-kit/device';
import { errorMessage } from 'busybar-kit/errors';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { LEGACY_SURFACE } from '../proxy/legacy.js';
import { MAX_ELEMENTS } from '../wm/canvas.js';
import type { Logger } from '../wm/compositor.js';
import { DEFAULT_PRIORITY, type Scene } from '../wm/scene.js';
import {
  DISPLAY_PATH,
  PROTOCOL,
  ProtocolError,
  parseClientMessage,
  type ClientMessage,
  type DisplayId,
  type ErrorCode,
  type InputKey,
  type ServerMessage,
} from './messages.js';
import type { Tokens } from './tokens.js';

export type DisplayServerOptions = {
  scene: Scene;
  tokens: Tokens;
  /** The shortest gap between two `frame` callbacks to one surface. */
  frameMs: number;
  /** Keys the window manager keeps for itself on top of BACK — the knob, with `WM_KNOB=1`. */
  reservedKeys?: InputKey[];
  logger?: Logger;
};

/** A frame of a hundred elements is a few kilobytes; this is a lot of room. */
const MAX_MESSAGE = 1024 * 1024;

const SIZES: Record<DisplayId, { width: number; height: number }> = {
  front: { width: FRONT.width, height: FRONT.height },
  back: { width: BACK.width, height: BACK.height },
};

/** WebSocket close codes in the private range, one per reason a session ends. */
const CLOSE = {
  protocol: 4000,
  auth: 4001,
  replaced: 4002,
  not_ready: 4003,
  shutdown: 1001,
} as const;

/**
 * The window manager's half of the display protocol.
 *
 * An app opens a session, names itself, creates surfaces and commits frames
 * into them; the server tells it when a surface is shown or hidden, and when
 * a draw would actually be seen. Everything an app commits lands in the same
 * scene the proxy fills, so both kinds of app are arbitrated by one policy.
 *
 * The session is the app's life: when the socket closes, its surfaces go.
 */
export class DisplayServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Session>();
  private readonly logger: Logger;
  private shown: string | null = null;
  /** Each key grabbed `always`, and by whom: one app per key. */
  private readonly always = new Map<InputKey, string>();

  constructor(private readonly options: DisplayServerOptions) {
    this.logger = options.logger ?? console;
  }

  /** Whether an upgrade request is for this socket rather than the Bar's. */
  handles(req: IncomingMessage): boolean {
    return new URL(req.url ?? '/', 'http://wm.invalid').pathname === DISPLAY_PATH;
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new Session(ws, this);
      this.pending.add(session);
    });
  }

  /** The app on screen changed: every surface that is shown or hidden by it is told. */
  show(name: string | null): void {
    if (name === this.shown) {
      return;
    }
    this.shown = name;
    for (const session of this.sessions.values()) {
      session.reconfigure();
    }
  }

  async close(): Promise<void> {
    for (const session of [...this.pending, ...this.sessions.values()]) {
      session.end(CLOSE.shutdown, 'the window manager is stopping');
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** @internal */
  get scene(): Scene {
    return this.options.scene;
  }

  /** @internal */
  get frameMs(): number {
    return this.options.frameMs;
  }

  /** @internal */
  isShown(app: string): boolean {
    return this.shown === app;
  }

  /** @internal — a hello: whether this session may be `app`, and taking the name if so. */
  claim(session: Session, app: string, token: string | undefined): void {
    if (!this.options.tokens.admits(app, token)) {
      throw new ProtocolError('auth', `wrong or missing token for ${app}`);
    }
    const previous = this.sessions.get(app);
    if (previous && previous !== session) {
      // A reconnect usually: the new socket is the one that is alive.
      previous.replaced();
    }
    this.pending.delete(session);
    this.sessions.set(app, session);
    this.options.scene.connect(app);
    this.logger.info(`[wm] ${app} connected to the display socket`);
  }

  /**
   * A press that is not the window manager's, to whoever should hear it: the
   * app holding that key `always`, or else the app on screen if it asked for
   * the key. Returns who got it, if anyone.
   */
  deliver(event: InputEvent): string | null {
    const key = keyOf(event);
    if (!key) {
      return null;
    }
    const holder = this.always.get(key);
    const target = holder ?? this.shown;
    const session = target ? this.sessions.get(target) : undefined;
    if (!target || !session || (!holder && !session.wants(key))) {
      return null;
    }
    session.input(event);

    return target;
  }

  /** @internal — an `always` grab: all of the keys, or none of them. */
  grabAlways(app: string, keys: InputKey[]): void {
    for (const key of keys) {
      if (this.options.reservedKeys?.includes(key)) {
        throw new ProtocolError(
          'reserved_key',
          `${key} belongs to the window manager here`,
        );
      }
      const holder = this.always.get(key);
      if (holder && holder !== app) {
        throw new ProtocolError('grab_taken', `${key} is held by ${holder}`);
      }
    }
    for (const key of keys) {
      this.always.set(key, app);
    }
  }

  /** @internal */
  releaseAlways(app: string, keys: Iterable<InputKey>): void {
    for (const key of keys) {
      if (this.always.get(key) === app) {
        this.always.delete(key);
      }
    }
  }

  /** @internal */
  closed(session: Session, app: string | null, surfaces: string[]): void {
    this.pending.delete(session);
    if (!app || this.sessions.get(app) !== session) {
      return;
    }
    this.releaseAlways(app, [...this.always.keys()]);
    this.sessions.delete(app);
    this.options.scene.disconnect(app, surfaces);
    this.logger.info(`[wm] ${app} left the display socket`);
  }

  /** @internal */
  warn(message: string): void {
    this.logger.warn(message);
  }
}

type Surface = {
  name: string;
  display: DisplayId;
  serial: number;
  visible: boolean;
  /** A `frame` was sent and not yet answered with a commit. */
  waiting: boolean;
  lastFrameAt: number;
  timer: NodeJS.Timeout | null;
};

class Session {
  private app: string | null = null;
  private readonly surfaces = new Map<string, Surface>();
  private over = false;
  /** Keys this app wants while it is on screen. */
  private readonly focusedKeys = new Set<InputKey>();

  constructor(
    private readonly ws: WebSocket,
    private readonly server: DisplayServer,
  ) {
    ws.on('message', (data, isBinary) => this.receive(data, isBinary));
    ws.on('close', () => this.finish());
    ws.on('error', (error) => {
      this.server.warn(
        `[wm] display socket${this.app ? ` (${this.app})` : ''}: ${errorMessage(error)}`,
      );
    });
  }

  /** Another session took this app's name. */
  replaced(): void {
    const app = this.app;
    this.finish();
    this.send({
      type: 'error',
      code: 'replaced',
      message: `another session is ${app ?? 'this app'} now`,
    });
    this.ws.close(CLOSE.replaced, 'replaced');
  }

  end(code: number, reason: string): void {
    this.finish();
    this.ws.close(code, reason);
  }

  /** Whether this app asked for `key` while it is on screen. */
  wants(key: InputKey): boolean {
    return this.focusedKeys.has(key);
  }

  input(event: InputEvent): void {
    this.send({ type: 'input', event });
  }

  /** Visibility follows the app on screen; tell each surface whose changed. */
  reconfigure(): void {
    if (!this.app) {
      return;
    }
    const visible = this.server.isShown(this.app);
    for (const surface of this.surfaces.values()) {
      if (surface.visible !== visible) {
        surface.visible = visible;
        this.configure(surface);
        if (visible) {
          this.frame(surface);
        } else {
          this.stopFrames(surface);
        }
      }
    }
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.over) {
      return;
    }
    if (isBinary) {
      return this.fail('bad_message', 'messages are text');
    }

    let message: ClientMessage;
    try {
      message = parseClientMessage(rawText(data));
    } catch (error) {
      if (error instanceof ProtocolError) {
        return this.fail(error.code, error.message, surfaceOf(data));
      }
      throw error;
    }

    try {
      this.handle(message);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return this.fail(
          error.code,
          error.message,
          'surface' in message ? message.surface : undefined,
        );
      }
      throw error;
    }
  }

  private handle(message: ClientMessage): void {
    if (message.type === 'hello') {
      if (this.app) {
        throw new ProtocolError('bad_message', 'hello was already said');
      }
      if (message.protocol !== PROTOCOL) {
        throw new ProtocolError(
          'protocol',
          `this window manager speaks protocol ${PROTOCOL}`,
        );
      }
      this.server.claim(this, message.app, message.token);
      this.app = message.app;
      this.send({
        type: 'welcome',
        protocol: PROTOCOL,
        displays: [
          { id: 'front', ...SIZES.front },
          { id: 'back', ...SIZES.back },
        ],
        frameMs: this.server.frameMs,
        budget: MAX_ELEMENTS,
      });

      return;
    }

    const app = this.app;
    if (!app) {
      throw new ProtocolError('not_ready', 'say hello first');
    }
    const scene = this.server.scene;

    if (message.type === 'surface.create') {
      if (this.surfaces.has(message.surface) || message.surface === LEGACY_SURFACE) {
        throw new ProtocolError('surface_exists', `${message.surface} is taken`);
      }
      const surface: Surface = {
        name: message.surface,
        display: message.display,
        serial: 0,
        visible: this.server.isShown(app),
        waiting: false,
        lastFrameAt: 0,
        timer: null,
      };
      this.surfaces.set(surface.name, surface);
      this.configure(surface);
      if (surface.visible) {
        this.frame(surface);
      }

      return;
    }

    if (message.type === 'input.grab') {
      if (message.when === 'always') {
        this.server.grabAlways(app, message.keys);
      } else {
        for (const key of message.keys) {
          this.focusedKeys.add(key);
        }
      }

      return;
    }
    if (message.type === 'input.release') {
      for (const key of message.keys) {
        this.focusedKeys.delete(key);
      }
      this.server.releaseAlways(app, message.keys);

      return;
    }

    const surface = this.surfaces.get(message.surface);
    if (!surface) {
      throw new ProtocolError('unknown_surface', `no surface called ${message.surface}`);
    }

    switch (message.type) {
      case 'surface.commit': {
        if (message.elements.length > MAX_ELEMENTS) {
          throw new ProtocolError(
            'too_many_elements',
            `${message.elements.length} elements; the Bar holds ${MAX_ELEMENTS} in all`,
          );
        }
        if (message.elements.length === 0) {
          scene.release(app, surface.name);
        } else {
          scene.commit(app, surface.name, {
            // A surface is one panel: its elements are drawn there, whatever
            // they say.
            elements: message.elements.map((element) => ({
              ...element,
              display: surface.display,
            })),
            priority: message.priority ?? DEFAULT_PRIORITY,
            ...(message.led_notification_color
              ? { led: message.led_notification_color }
              : {}),
          });
        }
        surface.waiting = false;
        if (surface.visible && !surface.timer) {
          this.scheduleFrame(surface);
        }

        return;
      }
      case 'surface.want':
        scene.setWant(app, surface.name, message.level);

        return;
      case 'surface.destroy':
        this.stopFrames(surface);
        this.surfaces.delete(surface.name);
        scene.drop(app, surface.name);

        return;
    }
  }

  private configure(surface: Surface): void {
    surface.serial += 1;
    this.send({
      type: 'configure',
      surface: surface.name,
      serial: surface.serial,
      ...SIZES[surface.display],
      visible: surface.visible,
      focused: surface.visible,
      budget: MAX_ELEMENTS,
    });
  }

  private frame(surface: Surface): void {
    surface.timer = null;
    if (!surface.visible || this.over) {
      return;
    }
    surface.waiting = true;
    surface.lastFrameAt = Date.now();
    this.send({ type: 'frame', surface: surface.name });
  }

  /** The next `frame`, no sooner than `frameMs` after the last one. */
  private scheduleFrame(surface: Surface): void {
    const wait = Math.max(0, surface.lastFrameAt + this.server.frameMs - Date.now());
    surface.timer = setTimeout(() => this.frame(surface), wait);
    surface.timer.unref();
  }

  private stopFrames(surface: Surface): void {
    if (surface.timer) {
      clearTimeout(surface.timer);
      surface.timer = null;
    }
    surface.waiting = false;
  }

  private fail(code: ErrorCode, message: string, surface?: string): void {
    this.send({ type: 'error', code, message, ...(surface ? { surface } : {}) });
    // Errors about a surface are the app's to recover from; errors about the
    // session itself end it.
    if (code === 'protocol' || code === 'auth' || code === 'not_ready') {
      this.end(CLOSE[code], message);
    }
  }

  private send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Once, however the session ended: its surfaces leave the scene. */
  private finish(): void {
    if (this.over) {
      return;
    }
    this.over = true;
    for (const surface of this.surfaces.values()) {
      this.stopFrames(surface);
    }
    this.server.closed(this, this.app, [...this.surfaces.keys()]);
  }
}

function keyOf(event: InputEvent): InputKey | null {
  if (event.kind === 'encoder') {
    return 'encoder';
  }
  if (event.kind === 'button' && (event.button === 'ok' || event.button === 'start')) {
    return event.button;
  }

  return null;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/** The surface a malformed message was about, if it said, for the error to name. */
function surfaceOf(data: RawData): string | undefined {
  try {
    const value = JSON.parse(rawText(data)) as { surface?: unknown };

    return typeof value.surface === 'string' ? value.surface : undefined;
  } catch {
    return undefined;
  }
}
