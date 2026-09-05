import { eachField, Reader } from './protobuf.js';

/**
 * The Bar's physical controls, over its status socket.
 *
 * `ws://<bar>/api/status/ws` streams `BSB_State.State` frames; input events are
 * one of the fifteen things a `StateUpdate` can carry. busy-lib's own reader for
 * this runs in a browser Worker, so this opens the socket itself — Node has had
 * a WebSocket since 22, and the walk to the events is short enough to hand-roll.
 */
export const WS_PATH = '/api/status/ws';

/** Field numbers, from the schema busy-lib ships. */
const STATE_UPDATES = 2;
const UPDATE_INPUT = 11;
const INPUT_BUTTON = 1;
const INPUT_SWITCH = 2;
const INPUT_ENCODER = 3;
const BUTTON_WHICH = 1;
const BUTTON_ACTION = 2;
const ENCODER_DELTA = 1;
const SWITCH_POSITION = 1;

const BUTTONS = ['ok', 'back', 'start'] as const;
const ACTIONS = ['press', 'release'] as const;
const SWITCH_POSITIONS = ['busy', 'custom', 'off', 'apps', 'settings'] as const;

export type BarButton = (typeof BUTTONS)[number];
export type ButtonAction = (typeof ACTIONS)[number];
export type SwitchPosition = (typeof SWITCH_POSITIONS)[number];

export type InputEvent =
  | { kind: 'button'; button: BarButton; action: ButtonAction }
  | { kind: 'encoder'; delta: number }
  | { kind: 'switch'; position: SwitchPosition };

export type BarInputOptions = {
  addr: string;
  /** HTTP Access password (Wi-Fi) or cloud token; both travel the same way. */
  credential?: string;
  isCloud?: boolean;
  onEvent: (event: InputEvent) => void;
  onWarning?: (message: string) => void;
};

const RECONNECT_MS = 2000;

export class BarInput {
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: BarInputOptions) {}

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (!this.running) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch (error) {
      this.retry(`input socket: ${message(error)}`);

      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      // The device stays silent until streaming is switched on; the credential
      // goes in the URL as well, but a cloud socket wants it as a message too.
      socket.send(JSON.stringify({ enable: true }));
      if (this.options.credential) {
        socket.send(JSON.stringify({ token: this.options.credential }));
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      void this.handle(event.data).catch((error: unknown) => {
        this.options.onWarning?.(`input frame: ${message(error)}`);
      });
    };

    socket.onerror = () => {
      // `onclose` always follows, and carries the reason worth reporting.
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) {
        this.socket = null;
        this.retry(
          event.reason
            ? `input socket closed: ${event.reason}`
            : 'input socket closed, reconnecting',
        );
      }
    };
  }

  private async handle(data: unknown): Promise<void> {
    const bytes = await toBytes(data);
    if (!bytes) {
      return;
    }

    for (const event of decodeInputEvents(bytes)) {
      this.options.onEvent(event);
    }
  }

  private retry(warning: string): void {
    if (!this.running || this.timer) {
      return;
    }
    this.options.onWarning?.(warning);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private url(): string {
    const base = /^[a-z]+:\/\//i.test(this.options.addr)
      ? this.options.addr
      : `http://${this.options.addr}`;
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.pathname === '/' || !url.pathname) {
      url.pathname = WS_PATH;
    }
    if (this.options.credential) {
      url.searchParams.set('x-api-token', this.options.credential);
    }

    return url.toString();
  }
}

/** Every input event in one `BSB_State.State` frame. */
export function decodeInputEvents(frame: Uint8Array): InputEvent[] {
  const events: InputEvent[] = [];

  eachField(frame, (field, wire, reader) => {
    if (field !== STATE_UPDATES || wire !== 2) {
      return;
    }
    const update = reader.bytes_();

    eachField(update, (updateField, updateWire, updateReader) => {
      if (updateField !== UPDATE_INPUT || updateWire !== 2) {
        return;
      }
      const event = decodeInputEvent(updateReader.bytes_());
      if (event) {
        events.push(event);
      }

      return true;
    });

    return true;
  });

  return events;
}

function decodeInputEvent(bytes: Uint8Array): InputEvent | null {
  let event: InputEvent | null = null;

  eachField(bytes, (field, wire, reader) => {
    if (wire !== 2) {
      return;
    }

    if (field === INPUT_BUTTON) {
      event = decodeButton(reader.bytes_());

      return true;
    }

    if (field === INPUT_ENCODER) {
      event = decodeEncoder(reader.bytes_());

      return true;
    }

    if (field === INPUT_SWITCH) {
      event = decodeSwitch(reader.bytes_());

      return true;
    }
  });

  return event;
}

function decodeButton(bytes: Uint8Array): InputEvent | null {
  // Proto3 leaves a zero-valued field off the wire entirely, so the defaults
  // here are the enums' zeroes: OK, and PRESS.
  let button: BarButton = 'ok';
  let action: ButtonAction = 'press';

  eachField(bytes, (field, wire, reader) => {
    if (wire !== 0) {
      return;
    }

    if (field === BUTTON_WHICH) {
      button = BUTTONS[reader.varint()] ?? button;

      return true;
    }

    if (field === BUTTON_ACTION) {
      action = ACTIONS[reader.varint()] ?? action;

      return true;
    }
  });

  return { kind: 'button', button, action };
}

function decodeEncoder(bytes: Uint8Array): InputEvent | null {
  let delta = 0;

  eachField(bytes, (field, wire, reader) => {
    if (field === ENCODER_DELTA && wire === 0) {
      // sint32: signed, so zigzagged rather than two's complement.
      delta = reader.zigzag();

      return true;
    }
  });

  return delta === 0 ? null : { kind: 'encoder', delta };
}

function decodeSwitch(bytes: Uint8Array): InputEvent | null {
  let position: SwitchPosition = 'busy';

  eachField(bytes, (field, wire, reader) => {
    if (field === SWITCH_POSITION && wire === 0) {
      position = SWITCH_POSITIONS[reader.varint()] ?? position;

      return true;
    }
  });

  return { kind: 'switch', position };
}

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  // Text frames are the device's own JSON acknowledgements, not state.
  return null;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export { Reader };
