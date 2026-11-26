// Mutable Instruments SysEx framing, shared by Ambika and Shruthi:
//
//   F0 00 21 02 00 <device> <cmd> <arg> <payload as hi/lo nibbles> <ck hi> <ck lo> F7
//
// checksum = (sum of decoded payload bytes) & 0xff. Requests have an empty
// payload but still carry the 00 00 checksum nibbles. The Ambika PEEK reply
// (cmd 0x0f) carries the 2 address bytes at the front of the payload, which
// are part of the checksum like any other payload byte.

export const MI_MANUFACTURER = [0x00, 0x21, 0x02] as const;
export const MI_PRODUCT_FAMILY = 0x00;

export const DEVICE_SHRUTHI = 0x02;
export const DEVICE_AMBIKA = 0x04;

/** Bytes before the nibble-encoded payload: F0, manufacturer, family, device, cmd, arg. */
export const HEADER_LENGTH = 1 + MI_MANUFACTURER.length + 1 + 1 + 2;

export interface SysExFrame {
  device: number;
  command: number;
  argument: number;
  payload: Uint8Array;
}

export class SysExError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SysExError';
  }
}

export function checksum(payload: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) & 0xff;
  return sum;
}

/** Number of wire bytes for a frame with `payloadLength` decoded bytes. */
export function frameLength(payloadLength: number): number {
  return HEADER_LENGTH + 2 * payloadLength + 2 + 1;
}

/** Builds a complete SysEx message, F0 … F7 included. */
export function encodeSysEx(
  device: number,
  command: number,
  argument = 0,
  payload: ArrayLike<number> = [],
): Uint8Array {
  const out = new Uint8Array(frameLength(payload.length));
  let i = 0;
  out[i++] = 0xf0;
  for (const b of MI_MANUFACTURER) out[i++] = b;
  out[i++] = MI_PRODUCT_FAMILY;
  out[i++] = device & 0x7f;
  out[i++] = command & 0x7f;
  out[i++] = argument & 0x7f;
  for (let k = 0; k < payload.length; k++) {
    const byte = payload[k] & 0xff;
    out[i++] = byte >> 4;
    out[i++] = byte & 0x0f;
  }
  const ck = checksum(payload);
  out[i++] = ck >> 4;
  out[i++] = ck & 0x0f;
  out[i++] = 0xf7;
  return out;
}

/** True if `msg` starts like an MI SysEx message (F0 00 21 02 00). */
export function isMutableSysEx(msg: ArrayLike<number>): boolean {
  if (msg.length < 5 || msg[0] !== 0xf0) return false;
  return (
    msg[1] === MI_MANUFACTURER[0] &&
    msg[2] === MI_MANUFACTURER[1] &&
    msg[3] === MI_MANUFACTURER[2] &&
    msg[4] === MI_PRODUCT_FAMILY
  );
}

/**
 * Parses one complete SysEx message (F0 … F7). Throws SysExError on a foreign
 * header, malformed nibbles or a bad checksum.
 */
export function decodeSysEx(msg: ArrayLike<number>): SysExFrame {
  if (!isMutableSysEx(msg)) throw new SysExError('not a Mutable Instruments SysEx message');
  if (msg[msg.length - 1] !== 0xf7) throw new SysExError('missing F7');
  if (msg.length < HEADER_LENGTH + 3) throw new SysExError('message too short');
  const device = msg[5];
  const command = msg[6];
  const argument = msg[7];
  const nibbleCount = msg.length - HEADER_LENGTH - 1;
  if (nibbleCount % 2) throw new SysExError('odd number of nibbles');
  const raw = new Uint8Array(nibbleCount / 2);
  for (let k = 0; k < raw.length; k++) {
    const hi = msg[HEADER_LENGTH + 2 * k];
    const lo = msg[HEADER_LENGTH + 2 * k + 1];
    if (hi > 0x0f || lo > 0x0f) throw new SysExError(`invalid nibble at byte ${k}`);
    raw[k] = (hi << 4) | lo;
  }
  const payload = raw.subarray(0, raw.length - 1);
  const expected = raw[raw.length - 1];
  if (checksum(payload) !== expected) throw new SysExError('bad checksum');
  return { device, command, argument, payload: payload.slice() };
}

/**
 * Splits a byte stream (e.g. a .syx file holding several dumps) into complete
 * SysEx messages. Bytes outside F0 … F7 are skipped, realtime bytes (F8–FF)
 * inside a message are dropped, and a message interrupted by another status
 * byte is discarded.
 */
export function splitSysEx(bytes: ArrayLike<number>): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let current: number[] | null = null;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xf0) {
      current = [b];
    } else if (b === 0xf7) {
      if (current) {
        current.push(b);
        messages.push(Uint8Array.from(current));
      }
      current = null;
    } else if (b >= 0xf8) {
      // System realtime may legally appear anywhere; ignore it.
    } else if (b & 0x80) {
      current = null; // Interrupted message.
    } else if (current) {
      current.push(b);
    }
  }
  return messages;
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
