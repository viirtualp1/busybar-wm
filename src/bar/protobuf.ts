/**
 * Just enough protobuf to read one message off the Bar's status socket.
 *
 * The device streams `BSB_State.State` frames, and busy-lib decodes them with a
 * bundled protobufjs — inside a browser Worker, which is why none of it runs
 * here. All this app wants out of a frame is the input events, so it walks the
 * three fields on the way to them and skips everything else.
 */
export class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  /** Field number and wire type of the next field. */
  tag(): { field: number; wire: number } {
    const key = this.varint();

    return { field: key >>> 3, wire: key & 7 };
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset] ?? 0;
      this.offset += 1;
      // Numbers stay safe integers here: these are enums, small deltas and
      // lengths, never the 64-bit timestamp, which is skipped as fixed64.
      result += shift < 28 ? (byte & 0x7f) << shift : (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return result;
  }

  /** Signed varint, as protobuf's `sint32` writes it. */
  zigzag(): number {
    const value = this.varint();

    return (value >>> 1) ^ -(value & 1);
  }

  bytes_(): Uint8Array {
    const length = this.varint();
    const start = this.offset;
    this.offset = Math.min(this.bytes.length, start + length);

    return this.bytes.subarray(start, this.offset);
  }

  /** Steps over a field this app does not care about. */
  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
    } else if (wire === 1) {
      this.offset += 8;
    } else if (wire === 2) {
      this.bytes_();
    } else if (wire === 5) {
      this.offset += 4;
    } else {
      // Groups (3, 4) are not in this schema; treating one as the end of the
      // message beats looping forever on a byte we cannot measure.
      this.offset = this.bytes.length;
    }
  }
}

/** Runs `visit` over every field of a message. */
export function eachField(
  bytes: Uint8Array,
  visit: (field: number, wire: number, reader: Reader) => boolean | void,
): void {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (visit(field, wire, reader) !== true) {
      reader.skip(wire);
    }
  }
}
