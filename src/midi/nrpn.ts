// NRPN as the Ambika (YAM) firmware speaks it.
//
// Address 0–255 (= raw byte offset into Patch + PartData):
//   CC99 (NRPN MSB) = address bit 7 (0/1)
//   CC98 (NRPN LSB) = address & 0x7f       — latches the address, resets the MSB latch
// Value 0–255 (two's complement for signed params):
//   CC6  (Data MSB) = value bit 7 (0/1)
//   CC38 (Data LSB) = value & 0x7f         — commits the write
//
// Order matters on the receiving side: CC98 must follow CC99 and CC6 must
// precede CC38. CC96/97 (data increment/decrement) step the latched address.

export const CC_DATA_MSB = 6;
export const CC_DATA_LSB = 38;
export const CC_DATA_INCREMENT = 96;
export const CC_DATA_DECREMENT = 97;
export const CC_NRPN_LSB = 98;
export const CC_NRPN_MSB = 99;

/** The firmware re-sends the address at least every 32 values. */
export const ADDRESS_REFRESH_INTERVAL = 32;

function cc(channel: number, controller: number, value: number): number[] {
  return [0xb0 | (channel & 0x0f), controller & 0x7f, value & 0x7f];
}

/** Encodes one NRPN write as 2 or 4 control changes, concatenated. */
export function encodeNrpn(
  channel: number,
  address: number,
  value: number,
  includeAddress = true,
): Uint8Array {
  const a = address & 0xff;
  const v = value & 0xff;
  const bytes: number[] = [];
  if (includeAddress) {
    bytes.push(...cc(channel, CC_NRPN_MSB, a >> 7), ...cc(channel, CC_NRPN_LSB, a & 0x7f));
  }
  bytes.push(...cc(channel, CC_DATA_MSB, v >> 7), ...cc(channel, CC_DATA_LSB, v & 0x7f));
  return Uint8Array.from(bytes);
}

/**
 * Encoder with a running-address cache per channel, mirroring the firmware's
 * own output compression: the address goes out only when it changes, or after
 * 32 consecutive values to the same address (so a receiver that missed the
 * address recovers).
 */
export class NrpnEncoder {
  private readonly lastAddress = new Map<number, number>();
  private readonly counter = new Map<number, number>();

  encode(channel: number, address: number, value: number): Uint8Array {
    const ch = channel & 0x0f;
    const count = (this.counter.get(ch) ?? 0) + 1;
    const sendAddress = this.lastAddress.get(ch) !== address || count >= ADDRESS_REFRESH_INTERVAL;
    if (sendAddress) {
      this.lastAddress.set(ch, address);
      this.counter.set(ch, 0);
    } else {
      this.counter.set(ch, count);
    }
    return encodeNrpn(ch, address, value, sendAddress);
  }

  /** Forget the cached addresses (new port, reconnect, unknown receiver state). */
  invalidate(channel?: number): void {
    if (channel === undefined) {
      this.lastAddress.clear();
      this.counter.clear();
    } else {
      this.lastAddress.delete(channel & 0x0f);
      this.counter.delete(channel & 0x0f);
    }
  }
}

export type NrpnEvent =
  | { kind: 'set'; channel: number; address: number; value: number }
  | { kind: 'step'; channel: number; address: number; delta: 1 | -1 };

interface ChannelState {
  addressMsb: number;
  address: number | null;
  dataMsb: number;
}

export interface NrpnDecoderOptions {
  /**
   * One address latch for all channels instead of one per channel. The
   * Ambika's sender (`MidiDispatcher::OnEdit`) keeps a single running address
   * for every channel: after an edit of address A on part 1, an edit of A on
   * part 2 goes out on part 2's channel *without* CC99/98. Decoding the
   * Ambika's output therefore needs a shared latch.
   */
  sharedAddress?: boolean;
}

/**
 * Decoder that mirrors `Part::ControlChange` in the firmware, so it accepts
 * exactly what the Ambika sends out (`MidiDispatcher::OnEdit`), including
 * value-only messages that rely on the running address.
 */
export class NrpnDecoder {
  private readonly channels = new Map<number, ChannelState>();
  private readonly shared: boolean;

  constructor(options: NrpnDecoderOptions = {}) {
    this.shared = options.sharedAddress ?? false;
  }

  private state(channel: number): ChannelState {
    const key = this.shared ? 0 : channel;
    let s = this.channels.get(key);
    if (!s) {
      s = { addressMsb: 0, address: null, dataMsb: 0 };
      this.channels.set(key, s);
    }
    return s;
  }

  /**
   * Feeds one control change. Returns an event when the CC completes an NRPN
   * write (CC38) or step (CC96/97); null otherwise, including for unrelated CCs.
   */
  controlChange(channel: number, controller: number, value: number): NrpnEvent | null {
    const ch = channel & 0x0f;
    switch (controller) {
      case CC_NRPN_MSB: {
        const s = this.state(ch);
        s.addressMsb = value ? 0x80 : 0;
        s.dataMsb = 0;
        return null;
      }
      case CC_NRPN_LSB: {
        const s = this.state(ch);
        s.address = (value & 0x7f) | s.addressMsb;
        s.addressMsb = 0;
        s.dataMsb = 0;
        return null;
      }
      case CC_DATA_MSB: {
        this.state(ch).dataMsb = value ? 0x80 : 0;
        return null;
      }
      case CC_DATA_LSB: {
        const s = this.state(ch);
        if (s.address === null) return null;
        return { kind: 'set', channel: ch, address: s.address, value: (value & 0x7f) | s.dataMsb };
      }
      case CC_DATA_INCREMENT:
      case CC_DATA_DECREMENT: {
        const s = this.state(ch);
        if (s.address === null) return null;
        return {
          kind: 'step',
          channel: ch,
          address: s.address,
          delta: controller === CC_DATA_INCREMENT ? 1 : -1,
        };
      }
      default:
        return null;
    }
  }

  /** Feeds a raw MIDI message; non-CC messages are ignored. */
  message(data: ArrayLike<number>): NrpnEvent | null {
    if (data.length < 3 || (data[0] & 0xf0) !== 0xb0) return null;
    return this.controlChange(data[0] & 0x0f, data[1], data[2]);
  }

  reset(): void {
    this.channels.clear();
  }
}
